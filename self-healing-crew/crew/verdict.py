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
