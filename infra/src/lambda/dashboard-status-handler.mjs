/**
 * dashboard-status-handler.mjs — ESM Lambda handler for the dashboard status endpoint.
 *
 * Why migrated from inline to asset:
 *   The original handler was inline (lambda.Code.fromInline / ZipFile), which CloudFormation
 *   limits to 4096 characters. Adding the GitHub Actions polling logic (cache, rate-limit
 *   handling, mapping, env-var guard) pushed the handler to ~4500 characters — exceeding the
 *   hard limit. Migrating to lambda.Code.fromAsset removes the character constraint entirely
 *   and lets the file live next to the stack that uses it, staying auditable in the same diff.
 *
 * Runtime: nodejs20.x (native fetch global available, no external dependencies needed).
 * ESM on purpose: fromAsset materialises the file with its original name (.mjs), and the Node
 * ESM loader picks it up correctly without a package.json { "type": "module" }.
 */

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || "2");
const PK_RE = /^REPO#(.+)#RUN#(.+)$/;

// ---------------------------------------------------------------------------
// GitHub Actions pipeline cache (module-scope, survives warm Lambda invocations)
// ---------------------------------------------------------------------------
// The browser polls every 5 s → without cache that is ~720 calls/h against the 60/h
// unauthenticated limit. TTL of 300 s (5 min) keeps it to ≤12 calls/h from a warm container.
// CI status does not change that fast, so 5-minute staleness is fine.
//
// Additionally:
//  - On 403/429 or network error we set a cooldown (_ghCooldownUntil) for GH_COOLDOWN_MS so
//    we do NOT hammer GitHub during a rate-limit window.
//  - If the last good data is older than GH_STALE_MS we degrade to status='unknown' instead
//    of serving a potentially hours-old 'passing' forever.

/** @type {{ ts: number; data: import('./types.mjs').PipelineData } | null} */
let _ghCache = null;
/** Set to a future timestamp when GitHub returns 403/429 or network error. */
let _ghCooldownUntil = 0;

const GH_TTL_MS = 300_000;      // 300 s — cache of successful responses
const GH_COOLDOWN_MS = 300_000; // 300 s — back-off after rate-limit / network error
const GH_STALE_MS = 300_000;    // 300 s — beyond this age degrade to 'unknown'

/**
 * Fetch the last run of sample-service-ci.yml on main from the GitHub public API.
 *
 * Cache strategy (all module-scope to survive warm containers):
 *  - Fresh hit  : _ghCache is set and age < GH_TTL_MS     → return cached data.
 *  - Cooldown   : _ghCooldownUntil is in the future        → return degraded / stale without
 *                 hitting the API (avoids hammering during a rate-limit window).
 *  - Stale      : _ghCache is set but age > GH_STALE_MS   → degrade to 'unknown' even though
 *                 we have data (don't serve a 'passing' from hours ago indefinitely).
 *  - Error path : 403/429 / network error                  → set cooldown, return stale or
 *                 'unknown'.
 *
 * @returns {Promise<{ status: string; lastRun?: { id: string; conclusion: string; url: string }; note?: string }>}
 */
async function fetchPipeline() {
  const now = Date.now();

  // 1. Fresh cache hit.
  if (_ghCache && now - _ghCache.ts < GH_TTL_MS) {
    return _ghCache.data;
  }

  // 2. Still in cooldown after a previous error — serve stale or degrade without retrying.
  if (now < _ghCooldownUntil) {
    if (_ghCache) {
      const age = now - _ghCache.ts;
      if (age < GH_STALE_MS) {
        return _ghCache.data;
      }
      return { status: "unknown", note: "GitHub rate-limited — stale cache too old to serve" };
    }
    return { status: "unknown", note: "GitHub rate-limited — retrying next TTL window" };
  }

  // Env vars: either GITHUB_REPO='owner/repo' or both GITHUB_OWNER + GITHUB_REPO_NAME.
  const ghRepo =
    process.env.GITHUB_REPO ||
    (process.env.GITHUB_OWNER && process.env.GITHUB_REPO_NAME
      ? `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO_NAME}`
      : "");

  if (!ghRepo) {
    return {
      status: "unknown",
      note: "GITHUB_REPO env var not set — configure it in DashboardStack",
    };
  }

  const apiUrl =
    `https://api.github.com/repos/${ghRepo}` +
    `/actions/workflows/sample-service-ci.yml/runs?branch=main&per_page=1`;

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ugp-dashboard-status",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // AbortSignal.timeout is available in Node 18+.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    // Network error or timeout — set cooldown, then serve stale cache if we have it.
    console.warn("GitHub fetch error:", err?.message ?? err);
    _ghCooldownUntil = now + GH_COOLDOWN_MS;
    const stale = _ghCache ? _ghCache.data : null;
    if (stale && now - _ghCache.ts < GH_STALE_MS) {
      return stale;
    }
    return {
      status: "unknown",
      note: `GitHub fetch failed: ${err?.message ?? "timeout"}`,
    };
  }

  if (res.status === 403 || res.status === 429) {
    // Rate-limited — set cooldown, serve stale cache to avoid returning 'unknown' when
    // we had real data that is still fresh enough.
    console.warn("GitHub rate limit hit:", res.status);
    _ghCooldownUntil = now + GH_COOLDOWN_MS;
    const stale = _ghCache ? _ghCache.data : null;
    if (stale && now - _ghCache.ts < GH_STALE_MS) {
      return stale;
    }
    return { status: "unknown", note: "GitHub rate limit — retrying next TTL window" };
  }

  if (!res.ok) {
    console.warn("GitHub API unexpected status:", res.status);
    return { status: "unknown", note: `GitHub API returned ${res.status}` };
  }

  /** @type {{ total_count: number; workflow_runs: Array<{ id: number; status: string; conclusion: string | null; html_url: string }> }} */
  const body = await res.json();
  const run = body.workflow_runs?.[0] ?? null;

  let pipelineStatus = "unknown";
  if (run) {
    const FAILING = [
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "startup_failure", // not officially confirmed in REST docs but present in webhooks
    ];
    if (run.status === "completed" && run.conclusion === "success") {
      pipelineStatus = "passing";
    } else if (run.status === "completed" && FAILING.includes(run.conclusion ?? "")) {
      pipelineStatus = "failing";
    }
    // neutral / skipped / stale / null (in-progress) → stays 'unknown'
  }

  const data = {
    status: pipelineStatus,
    ...(run
      ? {
          lastRun: {
            id: String(run.id),
            conclusion: run.conclusion ?? "none",
            url: run.html_url,
          },
        }
      : {}),
  };

  _ghCache = { ts: now, data };
  return data;
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

const str = (a) => (a && typeof a.S === "string" ? a.S : undefined);
const num = (a) => (a && a.N !== undefined ? Number(a.N) : undefined);
const bool = (a) => Boolean(a && a.BOOL === true);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async () => {
  // Run GitHub fetch and DynamoDB scan in parallel — they are independent.
  const [pipelineResult, dynamoResult] = await Promise.allSettled([
    fetchPipeline(),
    (async () => {
      const out = await ddb.send(
        new ScanCommand({
          TableName: TABLE,
          Limit: 100,
          FilterExpression: "SK = :sk",
          ExpressionAttributeValues: { ":sk": { S: "ATTEMPT_COUNTER" } },
          ProjectionExpression:
            "PK, attempt_count, escalated, created_at, last_updated",
        }),
      );
      return out.Items || [];
    })(),
  ]);

  // Pipeline state (always present, degrades to unknown on error)
  const pipeline =
    pipelineResult.status === "fulfilled"
      ? pipelineResult.value
      : { status: "unknown", note: `Pipeline fetch threw: ${pipelineResult.reason?.message}` };

  // Circuit-breaker / DynamoDB state
  let items = [];
  let degraded = null;

  if (dynamoResult.status === "fulfilled") {
    items = dynamoResult.value;
  } else {
    const err = dynamoResult.reason;
    if (err && err.name === "ResourceNotFoundException") {
      degraded =
        "SelfHealingStack not deployed: the circuit breaker table does not exist";
    } else {
      console.error("circuit breaker scan failed:", err?.name);
      return json(503, { error: "circuit-breaker-unavailable" });
    }
  }

  const rows = items.map((it) => {
    const pk = str(it.PK) || "";
    const m = PK_RE.exec(pk);
    return {
      runKey: m ? m[2] : "unknown",
      attempts: num(it.attempt_count) || 0,
      maxAttempts: MAX_ATTEMPTS,
      escalated: bool(it.escalated),
      _createdAt: str(it.created_at),
      _lastUpdated: str(it.last_updated),
    };
  });

  const timeline = [];
  for (const r of rows) {
    if (r._createdAt) {
      timeline.push({ ts: r._createdAt, runKey: r.runKey, event: "first-attempt" });
    }
    if (r._lastUpdated && r._lastUpdated !== r._createdAt) {
      timeline.push({
        ts: r._lastUpdated,
        runKey: r.runKey,
        event: r.escalated ? "escalated-to-human" : "attempt-recorded",
        detail: r.attempts + "/" + r.maxAttempts,
      });
    }
  }
  timeline.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return json(200, {
    pipeline,
    circuitBreaker: rows.map(({ _createdAt, _lastUpdated, ...row }) => row),
    crew: { timeline, pr: null },
    generatedAt: new Date().toISOString(),
    degraded,
  });
};
