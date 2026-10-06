/**
 * Dashboard status Lambda code, as an inline string.
 *
 * Why inline and not an asset (`lambda.Code.fromAsset`) or `NodejsFunction`?
 *  - The handler is ~60 lines with no external dependencies: SDK v3 already ships in the
 *    `nodejs20.x` runtime, so there is nothing to bundle (no esbuild, no Docker).
 *  - Inline, the code TRAVELS IN THE TEMPLATE: it shows up in full in `cdk diff`, which is
 *    exactly what you need to be able to audit before authorizing the deploy of a public URL.
 *  - The stack stays deployable without assets staged in the bootstrap bucket.
 *
 * HARD LIMIT: CloudFormation rejects a `Code.ZipFile` larger than 4096 characters. The stack
 * validates the size at synth time (see `dashboard-stack.ts`) so it fails on `cdk synth` and
 * not halfway through a `cdk deploy`.
 *
 * CommonJS on purpose: the inline ZipFile materializes as `index.js` without a `package.json`,
 * and the runtime loads it as CommonJS. An ESM `import` would blow up at startup.
 *
 * It does NOT write CORS headers: the Function URL itself injects them with its `cors` config.
 * Doing it in both places produces a duplicated `Access-Control-Allow-Origin` and the browser
 * rejects the response.
 */
export const DASHBOARD_STATUS_HANDLER = /* javascript */ `
const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || "2");
const PK_RE = /^REPO#(.+)#RUN#(.+)$/;

const str = (a) => (a && typeof a.S === "string" ? a.S : undefined);
const num = (a) => (a && a.N !== undefined ? Number(a.N) : undefined);
const bool = (a) => Boolean(a && a.BOOL === true);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async () => {
  let items = [];
  let degraded = null;
  try {
    const out = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        Limit: 100,
        FilterExpression: "SK = :sk",
        ExpressionAttributeValues: { ":sk": { S: "ATTEMPT_COUNTER" } },
        ProjectionExpression: "PK, attempt_count, escalated, created_at, last_updated",
      }),
    );
    items = out.Items || [];
  } catch (err) {
    if (err && err.name === "ResourceNotFoundException") {
      degraded = "SelfHealingStack not deployed: the circuit breaker table does not exist";
    } else {
      console.error("circuit breaker scan failed:", err && err.name);
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
    pipeline: {
      // The CI workflow is block 6: there is no source of truth for the pipeline state yet.
      // 'unknown' is honest; making up 'success' would be lying in a live demo.
      status: "unknown",
      note: "pending CI (block 6): this Lambda does not query GitHub Actions yet",
    },
    circuitBreaker: rows.map(({ _createdAt, _lastUpdated, ...row }) => row),
    crew: {
      // Derived from the circuit breaker: it is the only state the crew persists today.
      timeline,
      // The crew does not store the PR URL in DynamoDB, so there is nothing to expose.
      pr: null,
    },
    generatedAt: new Date().toISOString(),
    degraded,
  });
};
`.trimStart();
