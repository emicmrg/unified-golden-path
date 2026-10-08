"""
Tests for the two defects found in the first real end-to-end dry run:

Defect P1 — The log-analyst emitted a FILE field containing PROSE and TWO
    paths:
        "- FILE: src/__tests__/coldChain.test.ts:31 and
           src/__tests__/coldChain.test.ts:131 (test failures indicating ...)"
    The old parser returned the whole sentence, which produced a 404 against
    the GitHub contents API and lost the real file content.

Defect P2 — Monorepo CI logs print PACKAGE-relative paths ('src/coldChain.ts')
    while the real repository path is 'sample-service/src/coldChain.ts'. The
    crew had no way to bridge the two, so every fetch 404'd.

``resolve_repo_path`` fixes P2 deterministically (no LLM) by matching against
the real git tree, and refuses to guess when the match is ambiguous.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from crew.tools import resolve_repo_path
from crew.verdict import extract_file_path


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_gh(paths: list[str], *, types: dict[str, str] | None = None) -> MagicMock:
    """Builds a Github client mock whose git tree contains ``paths``."""
    types = types or {}
    elements = []
    for p in paths:
        el = MagicMock()
        el.path = p
        el.type = types.get(p, "blob")
        elements.append(el)

    tree = MagicMock()
    tree.tree = elements

    repo = MagicMock()
    repo.get_branch.return_value.commit.sha = "deadbeef"
    repo.get_git_tree.return_value = tree

    gh = MagicMock()
    gh.get_repo.return_value = repo
    return gh


_REPO_TREE = [
    "sample-service/src/coldChain.ts",
    "sample-service/src/__tests__/coldChain.test.ts",
    "sample-service/package.json",
    "web-dashboard/src/App.tsx",
    "infra/src/app.ts",
]


# ─── Defect P1: FILE field containing prose / multiple paths ─────────────────


class TestFileFieldWithProse:
    """extract_file_path must return ONLY the first path-like token."""

    def test_exact_regression_from_production_run(self):
        """The literal RCA line that broke the first real dry run."""
        rca = (
            "- ERROR_TYPE: TestFailure\n"
            "- FILE: src/__tests__/coldChain.test.ts:31 and "
            "src/__tests__/coldChain.test.ts:131 (test failures indicating "
            "implementation bug in the source code being tested)\n"
            "- ROOT_CAUSE: boundary excluded\n"
        )
        assert extract_file_path(rca) == "src/__tests__/coldChain.test.ts"

    def test_two_paths_joined_by_and_returns_first(self):
        rca = "- FILE: a/b/first.ts and a/b/second.ts\n"
        assert extract_file_path(rca) == "a/b/first.ts"

    def test_trailing_parenthetical_prose_is_stripped(self):
        rca = "- FILE: sample-service/src/coldChain.ts (the implementation file)\n"
        assert extract_file_path(rca) == "sample-service/src/coldChain.ts"

    def test_leading_prose_before_path_is_skipped(self):
        rca = "- FILE: probably sample-service/src/coldChain.ts\n"
        assert extract_file_path(rca) == "sample-service/src/coldChain.ts"

    def test_line_range_suffix_is_stripped(self):
        rca = "- FILE: sample-service/src/coldChain.ts:81-85\n"
        assert extract_file_path(rca) == "sample-service/src/coldChain.ts"

    def test_prose_only_value_returns_none(self):
        rca = "- FILE: multiple files across the repository\n"
        assert extract_file_path(rca) is None

    def test_na_sentinel_still_returns_none(self):
        assert extract_file_path("- FILE: N/A\n") is None

    def test_parenthesised_sentinel_returns_none(self):
        assert extract_file_path("- FILE: (multiple files)\n") is None

    def test_backticked_path_with_prose(self):
        rca = "- FILE: `sample-service/src/coldChain.ts` — line 85\n"
        assert extract_file_path(rca) == "sample-service/src/coldChain.ts"

    def test_markdown_emphasis_with_prose(self):
        rca = "- **FILE:** src/coldChain.ts:85 (off-by-one in comparison)\n"
        assert extract_file_path(rca) == "src/coldChain.ts"


# ─── Defect P2: package-relative -> repository-relative resolution ───────────


class TestResolveRepoPath:
    def test_exact_match_returned_unchanged(self):
        gh = _make_gh(_REPO_TREE)
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="sample-service/src/coldChain.ts",
                ref="main",
                github_client=gh,
            )
            == "sample-service/src/coldChain.ts"
        )

    def test_package_relative_path_is_resolved(self):
        """The core P2 regression: 'src/coldChain.ts' -> full path."""
        gh = _make_gh(_REPO_TREE)
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="src/coldChain.ts",
                ref="main",
                github_client=gh,
            )
            == "sample-service/src/coldChain.ts"
        )

    def test_basename_only_is_resolved_when_unique(self):
        gh = _make_gh(_REPO_TREE)
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="coldChain.ts",
                ref="main",
                github_client=gh,
            )
            == "sample-service/src/coldChain.ts"
        )

    def test_ambiguous_suffix_returns_none(self):
        """Two packages with the same relative path -> refuse to guess."""
        gh = _make_gh(
            [
                "service-a/src/index.ts",
                "service-b/src/index.ts",
            ]
        )
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="src/index.ts",
                ref="main",
                github_client=gh,
            )
            is None
        )

    def test_ambiguous_basename_returns_none(self):
        gh = _make_gh(["a/util.ts", "b/util.ts"])
        assert (
            resolve_repo_path(
                repo="o/r", token="t", path="util.ts", ref="main", github_client=gh
            )
            is None
        )

    def test_nonexistent_path_returns_none(self):
        gh = _make_gh(_REPO_TREE)
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="does/not/Exist.ts",
                ref="main",
                github_client=gh,
            )
            is None
        )

    def test_suffix_match_is_segment_aligned(self):
        """'src/chain.ts' must NOT suffix-match 'pkg/notsrc/chain.ts'.

        The basename fallback is deliberately defeated here (two files share
        the basename) so this test isolates the suffix stage.
        """
        gh = _make_gh(["pkg/notsrc/chain.ts", "other/deep/chain.ts"])
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="src/chain.ts",
                ref="main",
                github_client=gh,
            )
            is None
        )

    def test_basename_fallback_is_last_resort_only(self):
        """When no segment-aligned suffix matches, a unique basename wins.

        This is intentional recall: the D2 guard in main.py still verifies the
        resolved path exists on the base branch before anything is committed.
        """
        gh = _make_gh(["pkg/notsrc/chain.ts"])
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="src/chain.ts",
                ref="main",
                github_client=gh,
            )
            == "pkg/notsrc/chain.ts"
        )

    def test_leading_dot_slash_is_normalised(self):
        gh = _make_gh(_REPO_TREE)
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="./src/coldChain.ts",
                ref="main",
                github_client=gh,
            )
            == "sample-service/src/coldChain.ts"
        )

    def test_tree_entries_that_are_not_blobs_are_ignored(self):
        gh = _make_gh(
            ["sample-service/src", "sample-service/src/coldChain.ts"],
            types={"sample-service/src": "tree"},
        )
        assert (
            resolve_repo_path(
                repo="o/r",
                token="t",
                path="src/coldChain.ts",
                ref="main",
                github_client=gh,
            )
            == "sample-service/src/coldChain.ts"
        )

    def test_api_failure_returns_none_instead_of_raising(self):
        gh = MagicMock()
        gh.get_repo.side_effect = RuntimeError("boom")
        assert (
            resolve_repo_path(
                repo="o/r", token="t", path="x.ts", ref="main", github_client=gh
            )
            is None
        )

    def test_empty_path_returns_none(self):
        gh = _make_gh(_REPO_TREE)
        assert (
            resolve_repo_path(
                repo="o/r", token="t", path="   ", ref="main", github_client=gh
            )
            is None
        )
