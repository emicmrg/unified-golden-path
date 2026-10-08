"""
Unit tests for ``crew.verdict.extract_file_path`` and the D2 path-existence
guard added to ``crew.main``.

Defect 1 (core) — Robust FILE field extraction
================================================
Covers ALL real Markdown formats the LLM produces, plus sentinel values and
edge cases that must return ``None``.

Defect 2 (guard) — Deterministic path-existence barrier
=========================================================
Verifies that ``crew.main.run()`` returns 1 (without creating a branch)
when the fix-engineer targets a file that does not exist on the base branch,
and when the fix-engineer path differs from the RCA-extracted path.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from crew.verdict import extract_file_path

# ─── crewai stub (same as in test_robustness_guards.py) ──────────────────────

def _install_crewai_stub() -> None:
    if "crewai" in sys.modules:
        return

    crewai_stub = types.ModuleType("crewai")

    class _FakeTask:
        def __init__(self, description="", expected_output="", agent=None, context=None):
            self.description = description
            self.expected_output = expected_output
            self.agent = agent
            self.context = context or []
            self.output = None

    class _FakeAgent:
        def __init__(self, *args, **kwargs): pass

    class _FakeLLM:
        def __init__(self, *args, **kwargs): pass

    class _FakeProcess:
        sequential = "sequential"

    class _FakeCrew:
        def __init__(self, agents=None, tasks=None, process=None, verbose=False):
            self.agents = agents or []
            self.tasks = tasks or []
        def kickoff(self): return ""

    crewai_stub.Task = _FakeTask
    crewai_stub.Agent = _FakeAgent
    crewai_stub.LLM = _FakeLLM
    crewai_stub.Process = _FakeProcess
    crewai_stub.Crew = _FakeCrew

    sys.modules["crewai"] = crewai_stub
    for sub in ["crewai.agent", "crewai.task", "crewai.crew", "crewai.process"]:
        sys.modules[sub] = crewai_stub


_install_crewai_stub()

import crew.main  # noqa: E402 (after sys.modules manipulation)

# ═══════════════════════════════════════════════════════════════════════════════
# DEFECTO 1 — extract_file_path: tabla de formatos Markdown
# ═══════════════════════════════════════════════════════════════════════════════


class TestExtractFilePathMarkdownFormats:
    """Verifica todos los formatos reales que el LLM emite para el campo FILE."""

    # ── Formatos que DEBEN matchear ────────────────────────────────────────────

    @pytest.mark.parametrize(
        "rca_line, expected",
        [
            # Plano (ya funcionaba)
            (
                "- FILE: sample-service/src/coldChain.ts",
                "sample-service/src/coldChain.ts",
            ),
            # Énfasis en la clave: **FILE**:
            (
                "- **FILE**: sample-service/src/coldChain.ts",
                "sample-service/src/coldChain.ts",
            ),
            # Énfasis + colon dentro: **FILE:**
            (
                "- **FILE:** sample-service/src/coldChain.ts",
                "sample-service/src/coldChain.ts",
            ),
            # Marcador * en vez de -
            (
                "* FILE: sample-service/src/coldChain.ts",
                "sample-service/src/coldChain.ts",
            ),
            # Marcador numérico
            (
                "2. FILE: sample-service/src/coldChain.ts",
                "sample-service/src/coldChain.ts",
            ),
            # Valor entre backticks (deben removerse)
            (
                "FILE: `sample-service/src/coldChain.ts`",
                "sample-service/src/coldChain.ts",
            ),
            # Con sufijo :línea (debe quedar sólo el path)
            (
                "FILE: sample-service/src/coldChain.ts:81",
                "sample-service/src/coldChain.ts",
            ),
        ],
    )
    def test_formatos_que_deben_matchear(self, rca_line: str, expected: str) -> None:
        """Todos los formatos reales de producción deben extraer el path correcto."""
        result = extract_file_path(rca_line + "\n")
        assert result == expected, (
            f"Formato '{rca_line!r}' → esperado {expected!r}, obtenido {result!r}"
        )

    # ── Formatos que deben dar None ────────────────────────────────────────────

    @pytest.mark.parametrize(
        "rca_line",
        [
            # N/A explícito
            "- FILE: N/A",
            # Valor entre paréntesis (múltiples archivos)
            "FILE: (multiple files)",
            # Ausencia del campo (sin FILE:)
            "- SEVERITY: High\n- ROOT_CAUSE: null pointer",
        ],
    )
    def test_formatos_sin_archivo(self, rca_line: str) -> None:
        """Sentineles y ausencia del campo deben devolver None."""
        result = extract_file_path(rca_line + "\n")
        assert result is None, (
            f"Formato '{rca_line!r}' debería devolver None, pero devolvió {result!r}"
        )

    # ── Casos adicionales de robustez ─────────────────────────────────────────

    def test_plano_sin_guion(self) -> None:
        """Sin marcador de lista: 'FILE: path' debe funcionar."""
        assert extract_file_path("FILE: sample-service/src/coldChain.ts\n") == (
            "sample-service/src/coldChain.ts"
        )

    def test_path_con_punto_simple(self) -> None:
        """Extensión .ts correctamente conservada."""
        assert extract_file_path("- FILE: src/index.ts\n") == "src/index.ts"

    def test_sufijo_linea_removido(self) -> None:
        """':81' al final NO debe aparecer en el resultado."""
        result = extract_file_path("FILE: sample-service/src/coldChain.ts:81\n")
        assert result is not None
        assert ":81" not in result

    def test_backticks_removidos_del_valor(self) -> None:
        """Los backticks envolventes deben eliminarse del path capturado."""
        result = extract_file_path("FILE: `sample-service/src/coldChain.ts`\n")
        assert result is not None
        assert "`" not in result

    def test_na_lowercase(self) -> None:
        """'n/a' en minúsculas también debe devolver None."""
        assert extract_file_path("- FILE: n/a\n") is None

    def test_unknown_sentinel(self) -> None:
        """'UNKNOWN' debe devolver None."""
        assert extract_file_path("- FILE: UNKNOWN\n") is None

    def test_path_profundo(self) -> None:
        """Path anidado profundo debe extraerse completo."""
        rca = "- FILE: packages/my-pkg/src/deep/nested/file.ts:10\n"
        assert extract_file_path(rca) == "packages/my-pkg/src/deep/nested/file.ts"

    def test_path_con_guion_en_nombre(self) -> None:
        """Nombres de archivo con guiones deben conservarse."""
        assert extract_file_path("- FILE: sample-service/src/cold-chain.ts\n") == (
            "sample-service/src/cold-chain.ts"
        )

    def test_case_insensitive_keyword(self) -> None:
        """El keyword 'file' (minúsculas) también debe funcionar."""
        assert extract_file_path("- file: sample-service/src/coldChain.ts\n") == (
            "sample-service/src/coldChain.ts"
        )

    def test_multilinea_extrae_primera_ocurrencia(self) -> None:
        """Con múltiples líneas FILE: se usa la primera (re.search)."""
        rca = (
            "- FILE: first-file.ts\n"
            "- FILE: second-file.ts\n"
        )
        assert extract_file_path(rca) == "first-file.ts"

    def test_contexto_completo_rca(self) -> None:
        """Extrae correctamente con el contexto completo de un RCA real."""
        rca = (
            "Root Cause Analysis:\n"
            "- ERROR_TYPE: TypeError\n"
            "- FILE: sample-service/src/coldChain.ts\n"
            "- ROOT_CAUSE: wrong return type\n"
            "- SEVERITY: High\n"
        )
        assert extract_file_path(rca) == "sample-service/src/coldChain.ts"

    def test_bold_file_with_colon_and_line(self) -> None:
        """**FILE:** con sufijo de línea → path limpio."""
        rca = "- **FILE:** sample-service/src/coldChain.ts:42\n"
        result = extract_file_path(rca)
        assert result == "sample-service/src/coldChain.ts"

    def test_asterisk_list_marker(self) -> None:
        """'* FILE:' con marcador asterisco."""
        assert extract_file_path("* FILE: src/app.ts\n") == "src/app.ts"

    def test_numeric_list_marker(self) -> None:
        """'1. FILE:' con marcador numérico."""
        assert extract_file_path("1. FILE: src/app.ts\n") == "src/app.ts"

    def test_rango_lineas_removido(self) -> None:
        """':42-50' sufijo de rango de líneas debe removerse."""
        result = extract_file_path("- FILE: src/file.ts:42-50\n")
        assert result == "src/file.ts"


# ═══════════════════════════════════════════════════════════════════════════════
# DEFECTO 2 — Guard D2: barrera determinista de ruta inexistente
# ═══════════════════════════════════════════════════════════════════════════════

_MINIMAL_RCA = (
    "- ERROR_TYPE: TypeError\n"
    "- FILE: sample-service/src/coldChain.ts\n"
    "- ROOT_CAUSE: wrong return type\n"
    "- CONTEXT: TypeError: string is not assignable to number\n"
    "- SUGGESTED_ACTION: fix return type annotation\n"
)

_VALID_FIX_CORRECT_PATH = (
    "FILE_PATH: sample-service/src/coldChain.ts\n"
    "<<<FILE_CONTENT>>>\n"
    "const x: number = 1;\n"
    "<<<END_FILE_CONTENT>>>\n"
    "JUSTIFICATION: Fixes the return type.\n"
    "MODIFIED_FILES: sample-service/src/coldChain.ts\n"
)

_VALID_FIX_HALLUCINATED_PATH = (
    # fix-engineer devuelve una ruta que NO coincide con el FILE del RCA
    "FILE_PATH: src/coldChain.ts\n"
    "<<<FILE_CONTENT>>>\n"
    "const x: number = 1;\n"
    "<<<END_FILE_CONTENT>>>\n"
    "JUSTIFICATION: Fixes the return type.\n"
    "MODIFIED_FILES: src/coldChain.ts\n"
)

_APPLY_VERDICT = "Patch looks correct.\nVERDICT: APPLY"


def _make_settings() -> MagicMock:
    s = MagicMock()
    s.github_repo = "org/repo"
    s.ddb_table_name = "ugp-test"
    s.max_attempts = 3
    s.aws_region = "us-east-1"
    s.github_token_secret_arn = "arn:aws:secretsmanager:us-east-1:123:secret/tok"
    return s


def _make_cb(allowed: bool = True) -> MagicMock:
    cb = MagicMock()
    cb.is_escalated.return_value = False
    cb.check_and_increment.return_value = SimpleNamespace(
        allowed=allowed, attempt_number=1, max_attempts=3
    )
    return cb


def _make_task_output(raw: str) -> SimpleNamespace:
    return SimpleNamespace(raw=raw)


def _make_mock_task(raw: str) -> MagicMock:
    t = MagicMock()
    t.output = _make_task_output(raw)
    return t


def _invoke_run_d2(
    fix_output_raw: str,
    review_output_raw: str = _APPLY_VERDICT,
    fetch_side_effect: Exception | None = None,
) -> tuple[int, MagicMock]:
    """Runs crew.main.run() with external deps mocked; returns (exit_code, mock_create)."""
    analyze_task_mock = _make_mock_task(_MINIMAL_RCA)
    fix_task_mock = _make_mock_task(fix_output_raw)
    review_task_mock = _make_mock_task(review_output_raw)

    mock_create = MagicMock(return_value="fix/selfheal-run-42-1")
    mock_pr = MagicMock(return_value="https://github.com/org/repo/pull/1")

    # fetch_file_content call sequence:
    #   call 1 — fetching real content for FILE field (returns "old content")
    #   call 2 — D2 guard verification (raises or returns "old content")
    if fetch_side_effect is not None:
        fetch_responses = [
            "old content",   # call 1: fetch for injection (succeeds)
            fetch_side_effect,  # call 2: D2 guard verification (404 / error)
        ]

        def _fetch_side_effect(*args, **kwargs):
            resp = fetch_responses.pop(0)
            if isinstance(resp, Exception):
                raise resp
            return resp

        fetch_mock = MagicMock(side_effect=_fetch_side_effect)
    else:
        # Both calls succeed
        fetch_mock = MagicMock(return_value="old content")

    with (
        patch("crew.main.get_settings", return_value=_make_settings()),
        patch("crew.main.CircuitBreaker", return_value=_make_cb()),
        patch("crew.main.get_github_token", return_value="ghp_test"),
        patch("crew.main.fetch_ci_log", return_value="some ci log"),
        patch(
            "crew.main.build_tasks",
            side_effect=[
                (analyze_task_mock, MagicMock(), MagicMock()),
                (MagicMock(), fix_task_mock, review_task_mock),
            ],
        ),
        patch(
            "crew.main.build_agents",
            return_value=(MagicMock(), MagicMock(), MagicMock()),
        ),
        patch("crew.main.Crew") as mock_crew_cls,
        patch("crew.main.fetch_file_content", fetch_mock),
        patch("crew.main.create_branch_and_commit", mock_create),
        patch("crew.main.open_pull_request", mock_pr),
    ):
        mock_crew_cls.return_value.kickoff.return_value = review_output_raw
        exit_code = crew.main.run(["--run-id", "run-42"])

    return exit_code, mock_create


class TestD2PathExistenceGuard:
    """D2 — barrera determinista de ruta inexistente antes de create_branch_and_commit."""

    def test_apply_con_ruta_valida_procede(self) -> None:
        """APPLY + ruta coincide con RCA + archivo existe en base → exit 0."""
        exit_code, mock_create = _invoke_run_d2(fix_output_raw=_VALID_FIX_CORRECT_PATH)
        assert exit_code == 0
        mock_create.assert_called_once()

    def test_apply_ruta_no_existe_en_base_retorna_1(self) -> None:
        """APPLY + archivo NO existe en base_branch → return 1, sin crear rama."""
        exit_code, mock_create = _invoke_run_d2(
            fix_output_raw=_VALID_FIX_CORRECT_PATH,
            fetch_side_effect=Exception("404 Not Found"),
        )
        assert exit_code == 1
        mock_create.assert_not_called()

    def test_apply_ruta_no_existe_no_crea_archivo(self) -> None:
        """Cuando el archivo no existe, el guard debe impedir la creación del archivo."""
        exit_code, mock_create = _invoke_run_d2(
            fix_output_raw=_VALID_FIX_CORRECT_PATH,
            fetch_side_effect=FileNotFoundError("404"),
        )
        assert exit_code == 1
        mock_create.assert_not_called()

    def test_apply_path_mismatch_retorna_1(self) -> None:
        """fix-engineer devuelve path distinto al del RCA → return 1, sin crear rama."""
        # _VALID_FIX_HALLUCINATED_PATH tiene FILE_PATH: src/coldChain.ts
        # pero el RCA dice sample-service/src/coldChain.ts → mismatch
        exit_code, mock_create = _invoke_run_d2(
            fix_output_raw=_VALID_FIX_HALLUCINATED_PATH
        )
        assert exit_code == 1
        mock_create.assert_not_called()

    def test_path_mismatch_no_crea_archivo(self) -> None:
        """El mismatch de path NO debe crear ningún archivo en el repo."""
        _, mock_create = _invoke_run_d2(fix_output_raw=_VALID_FIX_HALLUCINATED_PATH)
        mock_create.assert_not_called()

    def test_guard_dispara_antes_de_branch_creation(self) -> None:
        """create_branch_and_commit no se llama cuando D2 rechaza."""
        _, mock_create = _invoke_run_d2(
            fix_output_raw=_VALID_FIX_CORRECT_PATH,
            fetch_side_effect=Exception("404"),
        )
        mock_create.assert_not_called()
