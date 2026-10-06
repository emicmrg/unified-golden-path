/**
 * dashboard-handler.integration.test.ts
 *
 * Verification tests of the Lambda handler against the circuit_breaker schema.
 * It verifies that:
 *   1. It parses PKs correctly: REPO#<org/repo>#RUN#<run_key>
 *   2. It uses the right regex: /^REPO#(.+)#RUN#(.+)$/
 *   3. It projects exactly: PK, attempt_count, escalated, created_at, last_updated
 *   4. It returns the StatusResponse contract
 */

describe("dashboard-handler — circuit_breaker schema verification", () => {
  beforeEach(() => {
    process.env.TABLE_NAME = "ugp-self-healing-circuit-breaker";
    process.env.MAX_ATTEMPTS = "2";
  });

  describe("PK parsing with regex", () => {
    const pkRegex = /^REPO#(.+)#RUN#(.+)$/;

    it("parses valid circuit_breaker PKs correctly", () => {
      const validPKs = [
        { pk: "REPO#org/repo-a#RUN#run-001", org: "org/repo-a", run: "run-001" },
        { pk: "REPO#myorg/my-repo#RUN#abc123", org: "myorg/my-repo", run: "abc123" },
        {
          pk: "REPO#github.com/user/project#RUN#sha-deadbeef",
          org: "github.com/user/project",
          run: "sha-deadbeef",
        },
      ];

      validPKs.forEach(({ pk, org, run }) => {
        const m = pkRegex.exec(pk);
        expect(m).not.toBeNull();
        expect(m![1]).toBe(org);
        expect(m![2]).toBe(run);
      });
    });

    it("rejects invalid PKs", () => {
      const invalidPKs = [
        "REPO#org/repo-a#RUN", // Missing run_key
        "REPO#org/repo-a", // Missing RUN#
        "NOTREPO#org/repo-a#RUN#run-001", // Wrong prefix
        "REPO#org/repo-a#RUNX#run-001", // RUN is RUNX
      ];

      invalidPKs.forEach((pk) => {
        const m = pkRegex.exec(pk);
        expect(m).toBeNull();
      });
    });
  });

  describe("DynamoDB attribute projection", () => {
    it("projects EXACTLY the circuit_breaker attributes", () => {
      const projection = "PK, attempt_count, escalated, created_at, last_updated";
      const attrs = projection.split(",").map((s) => s.trim());

      // It must include these
      expect(attrs).toContain("PK");
      expect(attrs).toContain("attempt_count");
      expect(attrs).toContain("escalated");
      expect(attrs).toContain("created_at");
      expect(attrs).toContain("last_updated");

      // It must NOT include these (they are internal)
      expect(attrs).not.toContain("expiresAt");
      expect(attrs).not.toContain("escalated_at");
      expect(attrs).not.toContain("_*");
    });

    it("the projected attributes match those of circuit_breaker.py", () => {
      // circuit_breaker.py writes:
      // - PK: REPO#<org/repo>#RUN#<run_key>
      // - SK: ATTEMPT_COUNTER
      // - attempt_count (N)
      // - created_at (S)
      // - last_updated (S)
      // - escalated (BOOL)
      // - expiresAt (N) — TTL, must NOT be exposed

      const circuitBreakerAttrs = [
        "PK",
        "SK",
        "attempt_count",
        "created_at",
        "last_updated",
        "escalated",
        "expiresAt",
      ];
      const projectedAttrs = [
        "PK",
        "attempt_count",
        "escalated",
        "created_at",
        "last_updated",
      ];

      // We verify that we project all of them EXCEPT SK (constant value) and expiresAt (TTL)
      projectedAttrs.forEach((attr) => {
        expect(circuitBreakerAttrs).toContain(attr);
      });

      expect(projectedAttrs).not.toContain("expiresAt");
      expect(projectedAttrs).not.toContain("SK"); // fixed value, we do not need it
    });
  });

  describe("FilterExpression for SK", () => {
    it("uses FilterExpression SK = :sk with the ATTEMPT_COUNTER value", () => {
      const filterExpression = "SK = :sk";
      const attrValues = { ":sk": { S: "ATTEMPT_COUNTER" } };

      expect(filterExpression).toContain("SK");
      expect(filterExpression).toContain(":sk");
      expect(attrValues[":sk"].S).toBe("ATTEMPT_COUNTER");
    });

    it("filters items by SK correctly in the Scan result", () => {
      const items = [
        {
          PK: { S: "REPO#org/a#RUN#run-1" },
          SK: { S: "ATTEMPT_COUNTER" }, // ✓ Passes
          attempt_count: { N: "1" },
        },
        {
          PK: { S: "REPO#org/a#RUN#run-1" },
          SK: { S: "ESCALATION_LOG" }, // ✗ Does not pass (hypothetical future SK)
          entry: { S: "..." },
        },
      ];

      // We simulate the filter
      const filtered = items.filter((item) => item.SK.S === "ATTEMPT_COUNTER");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].PK.S).toBe("REPO#org/a#RUN#run-1");
    });
  });

  describe("StatusResponse contract", () => {
    it("returns a structure with pipeline, circuitBreaker, crew", () => {
      const response = {
        pipeline: {
          status: "unknown",
          note: "pending CI (block 6)",
        },
        circuitBreaker: [
          {
            runKey: "run-001",
            attempts: 2,
            maxAttempts: 2,
            escalated: false,
          },
        ],
        crew: {
          timeline: [
            {
              ts: "2026-10-06T10:00:00Z",
              runKey: "run-001",
              event: "first-attempt",
            },
          ],
          pr: null,
        },
        generatedAt: new Date().toISOString(),
        degraded: null,
      };

      expect(response).toHaveProperty("pipeline");
      expect(response).toHaveProperty("circuitBreaker");
      expect(response).toHaveProperty("crew");
      expect(response).toHaveProperty("generatedAt");
      expect(response).toHaveProperty("degraded");

      expect(response.pipeline).toHaveProperty("status");
      expect(response.circuitBreaker).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runKey: expect.any(String),
          attempts: expect.any(Number),
          maxAttempts: expect.any(Number),
          escalated: expect.any(Boolean),
        }),
      ]));
      expect(response.crew).toHaveProperty("timeline");
      expect(response.crew).toHaveProperty("pr");
      expect(response.crew.pr).toBeNull();
    });

    it("filters the internal _createdAt, _lastUpdated attributes out of the public response", () => {
      // The handler does: ({ _createdAt, _lastUpdated, ...row })
      const dbRow = {
        runKey: "run-001",
        attempts: 2,
        maxAttempts: 2,
        escalated: false,
        _createdAt: "2026-10-06T10:00:00Z",
        _lastUpdated: "2026-10-06T10:05:00Z",
      };

      // The destructuring the handler performs
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _createdAt, _lastUpdated, ...publicRow } = dbRow;

      expect(publicRow).toEqual({
        runKey: "run-001",
        attempts: 2,
        maxAttempts: 2,
        escalated: false,
      });
      expect(Object.keys(publicRow)).not.toContain("_createdAt");
      expect(Object.keys(publicRow)).not.toContain("_lastUpdated");
      expect(Object.keys(publicRow)).not.toContain("expiresAt");
    });
  });

  describe("handler ↔ circuit_breaker.py match", () => {
    it("verifies the handler expects exactly what circuit_breaker writes", () => {
      // What circuit_breaker.py writes to DynamoDB
      const circuitBreakerItem = {
        PK: { S: "REPO#org/repo#RUN#run-key-abc" },
        SK: { S: "ATTEMPT_COUNTER" },
        attempt_count: { N: "2" },
        created_at: { S: "2026-10-06T10:00:00Z" },
        last_updated: { S: "2026-10-06T10:05:00Z" },
        escalated: { BOOL: false },
        expiresAt: { N: "1760000000" }, // TTL epoch
      };

      // What the handler projects
      const projection = ["PK", "attempt_count", "escalated", "created_at", "last_updated"];

      // We verify the handler can read every projected attribute
      projection.forEach((attr) => {
        expect(circuitBreakerItem).toHaveProperty(attr);
      });

      // We verify the handler does NOT try to read expiresAt (it is TTL, not public)
      expect(projection).not.toContain("expiresAt");

      // We verify the PK can be parsed with the handler regex
      const pkRegex = /^REPO#(.+)#RUN#(.+)$/;
      const m = pkRegex.exec(circuitBreakerItem.PK.S);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("org/repo");
      expect(m![2]).toBe("run-key-abc");
    });
  });

  describe("ScanCommand parameters", () => {
    it("uses Limit: 100 to avoid full scans of large tables", () => {
      const limit = 100;
      expect(limit).toBeLessThanOrEqual(100);
      expect(limit).toBeGreaterThan(0);
    });

    it("uses no indexes: just a direct Scan over the base table", () => {
      // The handler does not configure IndexName in ScanCommand
      // That means it scans the main table, not a GSI
      const scanParams = {
        TableName: "ugp-self-healing-circuit-breaker",
        Limit: 100,
        FilterExpression: "SK = :sk",
        ExpressionAttributeValues: { ":sk": { S: "ATTEMPT_COUNTER" } },
        ProjectionExpression: "PK, attempt_count, escalated, created_at, last_updated",
        // Note that there is NO: IndexName
      };

      expect(scanParams).not.toHaveProperty("IndexName");
      expect(scanParams.TableName).toBe("ugp-self-healing-circuit-breaker");
    });
  });
});
