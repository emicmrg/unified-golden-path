"""
Self-healing crew main orchestrator.

Full flow:
  1. Load and validate configuration.
  2. Check the circuit breaker (DynamoDB): if exhausted, escalate and exit.
  3. Obtain a GitHub token (Secrets Manager / env).
  4. Retrieve the failed CI log.
  5. Execute the Crew (analyze → fix → review).
  6. Parse the reviewer verdict.
  7. If APPLY: create a fix/* branch and open a PR.
  8. If REJECT: log the reason and exit (without modifying the repo).
  9. Record the result in structured logs.

Entry point: ugp-selfheal (defined in pyproject.toml).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from crewai import Crew, Process

from crew.agents import build_agents
from crew.circuit_breaker import CircuitBreaker
from crew.config import get_settings
from crew.tasks import build_tasks
from crew.verdict import extract_diff, parse_verdict
from crew.tools import (
    MainBranchProtectionError,
    create_branch_and_commit,
    escalate_to_human,
    fetch_ci_log,
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
    log_analyst, fix_engineer, reviewer = build_agents(cfg)
    analyze_task, fix_task, review_task = build_tasks(
        log_analyst=log_analyst,
        fix_engineer=fix_engineer,
        reviewer=reviewer,
        ci_log=ci_log,
        repo=repo,
        run_key=run_key,
    )

    crew = Crew(
        agents=[log_analyst, fix_engineer, reviewer],
        tasks=[analyze_task, fix_task, review_task],
        process=Process.sequential,
        verbose=False,
    )

    logger.info("Running crew (analyze → fix → review)...")
    try:
        crew_result = crew.kickoff()
    except Exception as exc:
        logger.error("Error running the crew: %s", exc)
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

    # APPLY: create branch and PR
    # Extract diff from fix_task output
    fix_output = fix_task.output.raw if fix_task.output else ""
    diff_content = extract_diff(fix_output) or fix_output

    if not diff_content.strip():
        logger.error(
            "Reviewer approved but there is no diff to apply. "
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

    # Extract analysis summary (first task) for the PR description
    analysis_output = analyze_task.output.raw if analyze_task.output else ""
    analysis_summary = analysis_output[:1000] if analysis_output else "(see diff)"

    try:
        pr_url = open_pull_request(
            repo=repo,
            token=github_token,
            fix_branch=fix_branch,
            base_branch=base_branch,
            run_key=run_key,
            analysis_summary=analysis_summary,
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
