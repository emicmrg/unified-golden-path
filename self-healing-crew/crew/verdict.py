"""
Pure functions for parsing the reviewer agent's output.

Separated from tasks.py so they can be imported without depending on crewai.
"""

from __future__ import annotations

import re

# Sentinel values that indicate "no specific file" in the RCA output
_NO_FILE_SENTINELS = frozenset({"N/A", "NA", "UNKNOWN", "(MULTIPLE FILES)", "MULTIPLE FILES"})


def extract_file_path(analyze_output: str) -> str | None:
    """Extract the file path from a FILE: field in the log-analyst RCA output.

    Tolerates the many Markdown variations that LLMs produce:
      - List prefixes: ``-``, ``*``, ``1.``, ``2.`` etc.
      - Emphasis around the keyword: ``**FILE**:``, ``**FILE:**``, ``_FILE_:``
      - Backtick-quoted values: ``FILE: `sample-service/src/coldChain.ts```
      - Line-number suffix: ``FILE: path/to/file.ts:81``  → strips ``:81``

    Returns:
        The normalised file path, or ``None`` if:
        - No ``FILE:`` field is found.
        - The value is a sentinel like ``N/A``, ``NA``, ``UNKNOWN``,
          ``(multiple files)``, or empty after stripping.

    Examples::

        >>> extract_file_path("- FILE: sample-service/src/coldChain.ts")
        'sample-service/src/coldChain.ts'
        >>> extract_file_path("- **FILE**: sample-service/src/coldChain.ts")
        'sample-service/src/coldChain.ts'
        >>> extract_file_path("FILE: `sample-service/src/coldChain.ts`")
        'sample-service/src/coldChain.ts'
        >>> extract_file_path("FILE: sample-service/src/coldChain.ts:81")
        'sample-service/src/coldChain.ts'
        >>> extract_file_path("- FILE: N/A")  # returns None
        >>> extract_file_path("no file field here")  # returns None
    """
    # Pattern breakdown:
    #   ^[ \t]*           — optional leading whitespace (start of line)
    #   (?:[-*]|\d+[.)]) ? — optional list marker: -, *, 1. 2) etc.
    #   [ \t]*            — optional space after marker
    #   (?:[*_]{1,2})?    — optional opening emphasis (**, *, _, __)
    #   FILE              — literal keyword (case-insensitive via re.I)
    #   (?:[*_]{1,2})?    — optional closing emphasis
    #   :?                — optional colon that may be INSIDE the emphasis
    #   [ \t]*            — optional whitespace before the colon
    #   :                 — mandatory colon (when not inside the emphasis markers)
    #   [ \t]*            — optional whitespace after the colon
    #   (`?)              — optional opening backtick (group 1)
    #   (.+?)             — the raw path value (group 2)
    # Pattern: handles all real Markdown variants the LLM produces.
    #
    # The tricky case is "**FILE:**" where the colon is INSIDE the closing
    # emphasis markers.  We use two alternation branches, with the MORE
    # SPECIFIC branch first so the regex engine picks it when both could match:
    #
    #   Branch B (first) — colon INSIDE emphasis:  **FILE:**  or  _FILE:_
    #   Branch A (second) — colon OUTSIDE emphasis:  **FILE**:  or  FILE:
    #
    # Each branch then allows optional whitespace, an optional backtick pair,
    # and captures the path value.
    pattern = re.compile(
        r"(?:^|(?<=\n))"                      # line start (zero-width)
        r"[ \t]*"                              # optional indent
        r"(?:[-*]|\d+[.)])?[ \t]*"            # optional list marker
        r"(?:"
            # Branch B (specific): colon INSIDE the closing emphasis
            # e.g. **FILE:** or _FILE:_
            r"(?:[*_]{1,2})FILE:(?:[*_]{1,2})"
            r"|"
            # Branch A (generic): colon OUTSIDE emphasis
            # e.g. **FILE**: or _FILE_: or plain FILE:
            r"(?:[*_]{1,2})?FILE(?:[*_]{1,2})?[ \t]*:"
        r")"
        r"[ \t]*"                              # optional space after colon
        r"(`?)"                                # group 1: optional opening backtick
        r"(.+?)"                               # group 2: raw path value (non-greedy)
        r"\1"                                  # matching closing backtick
        r"[ \t]*(?:$|\n)",                     # end of line
        re.IGNORECASE | re.MULTILINE,
    )

    m = pattern.search(analyze_output)
    if not m:
        return None

    raw_value = m.group(2).strip()
    if not raw_value:
        return None

    # Strip a trailing :<number> or :<number>-<number> line-reference suffix.
    # We only strip a purely numeric suffix so we don't mangle paths that
    # legitimately contain colons (rare but possible in URL-like paths).
    path_candidate = re.sub(r":\d[\d\-]*$", "", raw_value)

    # Reject sentinel values
    if path_candidate.upper() in _NO_FILE_SENTINELS:
        return None

    # Reject parenthesised values like "(multiple files)" — starts with "("
    if path_candidate.startswith("("):
        return None

    # A plausible file path must contain at least one "/" or "."
    if "/" not in path_candidate and "." not in path_candidate:
        return None

    return path_candidate


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
