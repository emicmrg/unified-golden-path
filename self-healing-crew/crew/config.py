"""
Self-healing crew configuration.

Loads all configuration from environment variables.
No secrets are hardcoded: tokens are read at runtime
from Secrets Manager or from the GITHUB_TOKEN environment variable (only for
local testing with a token already obtained).
"""

from __future__ import annotations

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Global crew configuration loaded from the environment.

    In Fargate, variables arrive as environment variables from the Task
    Definition; locally they can be exported or loaded from a .env file
    (never versioned).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── AWS ──────────────────────────────────────────────────────────────────
    aws_region: str = Field(
        default="us-east-1",
        alias="AWS_REGION",
        description="AWS region where DynamoDB and Secrets Manager are located.",
    )

    bedrock_model_id: str = Field(
        default="bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        alias="BEDROCK_MODEL_ID",
        description=(
            "Bedrock model ID via LiteLLM. "
            "Use cross-region inference profile for resiliency."
        ),
    )

    # ── DynamoDB (circuit breaker) ────────────────────────────────────────────
    ddb_table_name: str = Field(
        alias="DDB_TABLE_NAME",
        description="DynamoDB table name for the circuit breaker.",
    )

    # ── GitHub ────────────────────────────────────────────────────────────────

    # Runner 1 mode (GitHub Actions): when True the crew uses the ephemeral
    # GITHUB_TOKEN from the workflow directly. The GitHub App flow (PEM → JWT)
    # is disabled. DEFAULT=False → in Fargate it is NEVER activated.
    #
    # Security:
    #   - allow_env_token=False (Fargate): GitHub App flow is mandatory.
    #   - allow_env_token=True (GHA Runner): native GITHUB_TOKEN of the workflow
    #     (contents:write + pull-requests:write scoped by the workflow).
    #   - NEVER set UGP_ALLOW_ENV_TOKEN=true in the Fargate Task Definition.
    allow_env_token: bool = Field(
        default=False,
        alias="UGP_ALLOW_ENV_TOKEN",
        description=(
            "Enables Runner 1 mode (GitHub Actions): uses GITHUB_TOKEN from "
            "the environment directly. DEFAULT False → Fargate always uses GitHub App. "
            "Only set to True in the self-heal-gha.yml workflow."
        ),
    )

    github_repo: str = Field(
        alias="GITHUB_REPO",
        description="Target repository in 'org/repo' format.",
    )

    # Required fields in Fargate mode (allow_env_token=False).
    # Optional when allow_env_token=True (validated in model_validator).
    github_app_id: str | None = Field(
        default=None,
        alias="GITHUB_APP_ID",
        description="Numeric ID of the GitHub App (required in Fargate mode).",
    )

    github_installation_id: str | None = Field(
        default=None,
        alias="GITHUB_INSTALLATION_ID",
        description=(
            "Installation ID of the GitHub App in the organization/repo "
            "(required in Fargate mode)."
        ),
    )

    github_token_secret_arn: str | None = Field(
        default=None,
        alias="GITHUB_TOKEN_SECRET_ARN",
        description=(
            "ARN of the Secrets Manager secret containing the GitHub App "
            "private key PEM (required in Fargate mode). "
            "Not used in Runner 1 mode (allow_env_token=True)."
        ),
    )

    # ── Circuit breaker ───────────────────────────────────────────────────────
    max_attempts: int = Field(
        default=2,
        alias="MAX_ATTEMPTS",
        ge=1,
        le=10,
        description="Maximum number of self-healing attempts before escalating.",
    )

    # ── LLM temperature ───────────────────────────────────────────────────────
    llm_temperature: float = Field(
        default=0.1,
        alias="LLM_TEMPERATURE",
        ge=0.0,
        le=1.0,
        description="LLM temperature (0-1). Low value for higher determinism.",
    )

    # ── Optional (facilitate local testing) ──────────────────────────────────
    github_token: str | None = Field(
        default=None,
        alias="GITHUB_TOKEN",
        description=(
            "GitHub token for local testing use. "
            "In production (Fargate) always read from Secrets Manager. "
            "NEVER versioned or printed in logs."
        ),
    )

    @field_validator("github_repo")
    @classmethod
    def validate_github_repo(cls, v: str) -> str:
        """Validates that the repo has the 'org/repo' format."""
        parts = v.split("/")
        if len(parts) != 2 or not all(parts):  # noqa: PLR2004
            raise ValueError(
                f"GITHUB_REPO must have the format 'org/repo', received: '{v}'"
            )
        return v

    @field_validator("bedrock_model_id")
    @classmethod
    def validate_bedrock_model_id(cls, v: str) -> str:
        """Validates that the model ID starts with the bedrock/ prefix (LiteLLM route)."""
        if not v.startswith("bedrock/"):
            raise ValueError(
                f"BEDROCK_MODEL_ID must start with 'bedrock/', received: '{v}'"
            )
        return v

    @model_validator(mode="after")
    def validate_token_mode(self) -> "Settings":
        """Validates consistency between allow_env_token and GitHub App/Token vars.

        Env-token mode (allow_env_token=True / Runner 1 in GitHub Actions):
          - GITHUB_TOKEN must be in the environment; validated in get_github_token.
          - GITHUB_APP_ID / GITHUB_INSTALLATION_ID / GITHUB_TOKEN_SECRET_ARN
            are OPTIONAL (not used).

        GitHub App mode (allow_env_token=False / Fargate — DEFAULT):
          - GITHUB_APP_ID, GITHUB_INSTALLATION_ID and GITHUB_TOKEN_SECRET_ARN
            are REQUIRED.
          - If GITHUB_TOKEN is also in the environment, a warning is emitted
            (without exposing its value) to avoid confusion.
        """
        import logging

        log = logging.getLogger(__name__)

        if self.allow_env_token:
            # Runner 1 mode: App vars are not needed.
            # Actual presence of GITHUB_TOKEN is validated at runtime (get_github_token).
            log.info(
                "allow_env_token=True: Runner 1 mode active. "
                "The crew will use GITHUB_TOKEN from the workflow environment. "
                "GITHUB_APP_ID/GITHUB_INSTALLATION_ID/GITHUB_TOKEN_SECRET_ARN "
                "are ignored in this mode."
            )
        else:
            # Fargate mode (default): all 3 App vars are required.
            missing: list[str] = []
            if not self.github_app_id:
                missing.append("GITHUB_APP_ID")
            if not self.github_installation_id:
                missing.append("GITHUB_INSTALLATION_ID")
            if not self.github_token_secret_arn:
                missing.append("GITHUB_TOKEN_SECRET_ARN")
            if missing:
                from pydantic import ValidationError as _VE  # noqa: PLC0415

                raise ValueError(
                    f"The following variables are required when "
                    f"UGP_ALLOW_ENV_TOKEN=false (Fargate / GitHub App mode): "
                    f"{', '.join(missing)}. "
                    f"For Runner 1 mode (GitHub Actions) set "
                    f"UGP_ALLOW_ENV_TOKEN=true."
                )
            if self.github_token is not None:
                log.warning(
                    "GITHUB_TOKEN is defined as an environment variable but "
                    "allow_env_token=False: the GitHub App flow will be used "
                    "(Secrets Manager → JWT). "
                    "GITHUB_TOKEN will be ignored in Fargate mode."
                )

        return self


# Singleton instance — imported by the rest of the package.
# Lazily instantiated to avoid failing at import time when tests
# inject environment variables via monkeypatch.
_settings: Settings | None = None


def get_settings() -> Settings:
    """Returns the Settings singleton instance.

    Fails fast with a clear message if any required variable is missing.
    """
    global _settings
    if _settings is None:
        _settings = Settings()  # type: ignore[call-arg]
    return _settings


def reset_settings() -> None:
    """Resets the singleton (useful in tests)."""
    global _settings
    _settings = None
