# ── Self-Healing Crew — Image for AWS Fargate ─────────────────────────────────
# Base: python:3.11-slim (Debian Bookworm slim, no unnecessary extras)
# User: non-root (ugp, UID 1001)
# Entry point: ugp-selfheal (defined in pyproject.toml)
#
# SECURITY:
#  - No credentials in the image (they come from the Task IAM role in Fargate).
#  - Non-root user to reduce attack surface.
#  - Dependencies pinned in pyproject.toml.
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim AS base

# OCI metadata
LABEL org.opencontainers.image.title="ugp-self-healing-crew"
LABEL org.opencontainers.image.description="Self-healing crew for CI/CD with CrewAI + Bedrock"
LABEL org.opencontainers.image.source="https://github.com/slalom/unified-golden-path"

# Python environment variables (no .pyc, no buffering)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # LiteLLM / Bedrock: region is injected in the Task Definition
    AWS_REGION=us-east-1 \
    # Working directory inside the container
    APP_DIR=/app

# ── System dependencies ───────────────────────────────────────────────────────
# git: needed for diff operations in future local commands
# ca-certificates: needed for HTTPS calls (GitHub API, Bedrock)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Non-root user ─────────────────────────────────────────────────────────────
RUN groupadd --gid 1001 ugp && \
    useradd --uid 1001 --gid ugp --shell /bin/sh --create-home ugp

# ── Install the package ───────────────────────────────────────────────────────
WORKDIR ${APP_DIR}

# Copy only what is needed to install the package
COPY pyproject.toml ./
COPY crew/ ./crew/

# Install in non-editable mode with pip (reproducible with pinned versions)
# --no-cache-dir reduces image size
RUN pip install --no-cache-dir --upgrade pip==24.3.1 && \
    pip install --no-cache-dir .

# ── Switch to non-root user ───────────────────────────────────────────────────
USER ugp

# ── Basic health check (verifies that the entry point exists) ─────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import crew; print('ok')" || exit 1

# ── Entry point ───────────────────────────────────────────────────────────────
# Required environment variables are injected in the Fargate Task Definition:
#   AWS_REGION, BEDROCK_MODEL_ID, DDB_TABLE_NAME, GITHUB_APP_ID,
#   GITHUB_INSTALLATION_ID, GITHUB_REPO, GITHUB_TOKEN_SECRET_ARN,
#   MAX_ATTEMPTS (optional), UGP_RUN_ID, UGP_RUN_KEY
CMD ["ugp-selfheal"]
