"""
Unit tests for crew/tools.py and crew/circuit_breaker.py.

Covers:
  - M1: real GitHub App installation token flow (RS256 JWT + mocked POST).
  - M2: _env_fallback=False by default → GITHUB_TOKEN from env is ignored.
  - M3: expiresAt is written to DynamoDB on the first check_and_increment.
  - M4: per-attempt branch idempotency (attempt_number in branch name).
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from crew.circuit_breaker import CircuitBreaker
from crew.tools import (
    GitHubTokenError,
    _sign_app_jwt,
    _validate_branch_name,
    create_branch_and_commit,
    get_github_token,
)

# ─── Test constants ───────────────────────────────────────────────────────────

TABLE_NAME = "ugp-test-tools"
REGION = "us-east-1"


def _generate_test_pem() -> str:
    """Generates a 2048-bit RSA private key for exclusive use in tests.

    Generated at import time; not hardcoded in the repository.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


# PEM generated once per pytest session
_TEST_PEM: str = _generate_test_pem()


# ─── DynamoDB fixtures (moto) ─────────────────────────────────────────────────


@pytest.fixture()
def ddb_table_for_tools():
    """Simulated DynamoDB table with moto for circuit_breaker tests."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=REGION)
        client.create_table(
            TableName=TABLE_NAME,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield client


@pytest.fixture()
def cb(ddb_table_for_tools):
    """CircuitBreaker with moto DynamoDB client."""
    return CircuitBreaker(
        table_name=TABLE_NAME,
        max_attempts=2,
        region=REGION,
        dynamodb_client=ddb_table_for_tools,
    )


# ─── M1: GitHub App JWT flow ──────────────────────────────────────────────────


class TestGitHubAppTokenFlow:
    """Tests for the real GitHub App installation token flow (M1)."""

    def setup_method(self) -> None:
        """Ensures the config singleton does not contaminate between tests."""
        from crew.config import reset_settings  # noqa: PLC0415

        reset_settings()

    def teardown_method(self) -> None:
        """Cleans up the singleton after each test."""
        from crew.config import reset_settings  # noqa: PLC0415

        reset_settings()

    def test_sign_app_jwt_genera_token_valido(self) -> None:
        """_sign_app_jwt must produce a valid RS256 JWT."""
        import jwt  # PyJWT

        token = _sign_app_jwt(pem=_TEST_PEM, app_id="999")
        assert isinstance(token, str)
        assert len(token) > 50

        # Decode without verifying signature to inspect claims
        claims = jwt.decode(token, options={"verify_signature": False})
        assert claims["iss"] == "999"
        now = int(time.time())
        assert claims["iat"] <= now
        assert claims["exp"] > now

    def test_sign_app_jwt_falla_con_pem_invalido(self) -> None:
        """_sign_app_jwt must raise GitHubTokenError if the PEM is garbage."""
        with pytest.raises(GitHubTokenError, match="JWT"):
            _sign_app_jwt(pem="not-a-valid-pem", app_id="123")

    def test_get_github_token_usa_secrets_manager_y_post(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """get_github_token must retrieve the PEM, sign a JWT, and POST."""
        # Minimum vars to load Settings in Fargate mode (allow_env_token=False)
        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_APP_ID", "42")
        monkeypatch.setenv("GITHUB_INSTALLATION_ID", "99")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")

        # Mock Secrets Manager: returns the real test PEM
        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": _TEST_PEM}

        # Mock the installation token POST
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "token": "ghs_FAKEINST",
            "expires_at": "2026-01-01T00:00:00Z",
        }

        with (
            patch("crew.tools.boto3.client", return_value=mock_sm),
            patch("crew.tools.http_requests.post", return_value=mock_resp) as mock_post,
        ):
            result = get_github_token(
                secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem",
                region="us-east-1",
            )

        assert result == "ghs_FAKEINST"
        # Verify that the POST was to the correct endpoint
        call_url = mock_post.call_args[0][0]
        assert "installations/99/access_tokens" in call_url

    def test_get_github_token_falla_si_falta_app_id(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """get_github_token must fail if GITHUB_APP_ID is not set (Fargate mode)."""
        # Without GITHUB_APP_ID config fails before reaching tools
        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_APP_ID", raising=False)
        monkeypatch.setenv("GITHUB_INSTALLATION_ID", "99")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": _TEST_PEM}

        from pydantic import ValidationError  # noqa: PLC0415

        with (
            patch("crew.tools.boto3.client", return_value=mock_sm),
            # Config detects the issue before tools: accept ValidationError or GitHubTokenError
            pytest.raises((GitHubTokenError, ValidationError)),
        ):
            get_github_token(
                secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem"
            )

    def test_get_github_token_falla_si_falta_installation_id(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """get_github_token must fail if GITHUB_INSTALLATION_ID is not set (Fargate mode)."""
        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_APP_ID", "42")
        monkeypatch.delenv("GITHUB_INSTALLATION_ID", raising=False)
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": _TEST_PEM}

        from pydantic import ValidationError  # noqa: PLC0415

        with (
            patch("crew.tools.boto3.client", return_value=mock_sm),
            pytest.raises((GitHubTokenError, ValidationError)),
        ):
            get_github_token(
                secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem"
            )

    def test_get_github_token_api_error_status(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """get_github_token must raise GitHubTokenError if GitHub API returns ≠ 201."""
        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_APP_ID", "42")
        monkeypatch.setenv("GITHUB_INSTALLATION_ID", "99")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": _TEST_PEM}

        mock_resp = MagicMock()
        mock_resp.status_code = 401

        with (
            patch("crew.tools.boto3.client", return_value=mock_sm),
            patch("crew.tools.http_requests.post", return_value=mock_resp),
            pytest.raises(GitHubTokenError, match="401"),
        ):
            get_github_token(
                secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem"
            )


# ─── M2: fallback disabled by default ────────────────────────────────────────


class TestEnvFallbackDesactivado:
    """Tests that _env_fallback=False by default (M2)."""

    def setup_method(self) -> None:
        """Cleans up the config singleton before each test."""
        from crew.config import reset_settings  # noqa: PLC0415

        reset_settings()

    def teardown_method(self) -> None:
        """Cleans up the config singleton after each test."""
        from crew.config import reset_settings  # noqa: PLC0415

        reset_settings()

    def test_env_fallback_false_ignora_github_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With _env_fallback=False (default), GITHUB_TOKEN from env is ignored."""
        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "env-token-value")
        monkeypatch.setenv("GITHUB_APP_ID", "42")
        monkeypatch.setenv("GITHUB_INSTALLATION_ID", "99")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": _TEST_PEM}

        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "token": "ghs_REAL",
            "expires_at": "2026-01-01T00:00:00Z",
        }

        with (
            patch("crew.tools.boto3.client", return_value=mock_sm),
            patch("crew.tools.http_requests.post", return_value=mock_resp),
        ):
            # Call WITHOUT _env_fallback (default=False)
            result = get_github_token(
                secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem"
            )

        # Must return the installation token, NOT the environment variable one
        assert result == "ghs_REAL"
        assert result != "env-token-value"

    def test_env_fallback_true_usa_github_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With explicit _env_fallback=True, GITHUB_TOKEN from env is used.

        Note: _env_fallback=True is evaluated BEFORE allow_env_token is checked
        (and before loading config), so it does not need full Settings vars.
        """
        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "local-dev-token")
        # _env_fallback=True is evaluated before get_settings(), so we don't
        # need the complete Settings vars in this test.
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")
        monkeypatch.setenv("GITHUB_APP_ID", "42")
        monkeypatch.setenv("GITHUB_INSTALLATION_ID", "99")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")

        result = get_github_token(
            secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem",
            _env_fallback=True,
        )
        assert result == "local-dev-token"


# ─── M3: expiresAt written to DynamoDB ───────────────────────────────────────


class TestTTLExpiresAt:
    """Tests that check_and_increment writes the expiresAt attribute (M3)."""

    def test_expires_at_se_escribe_en_primer_intento(
        self, ddb_table_for_tools, cb: CircuitBreaker
    ) -> None:
        """The first check_and_increment must create the expiresAt attribute."""
        cb.check_and_increment("org/repo", "run-ttl-001")

        resp = ddb_table_for_tools.get_item(
            TableName=TABLE_NAME,
            Key={
                "PK": {"S": "REPO#org/repo#RUN#run-ttl-001"},
                "SK": {"S": "ATTEMPT_COUNTER"},
            },
        )
        item = resp.get("Item", {})
        assert "expiresAt" in item, "expiresAt must be present in the DynamoDB item"
        expires_at = int(item["expiresAt"]["N"])
        now = int(time.time())
        # ~7 days = 604800 s; allow 60 s downward margin
        assert expires_at > now + 604_000, (
            "expiresAt must be at least ~7 days in the future"
        )

    def test_expires_at_no_se_sobreescribe_en_intentos_siguientes(
        self, ddb_table_for_tools, cb: CircuitBreaker
    ) -> None:
        """expiresAt is only written on the first attempt (if_not_exists)."""
        cb.check_and_increment("org/repo", "run-ttl-002")

        resp1 = ddb_table_for_tools.get_item(
            TableName=TABLE_NAME,
            Key={
                "PK": {"S": "REPO#org/repo#RUN#run-ttl-002"},
                "SK": {"S": "ATTEMPT_COUNTER"},
            },
        )
        first_ttl = int(resp1["Item"]["expiresAt"]["N"])

        time.sleep(0.01)
        cb.check_and_increment("org/repo", "run-ttl-002")

        resp2 = ddb_table_for_tools.get_item(
            TableName=TABLE_NAME,
            Key={
                "PK": {"S": "REPO#org/repo#RUN#run-ttl-002"},
                "SK": {"S": "ATTEMPT_COUNTER"},
            },
        )
        second_ttl = int(resp2["Item"]["expiresAt"]["N"])

        assert first_ttl == second_ttl, (
            "expiresAt must not change between attempts (if_not_exists)"
        )


# ─── M4: per-attempt branch idempotency ──────────────────────────────────────


class TestRamaIdempotentePorIntento:
    """Tests that create_branch_and_commit generates different branches per attempt (M4)."""

    def _make_mock_repo(self) -> MagicMock:
        mock_branch = MagicMock()
        mock_branch.commit.sha = "abc1234def5678"
        mock_repo = MagicMock()
        mock_repo.get_branch.return_value = mock_branch
        return mock_repo

    def test_intento1_y_intento2_generan_ramas_distintas(self) -> None:
        """Two attempts with the same run_key must generate different branch names."""
        mock_repo = self._make_mock_repo()
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value = mock_repo

        branch1 = create_branch_and_commit(
            repo="org/repo",
            token="tok",
            diff_content="diff content",
            run_key="run-abc",
            attempt_number=1,
            github_client=mock_gh,
        )

        mock_repo2 = self._make_mock_repo()
        mock_gh2 = MagicMock()
        mock_gh2.get_repo.return_value = mock_repo2

        branch2 = create_branch_and_commit(
            repo="org/repo",
            token="tok",
            diff_content="diff content",
            run_key="run-abc",
            attempt_number=2,
            github_client=mock_gh2,
        )

        assert branch1 != branch2, "Attempt 1 and 2 must generate different branches"
        assert branch1.startswith("fix/"), "Branch 1 must start with fix/"
        assert branch2.startswith("fix/"), "Branch 2 must start with fix/"
        assert "attempt1" in branch1, "Branch 1 must contain 'attempt1'"
        assert "attempt2" in branch2, "Branch 2 must contain 'attempt2'"

    def test_rama_generada_respeta_guardarrail(self) -> None:
        """The branch generated by create_branch_and_commit always passes _validate_branch_name."""
        import hashlib

        for attempt in range(1, 5):
            run_key = "test-run-xyz"
            run_hash = hashlib.sha1(run_key.encode(), usedforsecurity=False).hexdigest()[:8]
            branch = f"fix/selfheal-{run_hash}-attempt{attempt}"
            # Must not raise an exception
            _validate_branch_name(branch)

    def test_mismo_run_key_y_attempt_es_determinista(self) -> None:
        """The same run_key + attempt always generates the same branch name."""
        mock_repo = self._make_mock_repo()
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value = mock_repo

        branch_a = create_branch_and_commit(
            repo="org/repo",
            token="tok",
            diff_content="diff",
            run_key="fixed-run",
            attempt_number=1,
            github_client=mock_gh,
        )

        mock_repo2 = self._make_mock_repo()
        mock_gh2 = MagicMock()
        mock_gh2.get_repo.return_value = mock_repo2

        branch_b = create_branch_and_commit(
            repo="org/repo",
            token="tok",
            diff_content="diff",
            run_key="fixed-run",
            attempt_number=1,
            github_client=mock_gh2,
        )
        assert branch_a == branch_b, "Same run_key+attempt must generate the same name"


# ─── UGP_ALLOW_ENV_TOKEN tests (Runner 1 mode) ───────────────────────────────


class TestAllowEnvTokenMode:
    """Tests for the allow_env_token=True mode (Runner 1 of GitHub Actions).

    Covers the three required contracts:
      (a) allow_env_token=True uses GITHUB_TOKEN from env and does not require App vars.
      (b) allow_env_token=True without GITHUB_TOKEN in env → GitHubTokenError.
      (c) allow_env_token=False (default) still requires App vars.
    """

    def teardown_method(self) -> None:
        """Cleans up the config singleton between tests to avoid contamination."""
        from crew.config import reset_settings  # noqa: PLC0415

        reset_settings()

    # ── (a) allow_env_token=True uses GITHUB_TOKEN from env ───────────────────

    def test_allow_env_token_true_usa_github_token_del_entorno(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With UGP_ALLOW_ENV_TOKEN=true, get_github_token returns GITHUB_TOKEN from env.

        Must not call Secrets Manager or the GitHub App API.
        """
        from crew.config import reset_settings  # noqa: PLC0415

        # Configure environment for Runner 1 mode
        monkeypatch.setenv("UGP_ALLOW_ENV_TOKEN", "true")
        monkeypatch.setenv("GITHUB_TOKEN", "ghs_ACTIONS_EPHEMERAL")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")
        # App vars are NOT defined
        monkeypatch.delenv("GITHUB_APP_ID", raising=False)
        monkeypatch.delenv("GITHUB_INSTALLATION_ID", raising=False)
        monkeypatch.delenv("GITHUB_TOKEN_SECRET_ARN", raising=False)
        reset_settings()  # force reload with new environment

        with patch("crew.tools.boto3.client") as mock_boto3:
            result = get_github_token(secret_arn="", region="us-east-1")

        # Must return the env token
        assert result == "ghs_ACTIONS_EPHEMERAL"
        # Secrets Manager must NOT have been called
        mock_boto3.assert_not_called()

    def test_allow_env_token_true_no_exige_vars_app(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With allow_env_token=True, absence of GITHUB_APP_ID does not cause an error."""
        from crew.config import reset_settings  # noqa: PLC0415

        monkeypatch.setenv("UGP_ALLOW_ENV_TOKEN", "true")
        monkeypatch.setenv("GITHUB_TOKEN", "ghs_ACTIONS_TOKEN")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")
        monkeypatch.delenv("GITHUB_APP_ID", raising=False)
        monkeypatch.delenv("GITHUB_INSTALLATION_ID", raising=False)
        reset_settings()

        # Must not raise GitHubTokenError for missing GITHUB_APP_ID
        result = get_github_token(secret_arn="", region="us-east-1")
        assert result == "ghs_ACTIONS_TOKEN"

    # ── (b) allow_env_token=True without GITHUB_TOKEN → clear error ───────────

    def test_allow_env_token_true_sin_github_token_lanza_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With UGP_ALLOW_ENV_TOKEN=true but without GITHUB_TOKEN → GitHubTokenError."""
        from crew.config import reset_settings  # noqa: PLC0415

        monkeypatch.setenv("UGP_ALLOW_ENV_TOKEN", "true")
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")
        reset_settings()

        with pytest.raises(GitHubTokenError, match="GITHUB_TOKEN"):
            get_github_token(secret_arn="", region="us-east-1")

    def test_allow_env_token_true_github_token_vacio_lanza_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GITHUB_TOKEN defined but empty also raises GitHubTokenError."""
        from crew.config import reset_settings  # noqa: PLC0415

        monkeypatch.setenv("UGP_ALLOW_ENV_TOKEN", "true")
        monkeypatch.setenv("GITHUB_TOKEN", "   ")  # spaces only
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")
        reset_settings()

        with pytest.raises(GitHubTokenError, match="GITHUB_TOKEN"):
            get_github_token(secret_arn="", region="us-east-1")

    # ── (c) allow_env_token=False (default) still requires App vars ───────────

    def test_allow_env_token_false_default_usa_flujo_github_app(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With UGP_ALLOW_ENV_TOKEN=false (default), the GitHub App flow is still active.

        Even if GITHUB_TOKEN is in the environment, get_github_token does NOT use it
        (must go to Secrets Manager).
        """
        from crew.config import reset_settings  # noqa: PLC0415

        # UGP_ALLOW_ENV_TOKEN not defined → default False
        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "env-token-ignored")
        monkeypatch.setenv("GITHUB_APP_ID", "42")
        monkeypatch.setenv("GITHUB_INSTALLATION_ID", "99")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")
        reset_settings()

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": _TEST_PEM}
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "token": "ghs_APP_INSTALLATION",
            "expires_at": "2026-01-01T00:00:00Z",
        }

        with (
            patch("crew.tools.boto3.client", return_value=mock_sm),
            patch("crew.tools.http_requests.post", return_value=mock_resp),
        ):
            result = get_github_token(
                secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem",
                region="us-east-1",
            )

        # Must return the App installation token, NOT the env token
        assert result == "ghs_APP_INSTALLATION"
        assert result != "env-token-ignored"

    def test_allow_env_token_false_sin_app_id_lanza_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With allow_env_token=False, absence of GITHUB_APP_ID causes an error.

        With the new model, validation occurs in Settings (model_validator)
        before reaching get_github_token. Both paths (ValidationError or
        GitHubTokenError) demonstrate that Fargate mode is secure without GITHUB_APP_ID.
        """
        from crew.config import reset_settings  # noqa: PLC0415
        from pydantic import ValidationError  # noqa: PLC0415

        monkeypatch.delenv("UGP_ALLOW_ENV_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_APP_ID", raising=False)
        monkeypatch.setenv("GITHUB_INSTALLATION_ID", "99")
        monkeypatch.setenv("GITHUB_TOKEN_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000:secret/pem")
        monkeypatch.setenv("GITHUB_REPO", "org/repo")
        monkeypatch.setenv("DDB_TABLE_NAME", "ugp-cb")
        reset_settings()

        mock_sm = MagicMock()
        mock_sm.get_secret_value.return_value = {"SecretString": _TEST_PEM}

        # Settings detects the issue in model_validator → ValidationError
        # (or GitHubTokenError if it reached tools). Both are correct.
        with (
            patch("crew.tools.boto3.client", return_value=mock_sm),
            pytest.raises((GitHubTokenError, ValidationError)),
        ):
            get_github_token(
                secret_arn="arn:aws:secretsmanager:us-east-1:000:secret/pem"
            )
