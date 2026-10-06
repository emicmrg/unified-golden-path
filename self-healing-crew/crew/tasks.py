"""
Definition of the 3 self-healing crew tasks.

Tasks are chained sequentially:
  1. analyze_task  → analyzes the log and produces an RCA diagnosis.
  2. fix_task      → generates the patch from the diagnosis.
  3. review_task   → validates the patch and emits APPLY or REJECT.

The result of each task is accessible by the next one as context
(context=[previous_task]) natively in CrewAI.

The parse_verdict and extract_diff functions are in crew.verdict so they
can be imported without depending on crewai (useful in tests).
"""

from __future__ import annotations

from crewai import Agent, Task

# Re-export for compatibility with existing imports
from crew.verdict import extract_diff, parse_verdict

__all__ = ["build_tasks", "parse_verdict", "extract_diff"]


def build_tasks(
    log_analyst: Agent,
    fix_engineer: Agent,
    reviewer: Agent,
    ci_log: str,
    repo: str,
    run_key: str,
) -> tuple[Task, Task, Task]:
    """Builds the 3 tasks of the analyze → fix → review cycle.

    Args:
        log_analyst: Log analyst agent.
        fix_engineer: Repair engineer agent.
        reviewer: Reviewer agent.
        ci_log: Full text of the failed CI log.
        repo: Repository in 'org/repo' format.
        run_key: Execution identifier (run ID or commit SHA).

    Returns:
        Tuple (analyze_task, fix_task, review_task).
    """

    # ── Task 1: Root cause analysis ───────────────────────────────────────────
    analyze_task = Task(
        description=(
            f"Analyze the following failed CI log from repository '{repo}' "
            f"(run/commit: {run_key}).\n\n"
            "=== CI LOG ===\n"
            f"{ci_log}\n"
            "=== END OF LOG ===\n\n"
            "Identify the root cause of the failure using the following exact format:\n"
            "- ERROR_TYPE: <error type>\n"
            "- FILE: <file:line or 'N/A'>\n"
            "- ROOT_CAUSE: <concise description of the cause>\n"
            "- CONTEXT: <literal quote from the log that confirms the diagnosis>\n"
            "- SUGGESTED_ACTION: <description of the change needed to fix it>"
        ),
        expected_output=(
            "Structured diagnosis with the fields:\n"
            "ERROR_TYPE, FILE, ROOT_CAUSE, CONTEXT, SUGGESTED_ACTION.\n"
            "The CONTEXT field must literally quote the log line "
            "that evidences the failure."
        ),
        agent=log_analyst,
    )

    # ── Task 2: Patch generation ──────────────────────────────────────────────
    fix_task = Task(
        description=(
            "Based on the diagnosis from the previous task, generate the minimum "
            "patch that resolves the problem.\n\n"
            "MANDATORY RULES:\n"
            "1. The patch must be in unified diff format (git diff).\n"
            "2. The patch MUST NOT modify files on main or master branches.\n"
            "3. Include a JUSTIFICATION: section explaining why this change "
            "   resolves the root cause.\n"
            "4. If there is not enough information to generate a safe patch, "
            "   indicate PATCH_IMPOSSIBLE: with the reason.\n\n"
            "Expected response format:\n"
            "```diff\n"
            "<unified diff here>\n"
            "```\n"
            "JUSTIFICATION: <explanation>\n"
            "MODIFIED_FILES: <comma-separated list of files>"
        ),
        expected_output=(
            "A patch in unified diff format (git diff) with:\n"
            "- The ```diff ... ``` block with the applicable diff.\n"
            "- JUSTIFICATION: explaining the relationship to the root cause.\n"
            "- MODIFIED_FILES: list of touched files.\n"
            "Or PATCH_IMPOSSIBLE: with reason if the patch cannot be generated."
        ),
        agent=fix_engineer,
        context=[analyze_task],
    )

    # ── Task 3: Review and verdict ────────────────────────────────────────────
    review_task = Task(
        description=(
            "Review the diagnosis and the patch generated in the previous tasks "
            f"for repository '{repo}'.\n\n"
            "APPROVAL CRITERIA (all must be met):\n"
            "1. The patch effectively resolves the diagnosed root cause.\n"
            "2. The diff is syntactically correct and applicable with 'git apply'.\n"
            "3. It does not introduce obvious security vulnerabilities.\n"
            "4. It does not modify critical configuration files without justification.\n"
            "5. The scope of the change is minimal (no unnecessary changes).\n"
            "6. It does not attempt to make changes directly on main or master.\n\n"
            "REJECTION CRITERIA (any one is sufficient):\n"
            "- The patch does not correspond to the diagnosed problem.\n"
            "- The diff is malformed or not applicable.\n"
            "- It introduces security changes without sufficient context.\n"
            "- The scope is too broad (unrelated refactor).\n"
            "- The previous task marked PATCH_IMPOSSIBLE.\n\n"
            "MANDATORY RESPONSE FORMAT:\n"
            "First write your review analysis (max. 200 words).\n"
            "The LAST line of your response must be exactly one of:\n"
            "  VERDICT: APPLY\n"
            "  VERDICT: REJECT — <concise reason>"
        ),
        expected_output=(
            "Review analysis followed by the structured verdict.\n"
            "The last line must be exactly:\n"
            "  'VERDICT: APPLY'  — if the patch is correct and safe.\n"
            "  'VERDICT: REJECT — <reason>'  — if there is any issue.\n"
            "No exceptions: the verdict always on the last line."
        ),
        agent=reviewer,
        context=[analyze_task, fix_task],
    )

    return analyze_task, fix_task, review_task
