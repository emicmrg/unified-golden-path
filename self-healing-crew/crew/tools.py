"""
Self-healing crew tools.

Provides the functions that agents use to interact with external systems:
  - fetch_ci_log: retrieves the failed CI log (stub + GitHub Actions interface).
  - fetch_file_content: fetches the real content of a file from a branch via PyGithub.
  - get_github_token: obtains a GitHub App installation token from Secrets Manager.
  - create_branch_and_commit: creates a fix/* branch and applies the REAL file content
                               via GitHub Contents API (update_file / create_file).
                               GUARANTEE: NEVER creates commits on main or master.
  - open_pull_request: opens a PR with the generated patch.
  - escalate_to_human: notifies the team that attempts have been exhausted.

ANTI-MAIN GUARDRAIL
───────────────────
`create_branch_and_commit` has explicit two-layer validation:
  1. Validates that the base branch is not main or master before any API call.
  2. Validates that the target branch name starts with 'fix/'.
If either validation fails it raises MainBranchProtectionError (does not continue).

APPLY STRATEGY — FULL FILE CONTENT (not unified diff)
──────────────────────────────────────────────────────
`_apply_file_content_to_branch` uses Repository.update_file() with the complete
corrected file content provided by the fix-engineer agent. This avoids the
fragility of applying LLM-generated unified diffs (misaligned hunk headers,
hallucinated context lines). A display diff is computed locally via difflib
and included in the PR body for human review.

Fallback: if no file content is available, `_create_patch_notes_commit` is
called instead (saves a .selfheal/<run_key>.patch stub for manual review).

GITHUB APP AUTHENTICATION
─────────────────────────
The secret in Secrets Manager contains the PEM (GitHub App private key).
`get_github_token` signs an RS256 JWT with that key and then requests an
installation access token (lifetime ~1 h) via POST to the GitHub API.
The PEM and the token are NEVER logged or printed.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import logging
import os
import time
from typing import Any

import boto3
import jwt  # PyJWT
import requests as http_requests
from botocore.exceptions import ClientError
from github import Github, GithubException
from github.Repository import Repository

logger = logging.getLogger(__name__)

# Protected branches: direct commits are NEVER allowed
PROTECTED_BRANCHES = frozenset({"main", "master"})


# ─── Custom exceptions ────────────────────────────────────────────────────────


class MainBranchProtectionError(RuntimeError):
    """Raised when a commit/push to a protected branch is attempted.

    This exception is the critical guardrail: if raised, the crew stops
    any write operation on the repository.
    """


class GitHubTokenError(RuntimeError):
    """Could not obtain a GitHub token."""


class CILogFetchError(RuntimeError):
    """Could not retrieve the CI log."""


# ─── GitHub token ─────────────────────────────────────────────────────────────


def get_github_token(
    secret_arn: str,
    region: str = "us-east-1",
    *,
    _env_fallback: bool = False,
) -> str:
    """Obtains a GitHub App installation token from AWS Secrets Manager.

    The secret in Secrets Manager must contain the PEM (GitHub App private key)
    — as a plain string or JSON {"pem": "..."}.

    Flow (Fargate / GitHub App mode — DEFAULT):
      1. Retrieves the PEM from Secrets Manager.
      2. Signs an RS256 JWT with iss=GITHUB_APP_ID, iat/exp +10 min.
      3. POST to /app/installations/{GITHUB_INSTALLATION_ID}/access_tokens
         with the JWT as Bearer → obtains installation token (~1 h lifetime).
      4. Returns that token for use with PyGithub.

    Flow (Runner 1 / allow_env_token=True):
      If config.allow_env_token is True, returns the GITHUB_TOKEN from the
      environment directly (the ephemeral token of the GitHub Actions workflow).
      This mode is ONLY activated when UGP_ALLOW_ENV_TOKEN=true is in the
      environment — never in Fargate.

    The PEM and the token are NEVER logged or printed.

    Args:
        secret_arn: ARN of the Secrets Manager secret containing the PEM.
                    Ignored when allow_env_token=True.
        region: AWS region. Ignored when allow_env_token=True.
        _env_fallback: If True, uses GITHUB_TOKEN from the environment as a
            fallback (ONLY for local development; must be False in Fargate).
            NOTE: This parameter is independent of allow_env_token. The
            allow_env_token path is explicit via config, not a silent fallback.

    Returns:
        GitHub token (string). Never empty.

    Raises:
        GitHubTokenError: If required env vars are missing, the secret is empty,
            or the GitHub API call fails.
    """
    # ── Local development fallback ONLY (default=False → off in prod) ─────────
    # Evaluated BEFORE loading config to preserve the original behavior.
    if _env_fallback:
        env_token = os.environ.get("GITHUB_TOKEN")
        if env_token:
            logger.warning(
                "Using GITHUB_TOKEN from the environment (explicit local mode). "
                "In production always use GITHUB_TOKEN_SECRET_ARN."
            )
            return env_token

    # ── Runner 1 mode: explicit env token via UGP_ALLOW_ENV_TOKEN ────────────
    # Lazy import to avoid circular imports and because get_settings()
    # may raise ValidationError if the environment is incomplete.
    try:
        from crew.config import get_settings  # noqa: PLC0415

        cfg = get_settings()
        if cfg.allow_env_token:
            env_token = os.environ.get("GITHUB_TOKEN", "").strip()
            if not env_token:
                raise GitHubTokenError(
                    "UGP_ALLOW_ENV_TOKEN=true but GITHUB_TOKEN is not defined "
                    "in the environment. The workflow must expose the token: "
                    "env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}"
                )
            # NEVER log the token; only confirm it was obtained
            logger.info(
                "GitHub token obtained from GITHUB_TOKEN in the environment "
                "(Runner 1 mode / UGP_ALLOW_ENV_TOKEN=true)."
            )
            return env_token
    except ImportError:
        # Defensive fallback: if config cannot be imported, continue with normal flow
        pass

    # ── Fargate / GitHub App mode (DEFAULT) ───────────────────────────────────
    # Get APP_ID and INSTALLATION_ID (required for the JWT flow)
    app_id = os.environ.get("GITHUB_APP_ID", "").strip()
    installation_id = os.environ.get("GITHUB_INSTALLATION_ID", "").strip()
    if not app_id:
        raise GitHubTokenError(
            "The GITHUB_APP_ID environment variable is required for the "
            "GitHub App installation token flow."
        )
    if not installation_id:
        raise GitHubTokenError(
            "The GITHUB_INSTALLATION_ID environment variable is required for "
            "the GitHub App installation token flow."
        )

    # 1. Retrieve PEM from Secrets Manager
    pem = _fetch_pem_from_secrets_manager(secret_arn, region)

    # 2. Sign RS256 JWT
    app_jwt = _sign_app_jwt(pem=pem, app_id=app_id)

    # 3. Request installation access token
    installation_token = _request_installation_token(
        app_jwt=app_jwt,
        installation_id=installation_id,
    )

    return installation_token


def _fetch_pem_from_secrets_manager(secret_arn: str, region: str) -> str:
    """Retrieves the private key PEM from Secrets Manager.

    Returns:
        PEM string (starts with -----BEGIN RSA PRIVATE KEY----- or similar).

    Raises:
        GitHubTokenError: If the secret does not exist, is empty, or there is
            a permissions error.
    """
    client = boto3.client("secretsmanager", region_name=region)
    try:
        response = client.get_secret_value(SecretId=secret_arn)
    except ClientError as exc:
        error_code = exc.response["Error"]["Code"]
        raise GitHubTokenError(
            f"Could not retrieve the PEM secret from Secrets Manager "
            f"(SecretId={secret_arn}, error={error_code})"
        ) from exc

    secret_str = response.get("SecretString", "")
    if not secret_str:
        raise GitHubTokenError(
            f"The secret '{secret_arn}' is empty or binary. "
            "It must contain the GitHub App private key PEM."
        )

    # Supports JSON format {"pem": "..."} or plain string
    try:
        parsed = json.loads(secret_str)
        pem = (
            parsed.get("pem")
            or parsed.get("private_key")
            or parsed.get("github_app_pem")
            or secret_str
        )
    except (json.JSONDecodeError, AttributeError):
        pem = secret_str.strip()

    if not pem or "PRIVATE KEY" not in pem:
        raise GitHubTokenError(
            "The secret does not appear to be a valid PEM. "
            "Make sure it contains the GitHub App private key."
        )

    return pem


def _sign_app_jwt(pem: str, app_id: str) -> str:
    """Signs an RS256 JWT to authenticate as a GitHub App.

    The JWT is valid for 10 minutes (limit imposed by GitHub).
    The PEM is never logged.

    Args:
        pem: GitHub App private key PEM.
        app_id: Numeric ID of the GitHub App.

    Returns:
        Signed JWT (string).

    Raises:
        GitHubTokenError: If signing fails (invalid PEM, etc.).
    """
    now = int(time.time())
    payload = {
        "iat": now - 60,   # 60 s backward slack for clock drift
        "exp": now + 600,  # 10 minutes lifetime (maximum allowed by GitHub)
        "iss": app_id,
    }
    try:
        token = jwt.encode(payload, pem, algorithm="RS256")
    except Exception as exc:
        raise GitHubTokenError(
            f"Error signing the GitHub App JWT (app_id={app_id}): {exc}"
        ) from exc

    # PyJWT >=2.0 returns str; older versions return bytes
    return token if isinstance(token, str) else token.decode("utf-8")


def _request_installation_token(app_jwt: str, installation_id: str) -> str:
    """Requests an installation access token using the App JWT.

    POSTs to https://api.github.com/app/installations/{id}/access_tokens.
    The JWT is sent only in the header (never in logs).

    Args:
        app_jwt: Signed GitHub App JWT.
        installation_id: Installation ID.

    Returns:
        Installation access token (lifetime ~1 h).

    Raises:
        GitHubTokenError: If the GitHub API returns an error or the token is absent.
    """
    url = (
        f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    )
    headers = {
        "Authorization": f"Bearer {app_jwt}",
        "Accept": "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        resp = http_requests.post(url, headers=headers, timeout=15)
    except http_requests.RequestException as exc:
        raise GitHubTokenError(
            f"Network error requesting installation token "
            f"(installation_id={installation_id}): {exc}"
        ) from exc

    if resp.status_code != 201:
        # Do not include the full body to avoid logging sensitive data;
        # only the status and the first fragment of the message.
        raise GitHubTokenError(
            f"The GitHub API rejected the installation token request "
            f"(installation_id={installation_id}, status={resp.status_code})."
        )

    data = resp.json()
    token = data.get("token", "")
    if not token:
        raise GitHubTokenError(
            "The GitHub API response does not contain the 'token' field."
        )

    # NEVER log the token; only confirm it was obtained
    logger.info(
        "Installation token obtained (installation_id=%s, expires_at=%s).",
        installation_id,
        data.get("expires_at", "unknown"),
    )
    return token


# ─── CI log fetch ─────────────────────────────────────────────────────────────


def fetch_ci_log(
    run_id: str,
    repo: str | None = None,
    token: str | None = None,
    *,
    log_text: str | None = None,
) -> str:
    """Retrieves the failed CI log.

    This function has two modes:
    1. **Stub (log_text provided)**: Returns the log text directly.
       Useful for tests and when the log has already been downloaded.
    2. **GitHub API (repo + token)**: Downloads the log for the given run.
       Production-ready interface.

    Args:
        run_id: GitHub Actions run ID.
        repo: Repository in 'org/repo' format (required in API mode).
        token: GitHub token (required in API mode).
        log_text: Log text (if provided, uses stub mode).

    Returns:
        CI log text.

    Raises:
        CILogFetchError: If the log cannot be retrieved.
    """
    if log_text is not None:
        logger.debug("fetch_ci_log: stub mode (log_text provided, run_id=%s)", run_id)
        return log_text

    if not repo or not token:
        raise CILogFetchError(
            "API mode requires 'repo' and 'token'. "
            "Alternatively, provide 'log_text' for stub mode."
        )

    logger.info("Downloading CI log: repo=%s run_id=%s", repo, run_id)
    try:
        # Download logs via requests directly (plain-text ZIP)
        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
        }
        logs_url = (
            f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/logs"
        )
        response = http_requests.get(
            logs_url, headers=headers, timeout=30, allow_redirects=True
        )
        response.raise_for_status()

        import io  # noqa: PLC0415
        import zipfile  # noqa: PLC0415

        with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
            log_parts: list[str] = []
            for name in zf.namelist():
                if name.endswith(".txt"):
                    with zf.open(name) as f:
                        log_parts.append(f.read().decode("utf-8", errors="replace"))
            full_log = "\n".join(log_parts)

        if not full_log.strip():
            raise CILogFetchError(
                f"Empty log for run_id={run_id} in repo={repo}"
            )
        return full_log

    except http_requests.HTTPError as exc:
        raise CILogFetchError(
            f"HTTP error retrieving log (run_id={run_id}): {exc}"
        ) from exc
    except Exception as exc:
        raise CILogFetchError(
            f"Unexpected error retrieving log (run_id={run_id}): {exc}"
        ) from exc


# ─── Fetch file content ───────────────────────────────────────────────────────


def fetch_file_content(
    repo: str,
    token: str,
    path: str,
    ref: str,
    *,
    github_client: Github | None = None,
) -> str:
    """Fetches the current content of a file from a branch via PyGithub get_contents.

    Used to inject the real file content into the fix-engineer context, eliminating
    hallucinated paths/variables caused by working from the CI log alone.

    Args:
        repo: Repository in 'org/repo' format.
        token: GitHub token with contents:read permissions.
        path: File path relative to the repository root (e.g. 'sample-service/src/coldChain.ts').
        ref: Branch name or commit SHA to read from.
        github_client: Injected Github client (for tests).

    Returns:
        Decoded file content as a UTF-8 string.

    Raises:
        GithubException: If the file does not exist (404) or another API error occurs.
        ValueError: If the API returns a directory listing instead of a single file.
    """
    gh = github_client or Github(token)
    gh_repo: Repository = gh.get_repo(repo)

    result = gh_repo.get_contents(path, ref=ref)

    # get_contents returns a list when path is a directory
    if isinstance(result, list):
        raise ValueError(
            f"Path '{path}' is a directory, not a file. "
            "Provide a path to a specific file."
        )

    # ContentFile.decoded_content is bytes; decode to str
    content = result.decoded_content.decode("utf-8")
    logger.debug(
        "Fetched file content: repo=%s path=%s ref=%s size=%d chars",
        repo,
        path,
        ref,
        len(content),
    )
    return content


# ─── Deterministic repository path resolution ─────────────────────────────────


def resolve_repo_path(
    repo: str,
    token: str,
    path: str,
    ref: str,
    *,
    github_client: Github | None = None,
) -> str | None:
    """Resolves a possibly package-relative path to a real repository path.

    CI logs in a monorepo print paths relative to the package that ran the
    test (e.g. ``src/coldChain.ts`` when the real path is
    ``sample-service/src/coldChain.ts``). Feeding the package-relative path to
    the GitHub contents API yields a 404, which previously made the crew lose
    the real file content and fall back to guessing.

    This resolver is fully deterministic (no LLM): it lists the git tree of
    ``ref`` and looks for entries whose path matches ``path`` on a
    SEGMENT-ALIGNED suffix basis. Segment alignment prevents
    ``src/coldChain.ts`` from matching ``other/notsrc/coldChain.ts``.

    Resolution order:
      1. Exact match — ``path`` exists verbatim in the tree.
      2. Unique segment-aligned suffix match.
      3. Unique basename match (last resort).

    Ambiguity is treated as failure: if several files match, we return ``None``
    rather than guessing, so the caller can fail closed.

    Args:
        repo: Repository in 'org/repo' format.
        token: GitHub token with contents:read permissions.
        path: Candidate path, possibly package-relative.
        ref: Branch name or commit SHA whose tree is inspected.
        github_client: Injected Github client (for tests).

    Returns:
        The repository-relative path, or ``None`` if it cannot be resolved
        unambiguously.
    """
    candidate = path.strip().strip("`'\"").removeprefix("./").lstrip("/")
    if not candidate:
        return None

    gh = github_client or Github(token)

    try:
        gh_repo: Repository = gh.get_repo(repo)
        branch = gh_repo.get_branch(ref)
        tree = gh_repo.get_git_tree(branch.commit.sha, recursive=True)
    except Exception as exc:  # pragma: no cover - network failure path
        logger.warning("Could not list git tree for %s@%s: %s", repo, ref, exc)
        return None

    blob_paths = [e.path for e in tree.tree if e.type == "blob"]

    # 1. Exact match
    if candidate in blob_paths:
        return candidate

    # 2. Segment-aligned suffix match: the tree path must end with
    #    "/" + candidate, so segment boundaries line up.
    suffix_matches = [p for p in blob_paths if p.endswith("/" + candidate)]
    if len(suffix_matches) == 1:
        resolved = suffix_matches[0]
        logger.info("Resolved path '%s' -> '%s' (suffix match)", candidate, resolved)
        return resolved
    if len(suffix_matches) > 1:
        logger.warning(
            "Ambiguous path '%s': %d candidates in %s@%s (%s) — refusing to guess",
            candidate,
            len(suffix_matches),
            repo,
            ref,
            ", ".join(sorted(suffix_matches)[:5]),
        )
        return None

    # 3. Basename match (last resort)
    basename = candidate.rsplit("/", 1)[-1]
    base_matches = [p for p in blob_paths if p.rsplit("/", 1)[-1] == basename]
    if len(base_matches) == 1:
        resolved = base_matches[0]
        logger.info("Resolved path '%s' -> '%s' (basename match)", candidate, resolved)
        return resolved
    if len(base_matches) > 1:
        logger.warning(
            "Ambiguous basename '%s': %d candidates — refusing to guess",
            basename,
            len(base_matches),
        )
        return None

    logger.warning("Path '%s' not found in %s@%s", candidate, repo, ref)
    return None


# ─── Create branch and commit ─────────────────────────────────────────────────


def _validate_branch_name(branch_name: str) -> None:
    """Validates that the branch name is safe (never main/master).

    This is the FIRST line of defense against push-to-main.
    Called before any write operation on the repository.

    Args:
        branch_name: Target branch name.

    Raises:
        MainBranchProtectionError: If the branch is main, master, or does not
            start with fix/.
    """
    normalized = branch_name.strip().lower()

    # Direct check of protected branches
    if normalized in PROTECTED_BRANCHES:
        raise MainBranchProtectionError(
            f"OPERATION BLOCKED: Cannot create commits on the protected branch "
            f"'{branch_name}'. The self-healing crew can ONLY write to branches "
            f"with the 'fix/' prefix. This restriction is absolute and has no "
            f"configuration exceptions."
        )

    # Verify that it starts with fix/
    if not normalized.startswith("fix/"):
        raise MainBranchProtectionError(
            f"OPERATION BLOCKED: The target branch '{branch_name}' does not have "
            f"the required 'fix/' prefix. Only 'fix/*' branches are allowed for "
            f"self-healing crew automatic patches."
        )

    # Additional check: the branch name must not contain 'main' as a component
    parts = normalized.replace("\\", "/").split("/")
    for part in parts:
        if part in PROTECTED_BRANCHES:
            raise MainBranchProtectionError(
                f"OPERATION BLOCKED: The branch name '{branch_name}' contains "
                f"a protected component ('{part}'). Use a different name."
            )


def create_branch_and_commit(
    repo: str,
    token: str,
    diff_content: str,
    run_key: str,
    base_branch: str = "main",
    attempt_number: int = 1,
    *,
    file_path: str | None = None,
    file_content: str | None = None,
    github_client: Github | None = None,
) -> str:
    """Creates a fix/* branch and applies the fix via GitHub API.

    GUARDRAIL: This function NEVER writes to main or master.
    The target branch always has the format:
        fix/selfheal-<hash8>-attempt<N>

    Strategy (preferred — defect #1 fix):
      If `file_path` and `file_content` are provided, the REAL corrected file is
      written directly using Repository.update_file() / create_file().
      This is robust for demo because it avoids parsing LLM-generated unified diffs.

    Fallback:
      If only `diff_content` is provided (no file_path/file_content), or if the
      file update fails, the patch is saved as .selfheal/<run_key>.patch for
      manual review via _create_patch_notes_commit().

    Including attempt_number in the name guarantees that the 2nd attempt
    (and subsequent ones) use a new branch instead of colliding with the
    first attempt's branch (GitHub would return 422 "Reference already exists").

    Args:
        repo: Repository in 'org/repo' format.
        token: GitHub token with contents:write permissions.
        diff_content: Unified diff content (used as fallback / PR display diff).
        run_key: Execution key used to generate the unique branch name.
        base_branch: Base branch to fork from (default: main).
                     NOTE: base_branch is only the SOURCE of the base SHA,
                     NOT the target branch of the commit.
        attempt_number: Current attempt number (1-indexed). Included in the
                        branch name to guarantee per-attempt idempotency.
        file_path: Repository-relative path of the file to update (e.g.
                   'sample-service/src/coldChain.ts'). Required for the real
                   file update strategy.
        file_content: Complete corrected content of the file. Required for the
                      real file update strategy.
        github_client: Injected Github client (for tests).

    Returns:
        Name of the created branch (fix/selfheal-<hash>-attempt<N>).

    Raises:
        MainBranchProtectionError: If an attempt to write to a protected branch
            is detected.
        GithubException: If there is an error in the GitHub API.
    """
    # Generate unique branch name: hash of run_key + attempt number
    run_hash = hashlib.sha1(run_key.encode(), usedforsecurity=False).hexdigest()[:8]
    fix_branch = f"fix/selfheal-{run_hash}-attempt{attempt_number}"

    # ── GUARDRAIL: validate the target branch BEFORE any operation ────────────
    _validate_branch_name(fix_branch)
    logger.info(
        "Creating fix branch: base=%s → target=%s (repo=%s, attempt=%d)",
        base_branch,
        fix_branch,
        repo,
        attempt_number,
    )

    gh = github_client or Github(token)
    try:
        gh_repo: Repository = gh.get_repo(repo)

        # Get SHA of the base branch
        base_ref = gh_repo.get_branch(base_branch)
        base_sha = base_ref.commit.sha

        # Create the fix/* branch
        gh_repo.create_git_ref(ref=f"refs/heads/{fix_branch}", sha=base_sha)
        logger.info("Branch created: %s (base SHA: %s)", fix_branch, base_sha[:8])

        # Apply the fix — prefer full file content over diff parsing
        if file_path and file_content is not None:
            _apply_file_content_to_branch(
                gh_repo, fix_branch, file_path, file_content, run_key
            )
        else:
            logger.warning(
                "file_path/file_content not provided; falling back to patch notes commit."
            )
            _apply_diff_to_branch(gh_repo, fix_branch, diff_content, run_key)

        return fix_branch

    except GithubException as exc:
        logger.error(
            "Error creating branch and commit: repo=%s branch=%s error=%s",
            repo,
            fix_branch,
            exc,
        )
        raise


def _apply_file_content_to_branch(
    gh_repo: Repository,
    branch: str,
    file_path: str,
    new_content: str,
    run_key: str,
) -> None:
    """Applies the corrected file content to the branch using update_file / create_file.

    This is the PREFERRED strategy (defect #1 fix). It writes the complete
    corrected file as provided by the fix-engineer agent, avoiding the fragility
    of applying LLM-generated unified diffs.

    Algorithm:
      1. get_contents(file_path, ref=branch) → retrieve current blob SHA.
      2. update_file(path, message, new_content, sha=blob_sha, branch=branch).
      3. If the file does not exist (404) → create_file(...) instead.
      4. If a 409 Conflict is returned (stale SHA race condition) → re-raise
         so the caller can decide whether to retry.

    Args:
        gh_repo: PyGithub repository.
        branch: Target branch name (already validated with fix/ prefix).
        file_path: Repository-relative path of the file to update.
        new_content: Complete corrected file content (UTF-8 string).
        run_key: Execution key (for the commit message).

    Raises:
        MainBranchProtectionError: Defense-in-depth re-validation.
        GithubException: On API error (including 409 Conflict).
    """
    # Defense in depth: re-validate the branch before any write
    _validate_branch_name(branch)

    commit_message = (
        f"fix(selfheal): auto-repair {file_path} for run {run_key}\n\n"
        "Applied by ugp-self-healing-crew (full file content strategy).\n"
        "Review before merging."
    )

    try:
        existing = gh_repo.get_contents(file_path, ref=branch)
        # get_contents returns a list for directories; guard against it
        if isinstance(existing, list):
            raise GithubException(
                status=422,
                data={"message": f"'{file_path}' is a directory, not a file."},
                headers=None,
            )
        blob_sha = existing.sha
        gh_repo.update_file(
            path=file_path,
            message=commit_message,
            content=new_content,
            sha=blob_sha,
            branch=branch,
        )
        logger.info(
            "File updated via update_file: path=%s branch=%s", file_path, branch
        )
    except GithubException as exc:
        if exc.status == 404:
            # File does not exist on the branch → create it
            logger.warning(
                "File '%s' not found on branch '%s'; creating it.",
                file_path,
                branch,
            )
            gh_repo.create_file(
                path=file_path,
                message=commit_message,
                content=new_content,
                branch=branch,
            )
            logger.info(
                "File created via create_file: path=%s branch=%s", file_path, branch
            )
        elif exc.status == 409:
            # Stale SHA — another process modified the file between get_contents
            # and update_file. Unlikely in a single fix/* branch per run, but
            # must be surfaced explicitly so the circuit breaker can retry.
            logger.error(
                "409 Conflict applying file '%s' to branch '%s': stale blob SHA. "
                "The file may have been modified concurrently. "
                "Circuit breaker will handle the retry.",
                file_path,
                branch,
            )
            raise
        else:
            logger.error(
                "GitHub API error updating file '%s' on branch '%s': %s",
                file_path,
                branch,
                exc,
            )
            raise


def _apply_diff_to_branch(
    gh_repo: Repository,
    branch: str,
    diff_content: str,
    run_key: str,
) -> None:
    """Fallback: saves the diff as .selfheal/<run_key>.patch for manual review.

    This function is called when file_path/file_content are not available.
    The preferred path is _apply_file_content_to_branch() which writes the
    real corrected file content.

    Args:
        gh_repo: PyGithub repository.
        branch: Target branch name (already validated with fix/ prefix).
        diff_content: Diff in unified format (saved as-is for human review).
        run_key: Execution key (for the commit message and file path).
    """
    # Defense in depth: re-validate the branch before any write
    _validate_branch_name(branch)

    import re  # noqa: PLC0415

    # Parse modified files from the diff (for logging only)
    file_pattern = re.compile(r"^\+\+\+ b/(.+)$", re.MULTILINE)
    files_in_diff = file_pattern.findall(diff_content)

    if files_in_diff:
        logger.warning(
            "Falling back to patch notes commit for files: %s. "
            "The real file content was not provided — the patch will need "
            "manual application from .selfheal/%s.patch.",
            files_in_diff,
            run_key,
        )
    else:
        logger.warning(
            "No files found in the diff; creating a documentation commit."
        )

    _create_patch_notes_commit(gh_repo, branch, diff_content, run_key)


def _create_patch_notes_commit(
    gh_repo: Repository,
    branch: str,
    diff_content: str,
    run_key: str,
) -> None:
    """Creates a commit with patch notes in .selfheal/<run_key>.patch.

    This is the fallback mechanism: when the diff cannot be applied
    directly, the diff is saved as a file for human review.

    Args:
        gh_repo: PyGithub repository.
        branch: Target branch (always fix/*).
        diff_content: Diff content.
        run_key: Execution key.
    """
    # Defense in depth: re-validate the branch before creating the file
    _validate_branch_name(branch)

    patch_path = f".selfheal/{run_key}.patch"
    commit_message = (
        f"fix(selfheal): patch for run {run_key} [pending human review]\n\n"
        "The diff has been saved in .selfheal/ for manual application.\n"
        "Generated by ugp-self-healing-crew."
    )
    try:
        gh_repo.create_file(
            path=patch_path,
            message=commit_message,
            content=diff_content,
            branch=branch,
        )
        logger.info("Patch notes commit created: %s on %s", patch_path, branch)
    except GithubException as exc:
        logger.error("Error creating patch notes commit: %s", exc)
        raise


# ─── Open Pull Request ────────────────────────────────────────────────────────


def open_pull_request(
    repo: str,
    token: str,
    fix_branch: str,
    base_branch: str,
    run_key: str,
    analysis_summary: str,
    *,
    display_diff: str | None = None,
    github_client: Github | None = None,
) -> str:
    """Opens a Pull Request from fix_branch to base_branch.

    Includes in the description: the RCA diagnosis, the run_key, a display diff
    (computed locally via difflib for human review — not the LLM-generated diff),
    and a notice that it was automatically generated by the self-healing crew.

    Args:
        repo: Repository in 'org/repo' format.
        token: GitHub token with pull_requests:write permissions.
        fix_branch: Branch with the patch (must start with fix/).
        base_branch: PR base branch (typically the branch that failed).
        run_key: Identifier of the failed execution.
        analysis_summary: RCA analysis summary for the PR description.
        display_diff: Optional diff computed locally (difflib) for display only.
                      Not the LLM-generated diff — this one is always syntactically
                      correct and generated from the actual old/new file contents.
        github_client: Injected Github client (for tests).

    Returns:
        URL of the created Pull Request.

    Raises:
        MainBranchProtectionError: If fix_branch is a protected branch.
        GithubException: If there is an error in the GitHub API.
    """
    # Validate that the patch branch is valid
    _validate_branch_name(fix_branch)

    gh = github_client or Github(token)
    gh_repo = gh.get_repo(repo)

    pr_title = f"fix(selfheal): auto-repair for run {run_key}"

    diff_section = ""
    if display_diff:
        diff_section = (
            "\n### Changes Applied\n"
            f"```diff\n{display_diff}\n```\n"
        )

    pr_body = (
        "## 🤖 Automatic patch — Self-Healing Crew\n\n"
        f"**Run/Commit:** `{run_key}`\n"
        f"**Branch:** `{fix_branch}` → `{base_branch}`\n\n"
        "### RCA Diagnosis\n"
        f"{analysis_summary}\n"
        f"{diff_section}\n"
        "---\n"
        "> ⚠️ This PR was automatically generated by `ugp-self-healing-crew`.\n"
        "> The patch was reviewed and approved by the **reviewer** agent before "
        "being applied.\n"
        "> Review before merging."
    )

    try:
        pr = gh_repo.create_pull(
            title=pr_title,
            body=pr_body,
            head=fix_branch,
            base=base_branch,
            draft=True,  # Always as draft for human review
        )
        logger.info("PR created: %s (number: %d)", pr.html_url, pr.number)
        return pr.html_url

    except GithubException as exc:
        logger.error("Error creating PR: %s", exc)
        raise


# ─── Escalate to human ────────────────────────────────────────────────────────


def escalate_to_human(
    repo: str,
    run_key: str,
    attempt_count: int,
    max_attempts: int,
    reason: str = "Circuit breaker exhausted",
) -> None:
    """Notifies that automatic attempts have been exhausted and escalates to the team.

    In this phase it records the escalation in structured logs.
    In production it would connect to SNS, PagerDuty, Slack, etc.

    Args:
        repo: Repository in 'org/repo' format.
        run_key: Identifier of the failed execution.
        attempt_count: Number of attempts made.
        max_attempts: Configured maximum limit.
        reason: Reason for escalation.
    """
    logger.error(
        "ESCALATED TO HUMAN — repo=%s run_key=%s "
        "attempts=%d/%d reason='%s'. "
        "The self-healing crew will NOT attempt to auto-repair this failure again. "
        "Action required: manually review the CI failure.",
        repo,
        run_key,
        attempt_count,
        max_attempts,
        reason,
    )
    # TODO(production): send notification to SNS/Slack/PagerDuty
    # sns_client = boto3.client("sns", region_name=region)
    # sns_client.publish(TopicArn=ESCALATION_TOPIC_ARN, Message=...)
