"""
CircuitBreaker unit tests.

Uses moto to simulate DynamoDB locally, without a real AWS connection.
Verifies:
  - Atomic increment and MAX_ATTEMPTS limit.
  - That check_and_increment returns allowed=False when the limit is exceeded.
  - That ConditionalCheckFailedException is handled correctly.
  - mark_escalated and is_escalated.
"""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws  # moto >=5.x uses unified @mock_aws

from crew.circuit_breaker import CircuitBreaker

TABLE_NAME = "ugp-circuit-breaker-test"
REGION = "us-east-1"


# ─── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture()
def ddb_table():
    """Creates a simulated DynamoDB table with moto."""
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
def circuit_breaker(ddb_table):
    """CircuitBreaker with injected DynamoDB client (moto)."""
    return CircuitBreaker(
        table_name=TABLE_NAME,
        max_attempts=2,
        region=REGION,
        dynamodb_client=ddb_table,
    )


# ─── Tests ────────────────────────────────────────────────────────────────────


def test_primer_intento_permitido(circuit_breaker):
    """The first attempt must always be allowed."""
    result = circuit_breaker.check_and_increment("org/repo", "run-001")
    assert result.allowed is True
    assert result.attempt_number == 1
    assert result.max_attempts == 2


def test_segundo_intento_permitido(circuit_breaker):
    """The second attempt (within the limit) must be allowed."""
    circuit_breaker.check_and_increment("org/repo", "run-001")
    result = circuit_breaker.check_and_increment("org/repo", "run-001")
    assert result.allowed is True
    assert result.attempt_number == 2


def test_tercer_intento_bloqueado(circuit_breaker):
    """The third attempt (exceeds MAX_ATTEMPTS=2) must be blocked."""
    circuit_breaker.check_and_increment("org/repo", "run-001")
    circuit_breaker.check_and_increment("org/repo", "run-001")
    result = circuit_breaker.check_and_increment("org/repo", "run-001")
    assert result.allowed is False
    assert result.attempt_number >= 2


def test_run_keys_independientes(circuit_breaker):
    """Two different run_keys have independent counters."""
    # Exhaust the first one
    circuit_breaker.check_and_increment("org/repo", "run-aaa")
    circuit_breaker.check_and_increment("org/repo", "run-aaa")
    blocked = circuit_breaker.check_and_increment("org/repo", "run-aaa")
    assert blocked.allowed is False

    # The second run_key is independent → first attempt = allowed
    result_b = circuit_breaker.check_and_increment("org/repo", "run-bbb")
    assert result_b.allowed is True
    assert result_b.attempt_number == 1


def test_repos_independientes(circuit_breaker):
    """Two different repos have independent counters."""
    circuit_breaker.check_and_increment("org/repo-a", "run-001")
    circuit_breaker.check_and_increment("org/repo-a", "run-001")
    circuit_breaker.check_and_increment("org/repo-a", "run-001")  # blocked

    result = circuit_breaker.check_and_increment("org/repo-b", "run-001")
    assert result.allowed is True
    assert result.attempt_number == 1


def test_mark_escalated_y_is_escalated(circuit_breaker):
    """mark_escalated and is_escalated work correctly."""
    repo, run_key = "org/repo", "run-esc"

    # Initially not escalated
    assert circuit_breaker.is_escalated(repo, run_key) is False

    # Exhaust attempts and mark as escalated
    circuit_breaker.check_and_increment(repo, run_key)
    circuit_breaker.check_and_increment(repo, run_key)
    circuit_breaker.mark_escalated(repo, run_key)

    assert circuit_breaker.is_escalated(repo, run_key) is True


def test_is_escalated_item_inexistente(circuit_breaker):
    """is_escalated returns False when the item does not exist yet."""
    assert circuit_breaker.is_escalated("org/repo", "run-nonexistent") is False


def test_max_attempts_configurable(ddb_table):
    """The maximum limit is respected with different MAX_ATTEMPTS values."""
    cb = CircuitBreaker(
        table_name=TABLE_NAME,
        max_attempts=3,
        region=REGION,
        dynamodb_client=ddb_table,
    )
    r1 = cb.check_and_increment("org/repo", "run-max3")
    r2 = cb.check_and_increment("org/repo", "run-max3")
    r3 = cb.check_and_increment("org/repo", "run-max3")
    r4 = cb.check_and_increment("org/repo", "run-max3")  # blocked

    assert r1.allowed is True
    assert r2.allowed is True
    assert r3.allowed is True
    assert r4.allowed is False
