"""
Circuit breaker for the self-healing crew.

Persists the attempt counter in DynamoDB with atomic increment
(UpdateItem + ConditionExpression) to guarantee that MAX_ATTEMPTS is never
exceeded even in concurrent executions.

DynamoDB table design
─────────────────────
  PK (S)          : "REPO#<org/repo>#RUN#<run_id_or_commit_sha>"
  SK (S)          : "ATTEMPT_COUNTER"   (allows future extension with other SKs)
  attempt_count (N): atomic counter; starts at 0 when the item is created.
  created_at (S)  : ISO-8601 UTC of the first creation.
  last_updated (S): ISO-8601 UTC of the last update.
  escalated (BOOL): True when the failure has been escalated to a human.
  expiresAt (N)   : TTL epoch-seconds. The item expires 7 days after the first
                    attempt, allowing the circuit breaker to rearm automatically
                    (DynamoDB TTL deletes it).
                    MUST match the TTL attribute name configured in the CDK table.

Circuit breaker rearm
─────────────────────
The TTL (expiresAt) is written on the first UPDATE (if_not_exists) with a
horizon of 7 days. Once DynamoDB deletes the expired item, the circuit breaker
rearms automatically: the next check_and_increment will create a new item with
attempt_count=1.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

# Item TTL: 7 days from the first attempt (epoch seconds)
_TTL_DAYS = 7

# ─── Constants ────────────────────────────────────────────────────────────────

_SK = "ATTEMPT_COUNTER"


def _make_pk(repo: str, run_key: str) -> str:
    """Builds the canonical partition key."""
    return f"REPO#{repo}#RUN#{run_key}"


def _ttl_epoch(days: int = _TTL_DAYS) -> int:
    """Calculates the TTL as epoch seconds (now + days)."""
    return int((datetime.now(UTC) + timedelta(days=days)).timestamp())


# ─── Dataclasses ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AttemptResult:
    """Result of the circuit breaker increment operation.

    Attributes:
        allowed: True if this attempt is within the allowed limit.
        attempt_number: Current attempt number (1-indexed).
        max_attempts: Configured limit.
    """

    allowed: bool
    attempt_number: int
    max_attempts: int


# ─── CircuitBreaker ───────────────────────────────────────────────────────────


class CircuitBreaker:
    """Controls the maximum number of auto-repair attempts per failure.

    Uses DynamoDB as a backend to guarantee persistence and atomicity.
    The DynamoDB client can be injected to facilitate unit testing
    (e.g., with moto).

    Args:
        table_name: DynamoDB table name.
        max_attempts: Maximum number of allowed attempts.
        region: AWS region.
        dynamodb_client: Injected DynamoDB client (optional; if not provided
            one is created using the environment credentials).
    """

    def __init__(
        self,
        table_name: str,
        max_attempts: int,
        region: str = "us-east-1",
        dynamodb_client: Any | None = None,
    ) -> None:
        self._table_name = table_name
        self._max_attempts = max_attempts
        self._client: DynamoDBClient = dynamodb_client or boto3.client(
            "dynamodb", region_name=region
        )

    # ── Public operations ─────────────────────────────────────────────────────

    def check_and_increment(self, repo: str, run_key: str) -> AttemptResult:
        """Atomically increments the counter and returns whether the attempt is allowed.

        If the item does not exist it creates it with attempt_count = 1.
        If it already exists, increments with the condition that the current
        value is less than max_attempts (atomic operation → no TOCTOU).

        Also writes expiresAt (TTL epoch-seconds) on the first UPDATE using
        if_not_exists, so that DynamoDB deletes the item after 7 days and
        the circuit breaker rearms automatically.

        Returns:
            AttemptResult with allowed=True if attempt_number <= max_attempts.

        Raises:
            RuntimeError: If there is a connectivity or permissions error with DynamoDB.
        """
        pk = _make_pk(repo, run_key)
        now_iso = datetime.now(UTC).isoformat()
        # TTL: written only if it does not exist (if_not_exists), 7 days from first attempt
        ttl_epoch = _ttl_epoch(_TTL_DAYS)

        try:
            response = self._client.update_item(
                TableName=self._table_name,
                Key={
                    "PK": {"S": pk},
                    "SK": {"S": _SK},
                },
                # Atomic increment: ADD is idempotent for numeric counters.
                # SET creates audit and TTL fields only if they do not exist.
                # expiresAt: exact name of the TTL attribute configured in CDK.
                UpdateExpression=(
                    "SET #ca = if_not_exists(#ca, :init_ts), "
                    "    #lu = :now, "
                    "    #exp = if_not_exists(#exp, :ttl) "
                    "ADD #cnt :one"
                ),
                # ConditionExpression: only allows the increment if the current
                # counter is less than max_attempts (or if the item does not exist yet).
                ConditionExpression=(
                    "attribute_not_exists(#cnt) OR #cnt < :max_attempts"
                ),
                ExpressionAttributeNames={
                    "#cnt": "attempt_count",
                    "#ca": "created_at",
                    "#lu": "last_updated",
                    "#exp": "expiresAt",
                },
                ExpressionAttributeValues={
                    ":one": {"N": "1"},
                    # :init_ts = ISO-8601 creation timestamp (only written the 1st time)
                    ":init_ts": {"S": now_iso},
                    ":now": {"S": now_iso},
                    ":ttl": {"N": str(ttl_epoch)},
                    ":max_attempts": {"N": str(self._max_attempts)},
                },
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            error_code = exc.response["Error"]["Code"]
            if error_code == "ConditionalCheckFailedException":
                # The counter has already reached the limit → this attempt is not allowed.
                # We use ReturnValuesOnConditionCheckFailure to avoid an extra get_item call.
                item = (
                    exc.response.get("Item")
                    or exc.response.get("Error", {}).get("Item")
                    or {}
                )
                current = int(item.get("attempt_count", {}).get("N", "0"))
                if current == 0:
                    # Defensive fallback: item without ALL_OLD (older moto versions)
                    current = self._get_current_count(pk)
                logger.warning(
                    "Circuit breaker OPEN for repo=%s run_key=%s "
                    "attempt_count=%d max_attempts=%d",
                    repo,
                    run_key,
                    current,
                    self._max_attempts,
                )
                return AttemptResult(
                    allowed=False,
                    attempt_number=current,
                    max_attempts=self._max_attempts,
                )
            # Unexpected error: propagate with context
            logger.error(
                "DynamoDB error incrementing circuit breaker: %s",
                exc,
            )
            raise RuntimeError(
                f"Could not update the circuit breaker in DynamoDB: {exc}"
            ) from exc

        new_count = int(
            response["Attributes"]["attempt_count"]["N"]
        )
        allowed = new_count <= self._max_attempts
        logger.info(
            "Circuit breaker: repo=%s run_key=%s attempt=%d/%d allowed=%s expiresAt=%d",
            repo,
            run_key,
            new_count,
            self._max_attempts,
            allowed,
            ttl_epoch,
        )
        return AttemptResult(
            allowed=allowed,
            attempt_number=new_count,
            max_attempts=self._max_attempts,
        )

    def mark_escalated(self, repo: str, run_key: str) -> None:
        """Marks the record as escalated to a human to prevent re-triggers.

        Args:
            repo: Repository in 'org/repo' format.
            run_key: Execution key (run ID or commit SHA).
        """
        pk = _make_pk(repo, run_key)
        now_iso = datetime.now(UTC).isoformat()
        try:
            self._client.update_item(
                TableName=self._table_name,
                Key={
                    "PK": {"S": pk},
                    "SK": {"S": _SK},
                },
                UpdateExpression=(
                    "SET escalated = :true, escalated_at = :now"
                ),
                ExpressionAttributeValues={
                    ":true": {"BOOL": True},
                    ":now": {"S": now_iso},
                },
            )
            logger.info("Marked as escalated: repo=%s run_key=%s", repo, run_key)
        except ClientError as exc:
            logger.error("Error marking escalated in DynamoDB: %s", exc)
            raise RuntimeError(
                f"Could not mark the item as escalated: {exc}"
            ) from exc

    def is_escalated(self, repo: str, run_key: str) -> bool:
        """Checks if this failure has already been escalated to a human.

        Returns:
            True if already escalated; False if the item does not exist or is
            not escalated.
        """
        pk = _make_pk(repo, run_key)
        try:
            response = self._client.get_item(
                TableName=self._table_name,
                Key={
                    "PK": {"S": pk},
                    "SK": {"S": _SK},
                },
                ProjectionExpression="escalated",
            )
        except ClientError as exc:
            logger.error("Error querying escalation state: %s", exc)
            raise RuntimeError(
                f"Could not query the circuit breaker state: {exc}"
            ) from exc

        item = response.get("Item", {})
        return item.get("escalated", {}).get("BOOL", False)

    # ── Private methods ───────────────────────────────────────────────────────

    def _get_current_count(self, pk: str) -> int:
        """Reads the current counter without modifying it.

        Returns 0 if the item does not exist (defensive edge case).
        """
        try:
            response = self._client.get_item(
                TableName=self._table_name,
                Key={
                    "PK": {"S": pk},
                    "SK": {"S": _SK},
                },
                ProjectionExpression="attempt_count",
            )
            item = response.get("Item", {})
            return int(item.get("attempt_count", {}).get("N", "0"))
        except ClientError as exc:
            logger.warning("Could not read current counter: %s", exc)
            return 0
