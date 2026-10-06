"""
Configuration validation tests (config.py).

Verifies that Pydantic validators reject invalid formats
and accept correct values.

NOTE: pydantic-settings with alias (env_var name) requires that fields
are passed using their aliases (environment variable names) when instantiating
Settings directly in tests. We use model_validate({...}) with the alias
dictionary so that validation is equivalent to receiving values from the environment.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from crew.config import Settings, reset_settings

# ─── Helpers ─────────────────────────────────────────────────────────────────

_VALID_BASE: dict[str, object] = {
    "GITHUB_REPO": "org/repo",
    "GITHUB_APP_ID": "123",
    "GITHUB_INSTALLATION_ID": "456",
    "GITHUB_TOKEN_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:123:secret/tok",
    "DDB_TABLE_NAME": "ugp-cb",
}


def _make(**overrides: object) -> Settings:
    """Creates a Settings instance from a dict of environment aliases.

    pydantic-settings accepts aliases directly when using
    `model_validate` with `context={'env': data}` — or more simply,
    they can be passed to the constructor with `_env_file=None` and the
    alias names as kwargs using **{alias: value}.

    The most robust approach is to use `Settings.model_validate(data)` with
    the `strict=False` parameter which respects field aliases.
    """
    data = {**_VALID_BASE, **overrides}
    return Settings.model_validate(data)


class TestConfigValidation:
    """Tests for Settings class validation."""

    def teardown_method(self) -> None:
        """Resets the singleton between tests."""
        reset_settings()

    # ── github_repo tests ─────────────────────────────────────────────────────

    @pytest.mark.parametrize(
        "invalid_repo",
        [
            "notavalidrepo",  # no /
            "org/",  # missing repo
            "/repo",  # missing org
            "org/repo/extra",  # too many /
            "",  # empty
            "  ",  # spaces only
        ],
    )
    def test_github_repo_invalido(self, invalid_repo: str) -> None:
        """Rejects repo formats that are not 'org/repo'."""
        with pytest.raises(ValidationError):
            _make(GITHUB_REPO=invalid_repo)

    @pytest.mark.parametrize(
        "valid_repo",
        [
            "slalom/ugp-demo",
            "my-org/my-repo",
            "x/y",  # minimum valid
        ],
    )
    def test_github_repo_valido(self, valid_repo: str) -> None:
        """Accepts valid 'org/repo' formats."""
        settings = _make(GITHUB_REPO=valid_repo)
        assert settings.github_repo == valid_repo

    # ── bedrock_model_id tests ────────────────────────────────────────────────

    @pytest.mark.parametrize(
        "invalid_model",
        [
            "anthropic.claude-sonnet-4-5-20250929-v1:0",  # missing bedrock/ prefix
            "BEDROCK/model-id",  # prefix with uppercase (case-sensitive)
            "model-id",  # no prefix
            "",  # empty
        ],
    )
    def test_bedrock_model_id_invalido(self, invalid_model: str) -> None:
        """Rejects model IDs without 'bedrock/' prefix."""
        with pytest.raises(ValidationError):
            _make(BEDROCK_MODEL_ID=invalid_model)

    @pytest.mark.parametrize(
        "valid_model",
        [
            "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
            "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            "bedrock/some-model",  # generic format
        ],
    )
    def test_bedrock_model_id_valido(self, valid_model: str) -> None:
        """Accepts model IDs with 'bedrock/' prefix."""
        settings = _make(BEDROCK_MODEL_ID=valid_model)
        assert settings.bedrock_model_id == valid_model

    # ── max_attempts tests ────────────────────────────────────────────────────

    @pytest.mark.parametrize(
        "invalid_attempts",
        [
            0,   # < 1
            -1,  # negative
            11,  # > 10
            100, # too high
        ],
    )
    def test_max_attempts_fuera_rango(self, invalid_attempts: int) -> None:
        """Rejects max_attempts outside the [1, 10] range."""
        with pytest.raises(ValidationError):
            _make(MAX_ATTEMPTS=invalid_attempts)

    @pytest.mark.parametrize(
        "valid_attempts",
        [1, 2, 5, 10],
    )
    def test_max_attempts_valido(self, valid_attempts: int) -> None:
        """Accepts max_attempts in the [1, 10] range."""
        settings = _make(MAX_ATTEMPTS=valid_attempts)
        assert settings.max_attempts == valid_attempts

    # ── llm_temperature tests ─────────────────────────────────────────────────

    @pytest.mark.parametrize(
        "invalid_temp",
        [
            -0.1, # < 0
            1.1,  # > 1
            2.0,  # too high
        ],
    )
    def test_llm_temperature_fuera_rango(self, invalid_temp: float) -> None:
        """Rejects llm_temperature outside the [0.0, 1.0] range."""
        with pytest.raises(ValidationError):
            _make(LLM_TEMPERATURE=invalid_temp)

    @pytest.mark.parametrize(
        "valid_temp",
        [0.0, 0.1, 0.5, 0.99, 1.0],
    )
    def test_llm_temperature_valido(self, valid_temp: float) -> None:
        """Accepts llm_temperature in the [0.0, 1.0] range."""
        settings = _make(LLM_TEMPERATURE=valid_temp)
        assert settings.llm_temperature == valid_temp

    # ── Default values ────────────────────────────────────────────────────────

    def test_valores_por_defecto(self) -> None:
        """Default values are sensible."""
        settings = _make()
        assert settings.aws_region == "us-east-1"
        assert settings.max_attempts == 2
        assert settings.llm_temperature == 0.1
        assert settings.bedrock_model_id == "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"

    # ── Required fields ───────────────────────────────────────────────────────

    @pytest.mark.parametrize(
        "missing_field",
        [
            "GITHUB_REPO",
            "DDB_TABLE_NAME",
        ],
    )
    def test_campo_siempre_obligatorio_falta(self, missing_field: str) -> None:
        """GITHUB_REPO and DDB_TABLE_NAME are required in ALL modes."""
        incomplete = {k: v for k, v in _VALID_BASE.items() if k != missing_field}
        with pytest.raises(ValidationError):
            Settings.model_validate(incomplete)

    @pytest.mark.parametrize(
        "missing_field",
        [
            "GITHUB_APP_ID",
            "GITHUB_INSTALLATION_ID",
            "GITHUB_TOKEN_SECRET_ARN",
        ],
    )
    def test_campo_app_obligatorio_en_modo_fargate(self, missing_field: str) -> None:
        """GitHub App vars are required when allow_env_token=False (Fargate)."""
        incomplete = {k: v for k, v in _VALID_BASE.items() if k != missing_field}
        # allow_env_token not set → default False → Fargate mode → must fail
        with pytest.raises(ValidationError):
            Settings.model_validate(incomplete)


# ─── UGP_ALLOW_ENV_TOKEN tests ────────────────────────────────────────────────


# Minimum base for Runner 1 mode: without the 3 GitHub App vars
_ENV_TOKEN_BASE: dict[str, object] = {
    "GITHUB_REPO": "org/repo",
    "DDB_TABLE_NAME": "ugp-cb",
    "UGP_ALLOW_ENV_TOKEN": True,
}


class TestAllowEnvToken:
    """Tests for the UGP_ALLOW_ENV_TOKEN contract (Runner 1 vs Fargate)."""

    def teardown_method(self) -> None:
        """Resets the singleton between tests."""
        reset_settings()

    # ── (a) allow_env_token=True: does not require GitHub App vars ────────────

    def test_env_token_true_no_exige_vars_app(self) -> None:
        """allow_env_token=True: Settings is valid without GITHUB_APP_ID/INSTALLATION_ID/SECRET_ARN."""
        settings = Settings.model_validate(_ENV_TOKEN_BASE)
        assert settings.allow_env_token is True
        assert settings.github_app_id is None
        assert settings.github_installation_id is None
        assert settings.github_token_secret_arn is None

    def test_env_token_true_con_vars_app_presentes_es_valido(self) -> None:
        """allow_env_token=True: if App vars are present it is still valid (they are ignored)."""
        data = {**_ENV_TOKEN_BASE, **{
            "GITHUB_APP_ID": "123",
            "GITHUB_INSTALLATION_ID": "456",
            "GITHUB_TOKEN_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:0:secret/x",
        }}
        settings = Settings.model_validate(data)
        assert settings.allow_env_token is True

    def test_env_token_true_github_repo_sigue_siendo_obligatorio(self) -> None:
        """allow_env_token=True: GITHUB_REPO is still required."""
        data = {k: v for k, v in _ENV_TOKEN_BASE.items() if k != "GITHUB_REPO"}
        with pytest.raises(ValidationError):
            Settings.model_validate(data)

    def test_env_token_true_ddb_table_name_sigue_siendo_obligatorio(self) -> None:
        """allow_env_token=True: DDB_TABLE_NAME is still required."""
        data = {k: v for k, v in _ENV_TOKEN_BASE.items() if k != "DDB_TABLE_NAME"}
        with pytest.raises(ValidationError):
            Settings.model_validate(data)

    # ── (b) allow_env_token=False (default): still requires the 3 App vars ────

    def test_env_token_false_default_exige_vars_app(self) -> None:
        """allow_env_token=False (default): without the 3 App vars → ValidationError."""
        data = {
            "GITHUB_REPO": "org/repo",
            "DDB_TABLE_NAME": "ugp-cb",
            # UGP_ALLOW_ENV_TOKEN not present → default False
        }
        with pytest.raises(ValidationError, match="GITHUB_APP_ID|GITHUB_INSTALLATION_ID|GITHUB_TOKEN_SECRET_ARN"):
            Settings.model_validate(data)

    def test_env_token_false_explicito_exige_vars_app(self) -> None:
        """allow_env_token=False explicit: without the 3 App vars → ValidationError."""
        data = {
            "GITHUB_REPO": "org/repo",
            "DDB_TABLE_NAME": "ugp-cb",
            "UGP_ALLOW_ENV_TOKEN": False,
        }
        with pytest.raises(ValidationError):
            Settings.model_validate(data)

    def test_env_token_false_con_todas_las_vars_app_es_valido(self) -> None:
        """allow_env_token=False with all 3 App vars → valid Settings (block 2 behavior)."""
        settings = Settings.model_validate(_VALID_BASE)
        assert settings.allow_env_token is False
        assert settings.github_app_id == "123"
        assert settings.github_installation_id == "456"
        assert settings.github_token_secret_arn == "arn:aws:secretsmanager:us-east-1:123:secret/tok"
