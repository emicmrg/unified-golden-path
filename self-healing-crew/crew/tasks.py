"""
Definition of the 3 self-healing crew tasks.

Tasks are chained sequentially:
  1. analyze_task  → analyzes the log and produces an RCA diagnosis.
  2. fix_task      → generates the patch from the diagnosis.
  3. review_task   → validates the patch and emits APPLY or REJECT.

The result of each task is accessible by the next one as context
(context=[previous_task]) natively in CrewAI.

The parse_verdict, extract_diff, and extract_file_content functions are in
crew.verdict so they can be imported without depending on crewai (useful in tests).

Pure-string helpers (_build_fix_description, _build_review_description) live in
crew.task_descriptions so they can be imported WITHOUT crewai (for unit tests).
"""

from __future__ import annotations

from crewai import Agent, Task

# Re-export for compatibility with existing imports
from crew.verdict import extract_diff, extract_file_content, parse_verdict
from crew.task_descriptions import _build_fix_description, _build_review_description

__all__ = [
    "build_tasks",
    "parse_verdict",
    "extract_diff",
    "extract_file_content",
    "_build_fix_description",
    "_build_review_description",
]


# ─── Task factory ─────────────────────────────────────────────────────────────


def build_tasks(
    log_analyst: Agent,
    fix_engineer: Agent,
    reviewer: Agent,
    ci_log: str,
    repo: str,
    run_key: str,
    *,
    file_path: str | None = None,
    file_content: str | None = None,
    rca_summary: str | None = None,
) -> tuple[Task, Task, Task]:
    """Builds the 3 tasks of the analyze → fix → review cycle.

    Args:
        log_analyst: Log analyst agent.
        fix_engineer: Repair engineer agent.
        reviewer: Reviewer agent.
        ci_log: Full text of the failed CI log.
        repo: Repository in 'org/repo' format.
        run_key: Execution identifier (run ID or commit SHA).
        file_path: Repository-relative path of the file to fix (e.g.
                   'sample-service/src/coldChain.ts'). Injected into fix_task
                   to eliminate hallucinated paths.
        file_content: Current content of the file to fix, fetched from the
                      failed branch. Injected into fix_task to eliminate
                      hallucinated variable names and line numbers.
        rca_summary: Text of the RCA diagnosis produced by the log-analyst in
                     phase 1. Injected into fix_task and review_task so that the
                     reviewer can judge the patch AGAINST the actual diagnosis
                     rather than blindly. This is required in the two-phase flow
                     because analyze_task runs in a separate Crew and its output
                     is NOT in CrewAI's task context for phase-2 tasks.

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
            "- FILE: <single repository-relative path, or 'N/A'>\n"
            "- ROOT_CAUSE: <concise description of the cause>\n"
            "- CONTEXT: <literal quote from the log that confirms the diagnosis>\n"
            "- SUGGESTED_ACTION: <description of the change needed to fix it>\n\n"
            "STRICT RULES for the FILE field (a machine parses it, not a human):\n"
            "1. EXACTLY ONE path. Never two paths, never 'A and B', never a list.\n"
            "2. NO prose, NO parentheses, NO explanation after the path. The whole\n"
            "   value must be just the path (an optional ':<line>' suffix is allowed).\n"
            "3. It must be the SOURCE file that CONTAINS THE DEFECT — not the test\n"
            "   file that detected it. When a test fails because the implementation\n"
            "   is wrong, name the implementation file. Only name a test file when\n"
            "   the test itself is the thing that is wrong.\n"
            "4. Prefer a path relative to the repository root, including the package\n"
            "   directory (e.g. 'sample-service/src/coldChain.ts', NOT just\n"
            "   'src/coldChain.ts'). CI logs often print package-relative paths;\n"
            "   add the package prefix when you can infer it from the log.\n"
            "5. Use 'N/A' only when no single file can be identified."
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
        description=_build_fix_description(
            file_path=file_path,
            file_content=file_content,
            rca_summary=rca_summary,
        ),
        expected_output=(
            "The response must contain:\n"
            "1. FILE_PATH: <path> — the exact repository-relative path.\n"
            "2. <<<FILE_CONTENT>>> ... <<<END_FILE_CONTENT>>> — the COMPLETE corrected\n"
            "   file (all lines, not just changed ones).\n"
            "3. JUSTIFICATION: explaining the relationship to the root cause.\n"
            "4. MODIFIED_FILES: list of touched files.\n"
            "5. Optional: a ```diff ... ``` block for human display only.\n"
            "Or PATCH_IMPOSSIBLE: with reason if the patch cannot be generated."
        ),
        agent=fix_engineer,
        context=[analyze_task],
    )

    # ── Task 3: Review and verdict ────────────────────────────────────────────
    review_task = Task(
        description=_build_review_description(repo, rca_summary=rca_summary),
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
