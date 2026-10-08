"""
Self-healing crew main orchestrator.

Full flow:
  1. Load and validate configuration.
  2. Check the circuit breaker (DynamoDB): if exhausted, escalate and exit.
  3. Obtain a GitHub token (Secrets Manager / env).
  4. Retrieve the failed CI log.
  5. Run the analyze phase (log-analyst) to get the RCA diagnosis.
  6. Extract the FILE field from the RCA and fetch its real content (defect #2 fix).
  7. Execute fix → review tasks with real file content injected.
  8. Parse the reviewer verdict.
  9. If APPLY: extract the corrected file content, create a fix/* branch, apply the
     real file update via update_file (defect #1 fix), and open a PR.
 10. If REJECT: log the reason and exit (without modifying the repo).
 11. Record the result in structured logs.

Entry point: ugp-selfheal (defined in pyproject.toml).
"""

from __future__ import annotations

import argparse
import difflib
import logging
import os
import re
import sys

from crewai import Crew, Process

from crew.agents import build_agents
from crew.circuit_breaker import CircuitBreaker
from crew.config import get_settings
from crew.tasks import build_tasks
from crew.verdict import extract_diff, extract_file_content, parse_verdict
from crew.tools import (
    MainBranchProtectionError,
    create_branch_and_commit,
    escalate_to_human,
    fetch_ci_log,
    fetch_file_content,
    get_github_token,
    open_pull_request,
)

# ─── Logger configuration ─────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
logger = logging.getLogger("ugp.selfheal")


# ─── Entry point ──────────────────────────────────────────────────────────────


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parses command-line arguments.

    In Fargate, parameters arrive as environment variables.
    The CLI is convenient for local execution.
    """
    parser = argparse.ArgumentParser(
        prog="ugp-selfheal",
        description=(
            "Self-healing crew for CI/CD — "
            "analyzes GitHub Actions failures and generates automatic patches."
        ),
    )
    parser.add_argument(
        "--run-id",
        default=os.environ.get("UGP_RUN_ID"),
        help="Failed GitHub Actions run ID (or UGP_RUN_ID variable).",
    )
    parser.add_argument(
        "--run-key",
        default=os.environ.get("UGP_RUN_KEY"),
        help=(
            "Unique failure key (run_id + commit SHA). "
            "Used as the circuit breaker PK in DynamoDB."
        ),
    )
    parser.add_argument(
        "--log-text",
        default=os.environ.get("UGP_LOG_TEXT"),
        help=(
            "CI log text (stub mode). "
            "If provided, it is not downloaded from GitHub."
        ),
    )
    parser.add_argument(
        "--base-branch",
        default=os.environ.get("UGP_BASE_BRANCH", "main"),
        help="Base branch for the PR (default: main).",
    )
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> int:
    """Executes the self-healing crew.

    Returns:
        Exit code: 0 = success, 1 = failure, 2 = escalated to human.
    """
    args = _parse_args(argv)

    # ── 1. Configuration ──────────────────────────────────────────────────────
    try:
        cfg = get_settings()
    except Exception as exc:
        logger.error("Error loading configuration: %s", exc)
        return 1

    # Determine run_key (circuit breaker PK).
    # run_key MUST be a real identifier (run_id or commit SHA) so the circuit
    # breaker correctly distinguishes each distinct failure.
    # Fails explicitly if none is provided to avoid collisions in the DynamoDB
    # table with the phantom key 'unknown-run'.
    run_id = args.run_id
    if not run_id:
        logger.error(
            "--run-id (or the UGP_RUN_ID environment variable) is required "
            "to identify the failed CI run."
        )
        return 1
    run_key = args.run_key or run_id
    repo = cfg.github_repo
    base_branch = args.base_branch

    logger.info(
        "Starting self-healing crew: repo=%s run_key=%s base_branch=%s",
        repo,
        run_key,
        base_branch,
    )

    # ── 2. Circuit breaker ────────────────────────────────────────────────────
    cb = CircuitBreaker(
        table_name=cfg.ddb_table_name,
        max_attempts=cfg.max_attempts,
        region=cfg.aws_region,
    )

    # Check if it was already escalated in previous attempts
    try:
        if cb.is_escalated(repo, run_key):
            logger.warning(
                "Failure already escalated to human: repo=%s run_key=%s. "
                "Crew will not be re-executed.",
                repo,
                run_key,
            )
            return 2
    except RuntimeError as exc:
        logger.error("Error checking escalation state: %s", exc)
        return 1

    # Increment counter and check limit
    try:
        attempt_result = cb.check_and_increment(repo, run_key)
    except RuntimeError as exc:
        logger.error("Error in circuit breaker: %s", exc)
        return 1

    if not attempt_result.allowed:
        logger.warning(
            "Circuit breaker EXHAUSTED: repo=%s run_key=%s "
            "attempts=%d/%d → escalating to human.",
            repo,
            run_key,
            attempt_result.attempt_number,
            attempt_result.max_attempts,
        )
        escalate_to_human(
            repo=repo,
            run_key=run_key,
            attempt_count=attempt_result.attempt_number,
            max_attempts=attempt_result.max_attempts,
            reason="Automatic attempt limit reached",
        )
        try:
            cb.mark_escalated(repo, run_key)
        except RuntimeError as exc:
            logger.warning("Could not mark as escalated: %s", exc)
        return 2

    logger.info(
        "Attempt %d/%d for repo=%s run_key=%s",
        attempt_result.attempt_number,
        attempt_result.max_attempts,
        repo,
        run_key,
    )

    # ── 3. GitHub token ───────────────────────────────────────────────────────
    # In Fargate mode (allow_env_token=False, DEFAULT):
    #   → get_github_token goes to Secrets Manager, signs RS256 JWT, returns
    #     GitHub App installation token.
    # In Runner 1 mode (allow_env_token=True, GHA only):
    #   → get_github_token returns os.environ['GITHUB_TOKEN'] directly.
    #     cfg.github_token_secret_arn is None in this mode (optional).
    #
    # The route choice is made by get_github_token by consulting cfg internally,
    # so the call interface is identical in both modes.
    try:
        github_token = get_github_token(
            secret_arn=cfg.github_token_secret_arn or "",
            region=cfg.aws_region,
            # _env_fallback=False (default) — the allow_env_token mode is
            # independent and explicit; it is not a "silent fallback".
        )
    except Exception as exc:
        logger.error("Could not obtain GitHub token: %s", exc)
        return 1

    # ── 4. CI log ─────────────────────────────────────────────────────────────
    try:
        ci_log = fetch_ci_log(
            run_id=run_id,
            repo=repo,
            token=github_token,
            log_text=args.log_text,
        )
    except Exception as exc:
        logger.error("Could not retrieve CI log: %s", exc)
        return 1

    logger.info("CI log retrieved (%d chars)", len(ci_log))

    # ── 5. Build and execute the Crew ─────────────────────────────────────────
    # Phase 1: run only analyze_task to extract the RCA and the FILE field.
    # Phase 2: fetch real file content, then run fix_task + review_task with it.
    log_analyst, fix_engineer, reviewer = build_agents(cfg)

    # ── Phase 1 — Analyze only ────────────────────────────────────────────────
    analyze_task_only, _fix_placeholder, _review_placeholder = build_tasks(
        log_analyst=log_analyst,
        fix_engineer=fix_engineer,
        reviewer=reviewer,
        ci_log=ci_log,
        repo=repo,
        run_key=run_key,
        # No file content yet — analyze phase doesn't need it
    )

    analyze_crew = Crew(
        agents=[log_analyst],
        tasks=[analyze_task_only],
        process=Process.sequential,
        verbose=False,
    )

    logger.info("Running analyze phase (log-analyst)...")
    try:
        analyze_crew.kickoff()
    except Exception as exc:
        logger.error("Error running the analyze phase: %s", exc)
        return 1

    analysis_output = analyze_task_only.output.raw if analyze_task_only.output else ""
    logger.info("Analysis complete (%d chars)", len(analysis_output))

    # ── 6. Extract FILE field and fetch real content (defect #2 fix) ──────────
    # The log-analyst emits: "- FILE: <path:line or 'N/A'>"
    # Extract the path portion (strip any ":line" suffix).
    file_path_for_fix: str | None = None
    real_file_content: str | None = None

    file_field_match = re.search(
        r"(?:^|\n)\s*-?\s*FILE:\s*(.+?)(?:\s*$|\n)",
        analysis_output,
        re.IGNORECASE,
    )
    if file_field_match:
        raw_file_field = file_field_match.group(1).strip()
        # Strip line number suffix (e.g. "sample-service/src/coldChain.ts:42" → path only)
        candidate_path = raw_file_field.split(":")[0].strip()
        if candidate_path and candidate_path.upper() not in ("N/A", "NA", "UNKNOWN"):
            file_path_for_fix = candidate_path
            logger.info(
                "FILE field extracted from RCA: '%s' (raw: '%s')",
                file_path_for_fix,
                raw_file_field,
            )
            # Fetch real content from the failed branch
            try:
                real_file_content = fetch_file_content(
                    repo=repo,
                    token=github_token,
                    path=file_path_for_fix,
                    ref=base_branch,
                )
                logger.info(
                    "Real file content fetched: path=%s ref=%s size=%d chars",
                    file_path_for_fix,
                    base_branch,
                    len(real_file_content),
                )
            except Exception as exc:
                logger.warning(
                    "Could not fetch real content for '%s' on branch '%s': %s. "
                    "fix-engineer will proceed without injected file content.",
                    file_path_for_fix,
                    base_branch,
                    exc,
                )
                real_file_content = None
        else:
            logger.warning(
                "FILE field is '%s' — no specific file to fetch; "
                "fix-engineer will work from the RCA diagnosis only.",
                raw_file_field,
            )
    else:
        logger.warning(
            "No FILE field found in analyze output; "
            "fix-engineer will work from the RCA diagnosis only."
        )

    # ── Phase 2 — Fix + Review with injected file content ─────────────────────
    _, fix_task, review_task = build_tasks(
        log_analyst=log_analyst,
        fix_engineer=fix_engineer,
        reviewer=reviewer,
        ci_log=ci_log,
        repo=repo,
        run_key=run_key,
        file_path=file_path_for_fix,
        file_content=real_file_content,
        # B1: re-inject the RCA text so fix_task and review_task have the
        # diagnosis as explicit context — analyze_task ran in a separate Crew
        # (phase 1) and is NOT in the CrewAI task-context chain for phase 2.
        rca_summary=analysis_output if analysis_output else None,
    )

    fix_review_crew = Crew(
        agents=[fix_engineer, reviewer],
        tasks=[fix_task, review_task],
        process=Process.sequential,
        verbose=False,
    )

    logger.info("Running fix → review phases...")
    try:
        crew_result = fix_review_crew.kickoff()
    except Exception as exc:
        logger.error("Error running the fix/review phases: %s", exc)
        return 1

    # ── 6. Parse verdict ──────────────────────────────────────────────────────
    # The crew result is the output of the last task (review_task)
    review_output = str(crew_result)

    try:
        verdict, reject_reason = parse_verdict(review_output)
    except ValueError as exc:
        logger.error("Could not parse reviewer verdict: %s", exc)
        return 1

    logger.info("Reviewer verdict: %s", verdict)

    # ── 7/8. Apply or reject the patch ────────────────────────────────────────
    if verdict == "REJECT":
        logger.warning(
            "Patch REJECTED by the reviewer: %s. "
            "Repository will not be modified.",
            reject_reason or "(no explicit reason)",
        )
        return 1

    # APPLY: extract corrected file content from fix_task output (defect #1 fix)
    fix_output = fix_task.output.raw if fix_task.output else ""

    # ── N2: PATCH_IMPOSSIBLE safety net ───────────────────────────────────────
    # If the fix-engineer declared PATCH_IMPOSSIBLE, stop immediately — even if
    # the reviewer hallucinated APPLY. The reviewer prompt lists PATCH_IMPOSSIBLE
    # as a rejection criterion, but the LLM may still emit APPLY. This explicit
    # code-level check is the safety net that the prompts alone cannot guarantee.
    if "PATCH_IMPOSSIBLE" in fix_output:
        # Extract the reason (the text after PATCH_IMPOSSIBLE:, if present)
        pi_match = re.search(
            r"PATCH_IMPOSSIBLE\s*:\s*(.+?)(?:\n|$)", fix_output, re.IGNORECASE
        )
        pi_reason = pi_match.group(1).strip() if pi_match else "(no reason given)"
        logger.error(
            "Fix-engineer declared PATCH_IMPOSSIBLE: %s. "
            "Aborting — no patch will be applied regardless of reviewer verdict.",
            pi_reason,
        )
        return 1

    # Try to extract full file content (preferred path)
    extracted = extract_file_content(fix_output)
    apply_file_path: str | None = None
    apply_file_content: str | None = None
    display_diff: str | None = None

    if extracted:
        apply_file_path, apply_file_content = extracted
        logger.info(
            "Extracted corrected file content: path=%s size=%d chars",
            apply_file_path,
            len(apply_file_content),
        )
        # Compute a display diff (difflib) from old → new for the PR body
        if real_file_content is not None:
            diff_lines = list(
                difflib.unified_diff(
                    real_file_content.splitlines(keepends=True),
                    apply_file_content.splitlines(keepends=True),
                    fromfile=f"a/{apply_file_path}",
                    tofile=f"b/{apply_file_path}",
                    lineterm="",
                )
            )
            display_diff = "".join(diff_lines) if diff_lines else None
            if display_diff:
                logger.info(
                    "Display diff computed: %d lines", len(diff_lines)
                )
        else:
            # Fall back to LLM-generated diff for display (not for applying)
            display_diff = extract_diff(fix_output)
    else:
        # No file content block found — fall back to diff-only (patch notes)
        logger.warning(
            "No <<<FILE_CONTENT>>> block found in fix_task output; "
            "will fall back to patch notes commit."
        )
        display_diff = extract_diff(fix_output)

    # Build the diff_content for the fallback path
    diff_content = display_diff or fix_output

    # ── N1: Guard "nothing to apply" ─────────────────────────────────────────
    # The reviewer said APPLY. There are two distinct failure modes:
    #   (a) APPLY but fix-engineer produced no <<<FILE_CONTENT>>> block
    #       → hard failure: do NOT fall through to patch-notes; log and return 1.
    #   (b) APPLY with a valid file block but real_file_content could not be
    #       fetched (GitHub error) → downgrade to patch-notes commit (best-effort).
    #
    # The old guard (`if not apply_file_path and not diff_content.strip()`) only
    # caught case (b) when diff_content was also empty, which is almost never
    # true. This meant an APPLY with no file content silently produced a
    # patch-notes PR that corrected nothing.
    if apply_file_path is None or apply_file_content is None:
        # Case (a): reviewer approved but fix-engineer produced no applicable
        # file content. This is a crew failure, not a graceful degradation.
        logger.error(
            "reviewer approved but fix-engineer produced no applicable file content "
            "(apply_file_path=%r, apply_file_content is None=%s). "
            "Aborting — inspect the fix_engineer output manually.",
            apply_file_path,
            apply_file_content is None,
        )
        return 1

    if not diff_content.strip():
        # Case (b): file block extracted OK but diff_content is empty and
        # real_file_content was None — nothing meaningful to commit.
        logger.error(
            "Reviewer approved but there is no content to apply. "
            "Manually review the fix_engineer output."
        )
        return 1

    try:
        fix_branch = create_branch_and_commit(
            repo=repo,
            token=github_token,
            diff_content=diff_content,
            run_key=run_key,
            base_branch=base_branch,
            attempt_number=attempt_result.attempt_number,
            file_path=apply_file_path,
            file_content=apply_file_content,
        )
    except MainBranchProtectionError as exc:
        # This error should never occur by design, but if it does it is critical
        logger.critical(
            "GUARDRAIL TRIGGERED — attempt to write to a protected branch: %s",
            exc,
        )
        return 1
    except Exception as exc:
        logger.error("Error creating branch and commit: %s", exc)
        return 1

    # Use first 1000 chars of analysis for the PR description
    analysis_summary = analysis_output[:1000] if analysis_output else "(see diff)"

    try:
        pr_url = open_pull_request(
            repo=repo,
            token=github_token,
            fix_branch=fix_branch,
            base_branch=base_branch,
            run_key=run_key,
            analysis_summary=analysis_summary,
            display_diff=display_diff,
        )
        logger.info(
            "PR created successfully: %s (branch: %s → %s)",
            pr_url,
            fix_branch,
            base_branch,
        )
    except Exception as exc:
        logger.error("Error opening PR: %s", exc)
        return 1

    logger.info(
        "Self-healing crew completed: attempt=%d/%d repo=%s run_key=%s PR=%s",
        attempt_result.attempt_number,
        attempt_result.max_attempts,
        repo,
        run_key,
        pr_url,
    )
    return 0


def main() -> None:
    """Entry point for the ugp-selfheal command."""
    sys.exit(run())


if __name__ == "__main__":
    main()
