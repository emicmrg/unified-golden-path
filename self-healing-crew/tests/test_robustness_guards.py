"""
Robustness and security guard tests.

Covers the refinements added after the initial implementation:

  N1 — APPLY with no applicable file content → return 1 (hard failure).
       The old guard only fired when BOTH apply_file_path and diff_content
       were absent; the new guard fires whenever apply_file_path or
       apply_file_content is None after an APPLY verdict.
       Tests verify via:
         (a) extract_file_content behaviour (unit)
         (b) the decision logic in _apply_guard_returns_1() (integration-lite)

  N2 — PATCH_IMPOSSIBLE in fix-engineer output → return 1 regardless of
       reviewer verdict. Ensures the code-level safety net works even when
       the LLM reviewer hallucinates APPLY.

  B1 — build_tasks passes rca_summary into fix_task and review_task
       descriptions so the reviewer judges the patch against the actual
       diagnosis in the two-phase flow.
       Tests use crew.task_descriptions (pure module, no crewai dependency).

Strategy for N1/N2 integration tests:
  crew.main imports crewai at module level, which requires pkg_resources.
  We inject a lightweight crewai stub into sys.modules BEFORE importing
  crew.main so the import succeeds in the test environment.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


# ─── crewai stub (no pkg_resources needed) ───────────────────────────────────
# We create a minimal crewai stub and inject it into sys.modules before any
# import of crew.main or crew.tasks.  This is the same technique used when
# testing code that conditionally imports heavy optional dependencies.

def _install_crewai_stub() -> None:
    """Installs a minimal crewai stub into sys.modules if crewai is not importable."""
    if "crewai" in sys.modules:
        return  # already present (real or stub)

    # Build a stub package hierarchy
    crewai_stub = types.ModuleType("crewai")

    class _FakeTask:
        def __init__(self, description="", expected_output="", agent=None, context=None):
            self.description = description
            self.expected_output = expected_output
            self.agent = agent
            self.context = context or []
            self.output = None

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeLLM:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeProcess:
        sequential = "sequential"

    class _FakeCrew:
        def __init__(self, agents=None, tasks=None, process=None, verbose=False):
            self.agents = agents or []
            self.tasks = tasks or []

        def kickoff(self):
            return ""

    crewai_stub.Task = _FakeTask
    crewai_stub.Agent = _FakeAgent
    crewai_stub.LLM = _FakeLLM
    crewai_stub.Process = _FakeProcess
    crewai_stub.Crew = _FakeCrew

    sys.modules["crewai"] = crewai_stub
    # crewai sub-modules that may be referenced
    for sub in ["crewai.agent", "crewai.task", "crewai.crew", "crewai.process"]:
        sys.modules[sub] = crewai_stub


_install_crewai_stub()

# Now it is safe to import crew modules that depend on crewai
import crew.main  # noqa: E402  (import after sys.modules manipulation)
from crew.task_descriptions import (  # noqa: E402
    _build_fix_description,
    _build_review_description,
)
from crew.verdict import extract_file_content  # noqa: E402


# ─── Fixture helpers ─────────────────────────────────────────────────────────

_MINIMAL_RCA = (
    "- ERROR_TYPE: TypeError\n"
    "- FILE: sample-service/src/coldChain.ts\n"
    "- ROOT_CAUSE: wrong return type\n"
    "- CONTEXT: TypeError: string is not assignable to number\n"
    "- SUGGESTED_ACTION: fix return type annotation\n"
)

_VALID_FIX_OUTPUT = (
    "FILE_PATH: sample-service/src/coldChain.ts\n"
    "<<<FILE_CONTENT>>>\n"
    "const x: number = 1;\n"
    "<<<END_FILE_CONTENT>>>\n"
    "JUSTIFICATION: Fixes the return type.\n"
    "MODIFIED_FILES: sample-service/src/coldChain.ts\n"
)

_PATCH_IMPOSSIBLE_OUTPUT = (
    "PATCH_IMPOSSIBLE: Not enough context to determine a safe fix.\n"
    "The root cause points to an external service dependency.\n"
)

_APPLY_VERDICT_OUTPUT = "Patch looks correct.\nVERDICT: APPLY"


def _make_task_output(raw: str) -> SimpleNamespace:
    return SimpleNamespace(raw=raw)


def _make_mock_task(raw: str) -> MagicMock:
    task = MagicMock()
    task.output = _make_task_output(raw)
    return task


def _make_settings() -> MagicMock:
    settings = MagicMock()
    settings.github_repo = "org/repo"
    settings.ddb_table_name = "ugp-test"
    settings.max_attempts = 3
    settings.aws_region = "us-east-1"
    settings.github_token_secret_arn = "arn:aws:secretsmanager:us-east-1:123:secret/tok"
    return settings


def _make_cb() -> MagicMock:
    cb = MagicMock()
    cb.is_escalated.return_value = False
    attempt_result = SimpleNamespace(allowed=True, attempt_number=1, max_attempts=3)
    cb.check_and_increment.return_value = attempt_result
    return cb


def _invoke_run(
    fix_output_raw: str,
    review_output_raw: str = _APPLY_VERDICT_OUTPUT,
) -> int:
    """Runs crew.main.run() with all external dependencies mocked."""
    analyze_task_mock = _make_mock_task(_MINIMAL_RCA)
    fix_task_mock = _make_mock_task(fix_output_raw)
    review_task_mock = _make_mock_task(review_output_raw)

    with (
        patch("crew.main.get_settings", return_value=_make_settings()),
        patch("crew.main.CircuitBreaker", return_value=_make_cb()),
        patch("crew.main.get_github_token", return_value="ghp_test"),
        patch("crew.main.fetch_ci_log", return_value="some ci log"),
        patch(
            "crew.main.build_tasks",
            side_effect=[
                # Phase 1 call: analyze only
                (analyze_task_mock, MagicMock(), MagicMock()),
                # Phase 2 call: fix + review
                (MagicMock(), fix_task_mock, review_task_mock),
            ],
        ),
        patch(
            "crew.main.build_agents",
            return_value=(MagicMock(), MagicMock(), MagicMock()),
        ),
        patch("crew.main.Crew") as mock_crew_cls,
        patch("crew.main.fetch_file_content", return_value="old content"),
        patch(
            "crew.main.create_branch_and_commit",
            return_value="fix/selfheal-run-42-1",
        ),
        patch(
            "crew.main.open_pull_request",
            return_value="https://github.com/org/repo/pull/1",
        ),
    ):
        crew_instance = MagicMock()
        crew_instance.kickoff.return_value = review_output_raw
        mock_crew_cls.return_value = crew_instance

        return crew.main.run(["--run-id", "run-42"])


# ─── N1a: extract_file_content behaviour (unit) ──────────────────────────────


class TestN1ExtractFileContentBehaviour:
    """N1 unit: extract_file_content returns None when the block is absent.

    The N1 guard in main.py fires when extract_file_content returns None,
    so we verify the extraction contract here.
    """

    def test_returns_none_when_no_file_content_block(self) -> None:
        """No <<<FILE_CONTENT>>> block → extract_file_content returns None."""
        fix_output = (
            "JUSTIFICATION: Fix applied.\n"
            "```diff\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y\n```\n"
        )
        assert extract_file_content(fix_output) is None

    def test_returns_none_for_empty_output(self) -> None:
        """Empty output → returns None."""
        assert extract_file_content("") is None

    def test_returns_tuple_when_block_present(self) -> None:
        """Valid FILE_CONTENT block → returns (path, content)."""
        result = extract_file_content(_VALID_FIX_OUTPUT)
        assert result is not None
        path, content = result
        assert path == "sample-service/src/coldChain.ts"
        assert "const x: number = 1;" in content


# ─── N1b: integration — APPLY with no file content block → return 1 ──────────


class TestN1IntegrationGuard:
    """N1 integration: run() returns 1 when reviewer says APPLY but no FILE_CONTENT."""

    def test_apply_with_no_file_content_block_returns_1(self) -> None:
        """APPLY + no <<<FILE_CONTENT>>> block → run() must return 1."""
        fix_output_no_block = (
            "The patch should be applied.\n"
            "JUSTIFICATION: Fixes the type.\n"
            "```diff\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y\n```\n"
        )
        assert _invoke_run(fix_output_raw=fix_output_no_block) == 1

    def test_apply_with_empty_fix_output_returns_1(self) -> None:
        """APPLY + empty fix output → run() must return 1."""
        assert _invoke_run(fix_output_raw="") == 1

    def test_apply_with_valid_file_content_proceeds(self) -> None:
        """APPLY + valid FILE_CONTENT block → N1 guard must NOT fire → exit 0."""
        assert _invoke_run(fix_output_raw=_VALID_FIX_OUTPUT) == 0

    def test_n1_fires_before_branch_creation(self) -> None:
        """When N1 fires, create_branch_and_commit must NOT be called."""
        fix_output_no_block = "JUSTIFICATION: something.\n```diff\n+x = 1\n```\n"

        with (
            patch("crew.main.get_settings", return_value=_make_settings()),
            patch("crew.main.CircuitBreaker", return_value=_make_cb()),
            patch("crew.main.get_github_token", return_value="ghp_test"),
            patch("crew.main.fetch_ci_log", return_value="log"),
            patch(
                "crew.main.build_tasks",
                side_effect=[
                    (_make_mock_task(_MINIMAL_RCA), MagicMock(), MagicMock()),
                    (
                        MagicMock(),
                        _make_mock_task(fix_output_no_block),
                        _make_mock_task(_APPLY_VERDICT_OUTPUT),
                    ),
                ],
            ),
            patch(
                "crew.main.build_agents",
                return_value=(MagicMock(), MagicMock(), MagicMock()),
            ),
            patch("crew.main.Crew") as mock_crew_cls,
            patch("crew.main.fetch_file_content", return_value="old"),
            patch("crew.main.create_branch_and_commit") as mock_create,
            patch("crew.main.open_pull_request") as mock_pr,
        ):
            mock_crew_cls.return_value.kickoff.return_value = _APPLY_VERDICT_OUTPUT
            crew.main.run(["--run-id", "run-42"])

        mock_create.assert_not_called()
        mock_pr.assert_not_called()


# ─── N2: PATCH_IMPOSSIBLE detection (unit + integration) ─────────────────────


class TestN2PatchImpossibleUnit:
    """N2 unit: the substring detection works as expected."""

    @pytest.mark.parametrize(
        "text",
        [
            "PATCH_IMPOSSIBLE: no context.",
            "Analysis done.\nPATCH_IMPOSSIBLE: external dep.\n",
            "PATCH_IMPOSSIBLE:",  # keyword without reason
        ],
    )
    def test_patch_impossible_detected(self, text: str) -> None:
        """'PATCH_IMPOSSIBLE' substring must be present in the given outputs."""
        assert "PATCH_IMPOSSIBLE" in text

    def test_partial_match_not_detected(self) -> None:
        """Text containing 'PATCH' but not 'PATCH_IMPOSSIBLE' is safe."""
        text = "This patch is perfectly valid.\nFILE_PATH: src/foo.ts"
        assert "PATCH_IMPOSSIBLE" not in text

    def test_lowercase_not_detected(self) -> None:
        """Lowercase 'patch_impossible' is not matched (keyword is all-caps by design)."""
        text = "patch_impossible: something weird"
        assert "PATCH_IMPOSSIBLE" not in text


class TestN2PatchImpossibleIntegration:
    """N2 integration: run() returns 1 when fix output contains PATCH_IMPOSSIBLE."""

    def test_patch_impossible_returns_1(self) -> None:
        """PATCH_IMPOSSIBLE in fix output → return 1 even with APPLY verdict."""
        assert _invoke_run(fix_output_raw=_PATCH_IMPOSSIBLE_OUTPUT) == 1

    def test_patch_impossible_with_reason_returns_1(self) -> None:
        """PATCH_IMPOSSIBLE with a long reason → return 1."""
        fix_output = (
            "PATCH_IMPOSSIBLE: The failure originates in an external dependency "
            "not present in this repository.\n"
        )
        assert _invoke_run(fix_output_raw=fix_output) == 1

    def test_patch_impossible_blocks_branch_creation(self) -> None:
        """When N2 fires, create_branch_and_commit must NOT be called."""
        with (
            patch("crew.main.get_settings", return_value=_make_settings()),
            patch("crew.main.CircuitBreaker", return_value=_make_cb()),
            patch("crew.main.get_github_token", return_value="ghp_test"),
            patch("crew.main.fetch_ci_log", return_value="log"),
            patch(
                "crew.main.build_tasks",
                side_effect=[
                    (_make_mock_task(_MINIMAL_RCA), MagicMock(), MagicMock()),
                    (
                        MagicMock(),
                        _make_mock_task(_PATCH_IMPOSSIBLE_OUTPUT),
                        _make_mock_task(_APPLY_VERDICT_OUTPUT),
                    ),
                ],
            ),
            patch(
                "crew.main.build_agents",
                return_value=(MagicMock(), MagicMock(), MagicMock()),
            ),
            patch("crew.main.Crew") as mock_crew_cls,
            patch("crew.main.fetch_file_content", return_value="old"),
            patch("crew.main.create_branch_and_commit") as mock_create,
            patch("crew.main.open_pull_request") as mock_pr,
        ):
            mock_crew_cls.return_value.kickoff.return_value = _APPLY_VERDICT_OUTPUT
            crew.main.run(["--run-id", "run-42"])

        mock_create.assert_not_called()
        mock_pr.assert_not_called()

    def test_no_patch_impossible_does_not_trigger_guard(self) -> None:
        """Without PATCH_IMPOSSIBLE the N2 guard must not fire → exit 0."""
        assert _invoke_run(fix_output_raw=_VALID_FIX_OUTPUT) == 0

    def test_partial_patch_text_does_not_trigger(self) -> None:
        """Text containing 'PATCH' but not 'PATCH_IMPOSSIBLE' must not trigger N2.

        The fix path MUST match the FILE field in _MINIMAL_RCA so that the D2
        path-existence guard does not fire independently of the N2 check.
        """
        fix_output = (
            "FILE_PATH: sample-service/src/coldChain.ts\n"
            "<<<FILE_CONTENT>>>\nconst x = 1;\n<<<END_FILE_CONTENT>>>\n"
            "JUSTIFICATION: This patch is not impossible.\n"
            "MODIFIED_FILES: sample-service/src/coldChain.ts\n"
        )
        assert _invoke_run(fix_output_raw=fix_output) == 0


# ─── B1: RCA injected into task descriptions ─────────────────────────────────
# Uses crew.task_descriptions (pure module, no crewai / pkg_resources needed).


class TestB1RcaInjectedIntoDescriptions:
    """B1: _build_fix_description and _build_review_description inject rca_summary."""

    def test_rca_in_fix_description_when_provided(self) -> None:
        rca = "- ROOT_CAUSE: wrong return type\n- SUGGESTED_ACTION: fix annotation"
        desc = _build_fix_description(rca_summary=rca)
        assert "ROOT_CAUSE: wrong return type" in desc

    def test_rca_in_review_description_when_provided(self) -> None:
        rca = "- ROOT_CAUSE: wrong return type\n- SUGGESTED_ACTION: fix annotation"
        desc = _build_review_description("org/repo", rca_summary=rca)
        assert "ROOT_CAUSE: wrong return type" in desc

    def test_rca_section_header_in_fix_description(self) -> None:
        desc = _build_fix_description(rca_summary="- ROOT_CAUSE: null pointer")
        assert "ROOT CAUSE ANALYSIS" in desc

    def test_rca_section_header_in_review_description(self) -> None:
        desc = _build_review_description("org/repo", rca_summary="- ROOT_CAUSE: null pointer")
        assert "ROOT CAUSE ANALYSIS" in desc

    def test_rca_not_injected_in_fix_when_none(self) -> None:
        desc = _build_fix_description(rca_summary=None)
        assert "ROOT CAUSE ANALYSIS" not in desc

    def test_rca_not_injected_in_review_when_none(self) -> None:
        desc = _build_review_description("org/repo", rca_summary=None)
        assert "ROOT CAUSE ANALYSIS" not in desc

    def test_rca_not_injected_when_empty_string(self) -> None:
        assert "ROOT CAUSE ANALYSIS" not in _build_fix_description(rca_summary="")
        assert "ROOT CAUSE ANALYSIS" not in _build_review_description("org/repo", rca_summary="")

    def test_review_description_instructs_ground_truth(self) -> None:
        rca = "- ROOT_CAUSE: missing null check"
        desc = _build_review_description("org/repo", rca_summary=rca)
        assert "ground truth" in desc.lower() or "authoritative" in desc.lower()

    def test_fix_description_instructs_authoritative(self) -> None:
        rca = "- ROOT_CAUSE: wrong type"
        desc = _build_fix_description(rca_summary=rca)
        assert "authoritative" in desc.lower()

    def test_fix_description_without_rca_still_valid(self) -> None:
        desc = _build_fix_description()
        assert "PATCH_IMPOSSIBLE" in desc
        assert "FILE_PATH" in desc

    def test_review_description_without_rca_still_valid(self) -> None:
        desc = _build_review_description("org/repo")
        assert "VERDICT" in desc
        assert "APPLY" in desc

    def test_rca_text_verbatim_in_fix_description(self) -> None:
        """The exact rca_summary text must appear verbatim in fix description."""
        rca = "UNIQUE_MARKER_12345: test value"
        desc = _build_fix_description(rca_summary=rca)
        assert "UNIQUE_MARKER_12345: test value" in desc

    def test_rca_text_verbatim_in_review_description(self) -> None:
        """The exact rca_summary text must appear verbatim in review description."""
        rca = "UNIQUE_MARKER_67890: another test"
        desc = _build_review_description("org/repo", rca_summary=rca)
        assert "UNIQUE_MARKER_67890: another test" in desc


# ─── #9: No FILE in RCA → fail-closed (regression test for field-mode flaw) ──


# RCA sin campo FILE (el log-analyst no identificó un archivo concreto).
# Reproduce el escenario de campo real: un diagnóstico ambiguo donde el
# log-analyst emite N/A o directamente omite el campo FILE.
_RCA_WITHOUT_FILE = (
    "- ERROR_TYPE: TypeError\n"
    "- FILE: N/A\n"
    "- ROOT_CAUSE: unresolved external dependency\n"
    "- CONTEXT: Cannot determine the exact source file\n"
    "- SUGGESTED_ACTION: manual investigation required\n"
)

# El fix-engineer alucina un FILE_PATH (aunque no fue provisto en el contexto).
_HALLUCINATED_FIX_OUTPUT = (
    "FILE_PATH: sample-service/src/hallucinated.ts\n"
    "<<<FILE_CONTENT>>>\n"
    "const x: number = 42;\n"
    "<<<END_FILE_CONTENT>>>\n"
    "JUSTIFICATION: Fixes the issue by changing x to 42.\n"
    "MODIFIED_FILES: sample-service/src/hallucinated.ts\n"
)

# El reviewer alucina APPLY (en lugar de rechazar correctamente).
_HALLUCINATED_APPLY_VERDICT = "Patch looks fine to me.\nVERDICT: APPLY"


class TestNoFileInRcaFailClosed:
    """#9 regression: RCA sin FILE → file_path_for_fix=None → exit==1 y sin commit.

    Reproduce el fallo de producción exacto:
      1. RCA sin campo FILE concreto (o con FILE: N/A) → extract_file_path devuelve None.
      2. El fix-engineer devuelve un FILE_PATH inventado.
      3. El reviewer alucina APPLY.
      4. El resultado DEBE ser exit==1 y create_branch_and_commit NO debe llamarse.
    """

    def _invoke_no_file_rca(
        self,
        rca_raw: str = _RCA_WITHOUT_FILE,
        fix_raw: str = _HALLUCINATED_FIX_OUTPUT,
        review_raw: str = _HALLUCINATED_APPLY_VERDICT,
    ) -> tuple[int, MagicMock]:
        """Runs crew.main.run() with a no-FILE RCA and returns (exit_code, mock_create)."""
        analyze_task_mock = _make_mock_task(rca_raw)
        fix_task_mock = _make_mock_task(fix_raw)
        review_task_mock = _make_mock_task(review_raw)

        with (
            patch("crew.main.get_settings", return_value=_make_settings()),
            patch("crew.main.CircuitBreaker", return_value=_make_cb()),
            patch("crew.main.get_github_token", return_value="ghp_test"),
            patch("crew.main.fetch_ci_log", return_value="some ci log"),
            patch(
                "crew.main.build_tasks",
                side_effect=[
                    # Phase 1: analyze only
                    (analyze_task_mock, MagicMock(), MagicMock()),
                    # Phase 2: fix + review
                    (MagicMock(), fix_task_mock, review_task_mock),
                ],
            ),
            patch(
                "crew.main.build_agents",
                return_value=(MagicMock(), MagicMock(), MagicMock()),
            ),
            patch("crew.main.Crew") as mock_crew_cls,
            patch("crew.main.fetch_file_content", return_value="old content"),
            patch("crew.main.create_branch_and_commit") as mock_create,
            patch("crew.main.open_pull_request") as mock_pr,
        ):
            mock_crew_cls.return_value.kickoff.return_value = review_raw
            exit_code = crew.main.run(["--run-id", "run-99"])

        return exit_code, mock_create

    def test_no_file_in_rca_returns_1(self) -> None:
        """RCA con FILE: N/A → file_path_for_fix=None → run() must return 1."""
        exit_code, _ = self._invoke_no_file_rca()
        assert exit_code == 1

    def test_no_file_in_rca_create_branch_not_called(self) -> None:
        """RCA con FILE: N/A → create_branch_and_commit must NOT be called."""
        _, mock_create = self._invoke_no_file_rca()
        mock_create.assert_not_called()

    def test_rca_missing_file_field_entirely_returns_1(self) -> None:
        """RCA without any FILE field → file_path_for_fix=None → run() must return 1."""
        rca_no_file_field = (
            "- ERROR_TYPE: TypeError\n"
            "- ROOT_CAUSE: unresolved external dependency\n"
            "- CONTEXT: Cannot determine the exact source file\n"
            "- SUGGESTED_ACTION: manual investigation required\n"
        )
        exit_code, mock_create = self._invoke_no_file_rca(rca_raw=rca_no_file_field)
        assert exit_code == 1
        mock_create.assert_not_called()

    def test_rca_file_na_variant_returns_1(self) -> None:
        """RCA with 'FILE: NA' (no slash) → file_path_for_fix=None → run() must return 1."""
        rca_na_variant = (
            "- ERROR_TYPE: ValueError\n"
            "- FILE: NA\n"
            "- ROOT_CAUSE: bad config\n"
            "- CONTEXT: multiple files involved\n"
            "- SUGGESTED_ACTION: manual review\n"
        )
        exit_code, mock_create = self._invoke_no_file_rca(rca_raw=rca_na_variant)
        assert exit_code == 1
        mock_create.assert_not_called()

    def test_rca_with_concrete_file_proceeds_normally(self) -> None:
        """Sanity check: RCA with a concrete FILE must NOT trigger the #9 guard."""
        # _MINIMAL_RCA has FILE: sample-service/src/coldChain.ts → should exit 0
        exit_code, _ = self._invoke_no_file_rca(
            rca_raw=_MINIMAL_RCA,
            fix_raw=_VALID_FIX_OUTPUT,
            review_raw=_APPLY_VERDICT_OUTPUT,
        )
        assert exit_code == 0
