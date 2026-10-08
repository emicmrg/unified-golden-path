"""
Pure description builders for CrewAI tasks.

Separated from tasks.py so they can be imported and tested WITHOUT depending
on crewai (which requires pkg_resources / setuptools at import time).

This mirrors the approach used in crew.verdict for parse_verdict / extract_diff.
"""

from __future__ import annotations

__all__ = [
    "_build_fix_description",
    "_build_review_description",
]


def _build_fix_description(
    *,
    file_path: str | None = None,
    file_content: str | None = None,
    rca_summary: str | None = None,
) -> str:
    """Builds the fix_task description string.

    Pure function — no crewai dependency. Testable in isolation.

    Args:
        file_path: Repository-relative path of the file to fix.
        file_content: Current content of the file fetched from the failed branch.
        rca_summary: RCA diagnosis text from the log-analyst (phase 1).
                     Injected so the fix-engineer has the ground truth even
                     when analyze_task ran in a separate Crew (B1 fix).

    Returns:
        Complete description string for fix_task.
    """
    # Real file context section (defect #2 fix)
    file_context_section = ""
    if file_path and file_content is not None:
        file_context_section = (
            f"\n\n=== CURRENT FILE CONTENT: {file_path} ===\n"
            f"{file_content}\n"
            f"=== END OF FILE CONTENT ===\n\n"
            "IMPORTANT: The file content above is the REAL current state of the file "
            "from the failed branch. Use it as the base for your fix — do NOT invent "
            "variable names, function signatures, or line numbers. Modify ONLY the "
            "lines necessary to resolve the root cause."
        )

    # B1: Inject RCA text so the fix-engineer works from the same ground truth
    # even when analyze_task ran in a separate Crew (phase 1).
    rca_context_section = ""
    if rca_summary:
        rca_context_section = (
            "\n\n=== ROOT CAUSE ANALYSIS (from log-analyst) ===\n"
            f"{rca_summary}\n"
            "=== END OF ROOT CAUSE ANALYSIS ===\n\n"
            "The RCA above is the authoritative diagnosis. Your patch MUST directly "
            "address the ROOT_CAUSE and SUGGESTED_ACTION identified there."
        )

    return (
        "Based on the diagnosis from the previous task, generate the minimum "
        "patch that resolves the problem.\n\n"
        f"{rca_context_section}\n"
        f"{file_context_section}\n\n"
        "MANDATORY RULES:\n"
        "1. The patch MUST NOT modify files on main or master branches.\n"
        "2. Include a JUSTIFICATION: section explaining why this change "
        "   resolves the root cause.\n"
        "3. If there is not enough information to generate a safe patch, "
        "   indicate PATCH_IMPOSSIBLE: with the reason.\n\n"
        "REQUIRED RESPONSE FORMAT — follow this exactly:\n"
        "FILE_PATH: <repository-relative path of the file you are fixing>\n"
        "<<<FILE_CONTENT>>>\n"
        "<complete corrected file content here — every line of the file>\n"
        "<<<END_FILE_CONTENT>>>\n"
        "JUSTIFICATION: <explanation of how this resolves the root cause>\n"
        "MODIFIED_FILES: <comma-separated list of files>\n\n"
        "Additionally include a display diff (for human review only — not for applying):\n"
        "```diff\n"
        "<unified diff showing the change>\n"
        "```\n\n"
        "CRITICAL: The <<<FILE_CONTENT>>> block must contain the COMPLETE file content, "
        "not just the changed lines. Modify ONLY the lines necessary for the fix."
    )


def _build_review_description(
    repo: str,
    *,
    rca_summary: str | None = None,
) -> str:
    """Builds the review_task description string.

    Pure function — no crewai dependency. Testable in isolation.

    Args:
        repo: Repository in 'org/repo' format.
        rca_summary: RCA diagnosis text from the log-analyst (phase 1).
                     When provided the reviewer is instructed to judge the patch
                     against the actual diagnosis (B1 fix).

    Returns:
        Complete description string for review_task.
    """
    # B1: Include the RCA so the reviewer judges the patch against the actual
    # diagnosis — not blindly. Critical in two-phase flow where analyze_task ran
    # in a separate Crew and is NOT in the CrewAI task-context chain for phase 2.
    rca_review_section = ""
    if rca_summary:
        rca_review_section = (
            f"\n\n=== ROOT CAUSE ANALYSIS (from log-analyst) ===\n"
            f"{rca_summary}\n"
            "=== END OF ROOT CAUSE ANALYSIS ===\n\n"
            "The RCA above is the ground truth. Verify that the patch in the previous "
            "task directly addresses the ROOT_CAUSE and SUGGESTED_ACTION listed there. "
            "A patch that does not match the diagnosed problem MUST be REJECTED.\n\n"
        )

    return (
        "Review the diagnosis and the patch generated in the previous tasks "
        f"for repository '{repo}'.\n"
        f"{rca_review_section}"
        "APPROVAL CRITERIA (all must be met):\n"
        "1. The patch effectively resolves the diagnosed root cause.\n"
        "2. The FILE_PATH is correct and matches what the log analyst identified.\n"
        "3. The <<<FILE_CONTENT>>> block contains the COMPLETE file (not just hunks).\n"
        "4. It does not introduce obvious security vulnerabilities.\n"
        "5. It does not modify critical configuration files without justification.\n"
        "6. The scope of the change is minimal (no unnecessary changes).\n"
        "7. It does not attempt to make changes directly on main or master.\n\n"
        "REJECTION CRITERIA (any one is sufficient):\n"
        "- The patch does not correspond to the diagnosed problem.\n"
        "- FILE_PATH is missing or wrong.\n"
        "- The <<<FILE_CONTENT>>> block is missing or incomplete.\n"
        "- It introduces security changes without sufficient context.\n"
        "- The scope is too broad (unrelated refactor).\n"
        "- The previous task marked PATCH_IMPOSSIBLE.\n\n"
        "MANDATORY RESPONSE FORMAT:\n"
        "First write your review analysis (max. 200 words).\n"
        "The LAST line of your response must be exactly one of:\n"
        "  VERDICT: APPLY\n"
        "  VERDICT: REJECT — <concise reason>"
    )
