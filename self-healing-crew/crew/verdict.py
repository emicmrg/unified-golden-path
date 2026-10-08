"""
Pure functions for parsing the reviewer agent's output.

Separated from tasks.py so they can be imported without depending on crewai.
"""

from __future__ import annotations

import re


def parse_verdict(review_output: str) -> tuple[str, str]:
    """Extracts the structured verdict from the reviewer's output.

    Args:
        review_output: Full text of the review_task output.

    Returns:
        Tuple (verdict, reason) where verdict is 'APPLY' or 'REJECT'
        and reason is the reason (empty if APPLY).

    Raises:
        ValueError: If the verdict is not found in the expected format.
    """
    lines = review_output.strip().splitlines()

    # Search from the end upward (the verdict must be at the end)
    for line in reversed(lines):
        # Strip markdown emphasis characters (* and _) and whitespace
        stripped = line.strip().strip("*_").strip()

        # Case-insensitive prefix match for "VERDICT:"
        if not re.match(r"VERDICT:", stripped, re.IGNORECASE):
            continue

        rest = stripped[len("VERDICT:"):].strip()
        if rest.upper().startswith("APPLY"):
            return "APPLY", ""
        elif rest.upper().startswith("REJECT"):
            # Extract reason after "REJECT —" or "REJECT -"
            reason = rest[len("REJECT"):].lstrip(" \u2014-").strip()
            return "REJECT", reason
        else:
            raise ValueError(
                f"Unknown verdict on line: '{stripped}'. "
                "Expected 'APPLY' or 'REJECT'."
            )

    raise ValueError(
        "Neither 'VERDICT: APPLY' nor 'VERDICT: REJECT' was found "
        "in the reviewer output. "
        "Last 5 lines of output:\n"
        + "\n".join(lines[-5:])
    )


def extract_diff(fix_output: str) -> str | None:
    """Extracts the diff block from the fix_engineer's output.

    Args:
        fix_output: Full text of the fix_task output.

    Returns:
        The diff content (without the ```diff``` delimiters) or None
        if no diff block was found.
    """
    match = re.search(r"```diff\s*\n(.*?)\n```", fix_output, re.DOTALL)
    if match:
        return match.group(1).strip()
    return None


def extract_file_content(fix_output: str) -> tuple[str, str] | None:
    """Extracts the corrected file path and content from the fix_engineer's output.

    The fix-engineer is instructed to wrap the corrected file in markers:

        FILE_PATH: <path>
        <<<FILE_CONTENT>>>
        <complete file content here>
        <<<END_FILE_CONTENT>>>

    This function parses that format and returns (path, content).

    Args:
        fix_output: Full text of the fix_task output.

    Returns:
        Tuple (file_path, file_content) if the markers are found, None otherwise.
        file_content is the raw content between the markers, with leading/trailing
        newlines stripped.
    """
    # Extract FILE_PATH
    path_match = re.search(r"FILE_PATH:\s*(.+?)(?:\n|$)", fix_output)
    if not path_match:
        return None

    file_path = path_match.group(1).strip()
    if not file_path:
        return None

    # Extract content between <<<FILE_CONTENT>>> and <<<END_FILE_CONTENT>>>
    content_match = re.search(
        r"<<<FILE_CONTENT>>>\s*\n(.*?)\n<<<END_FILE_CONTENT>>>",
        fix_output,
        re.DOTALL,
    )
    if not content_match:
        return None

    file_content = content_match.group(1)
    # Strip only leading/trailing blank lines, not internal whitespace
    file_content = file_content.strip("\n")
    if not file_content:
        return None

    return file_path, file_content
