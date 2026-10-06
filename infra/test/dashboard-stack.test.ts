import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";

import { DashboardStack, DashboardStackProps } from "../src/stacks/dashboard-stack";
import { DASHBOARD_STATUS_HANDLER } from "../src/lambda/dashboard-status-handler";

/** Fictitious account/region: the tests NEVER touch AWS and need no credentials. */
const TEST_ENV = { region: "us-east-1", account: "123456789012" } as const;

const TELEMETRY_TOPIC = "ugp/telemetry/ugp-gateway-01";
const TABLE_NAME = "ugp-self-healing-circuit-breaker";

/**
 * Context that opts into the wildcard CORS origin. The stack fails closed without an explicit
 * origin, so the tests that are not about CORS synthesize through this opt-in (equivalent to
 * `-c ugp:allowWildcardCors=true`) to keep asserting the demo-default template.
 */
const ALLOW_WILDCARD_CORS = { "ugp:allowWildcardCors": "true" } as const;

function synthStack(
  props: Partial<DashboardStackProps> = {},
  context: Record<string, unknown> = ALLOW_WILDCARD_CORS,
): {
  stack: DashboardStack;
  template: Template;
} {
  const app = new cdk.App({ context });
  const stack = new DashboardStack(app, "TestDashboardStack", { env: TEST_ENV, ...props });
  return { stack, template: Template.fromStack(stack) };
}

function synth(
  props: Partial<DashboardStackProps> = {},
  context: Record<string, unknown> = ALLOW_WILDCARD_CORS,
): Template {
  return synthStack(props, context).template;
}

/** Amplify `customHeaders` of the only `AWS::Amplify::App`, flattened to a string. */
function customHeadersOf(template: Template): string {
  const app = Object.values(template.findResources("AWS::Amplify::App"))[0] as any;
  const headers = app.Properties.CustomHeaders;
  // With tokens inside (the Function URL), the property is an `Fn::Join`, not a plain string.
  return typeof headers === "string" ? headers : JSON.stringify(headers);
}

/** Every statement of every AWS::IAM::Policy in the template. */
function iamStatements(template: Template): any[] {
  const statements: any[] = [];
  Object.values(template.findResources("AWS::IAM::Policy")).forEach((resource: any) => {
    statements.push(...(resource.Properties?.PolicyDocument?.Statement ?? []));
  });
  return statements;
}

/** Statements of the policy attached to the role whose logical id matches `pattern`. */
function statementsOfRole(template: Template, pattern: RegExp): any[] {
  const roleId = Object.keys(template.findResources("AWS::IAM::Role")).find((id) =>
    pattern.test(id),
  );
  expect(roleId).toBeDefined();

  const statements: any[] = [];
  Object.values(template.findResources("AWS::IAM::Policy")).forEach((resource: any) => {
    const roles = (resource.Properties?.Roles ?? []) as Array<{ Ref?: string }>;
    if (roles.some((r) => r.Ref === roleId)) {
      statements.push(...(resource.Properties?.PolicyDocument?.Statement ?? []));
    }
  });
  return statements;
}

function trustPolicyOfRole(template: Template, pattern: RegExp): any {
  const entry = Object.entries(template.findResources("AWS::IAM::Role")).find(([id]) =>
    pattern.test(id),
  );
  expect(entry).toBeDefined();
  return entry![1].Properties.AssumeRolePolicyDocument;
}

/** Flattens actions (string | string[]) into an array. */
function actionsOf(statement: any): string[] {
  const action = statement.Action;
  return Array.isArray(action) ? action : [action];
}

function flat(value: unknown): string {
  return JSON.stringify(value);
}

describe("DashboardStack — read-only dashboard backend", () => {
  let template: Template;

  beforeEach(() => {
    template = synth();
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Cognito Identity Pool (guest access)", () => {
    it("Allows unauthenticated identities and does not enable the classic flow", () => {
      template.hasResourceProperties("AWS::Cognito::IdentityPool", {
        IdentityPoolName: "ugp_dashboard_guest",
        AllowUnauthenticatedIdentities: true,
        AllowClassicFlow: false,
      });
    });

    it("Declares no identity provider (there is no login)", () => {
      const pool = Object.values(template.findResources("AWS::Cognito::IdentityPool"))[0] as any;
      expect(pool.Properties.CognitoIdentityProviders).toBeUndefined();
      expect(pool.Properties.SupportedLoginProviders).toBeUndefined();
      expect(pool.Properties.OpenIdConnectProviderARNs).toBeUndefined();
      expect(pool.Properties.SamlProviderARNs).toBeUndefined();
    });

    it("Only attaches the unauthenticated role (there is no authenticated role)", () => {
      const attachments = template.findResources("AWS::Cognito::IdentityPoolRoleAttachment");
      expect(Object.keys(attachments)).toHaveLength(1);
      const roles = (Object.values(attachments)[0] as any).Properties.Roles;
      expect(Object.keys(roles)).toEqual(["unauthenticated"]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Guest role — most sensitive surface (credentials in the browser)", () => {
    const GUEST_ROLE = /GuestAccessGuestRole/;

    it("The trust policy requires aud == this pool and amr == unauthenticated", () => {
      const trust = trustPolicyOfRole(template, GUEST_ROLE);
      const stmt = trust.Statement[0];

      expect(stmt.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(stmt.Principal).toEqual({ Federated: "cognito-identity.amazonaws.com" });
      // `aud` points by reference to THIS stack's pool, not to a literal id.
      expect(
        Object.keys(stmt.Condition.StringEquals["cognito-identity.amazonaws.com:aud"]),
      ).toEqual(["Ref"]);
      // `amr` is multi-valued: without ForAnyValue:StringLike the condition would never match.
      expect(stmt.Condition["ForAnyValue:StringLike"]).toEqual({
        "cognito-identity.amazonaws.com:amr": "unauthenticated",
      });
    });

    it("Carries no managed policy", () => {
      const trust = Object.entries(template.findResources("AWS::IAM::Role")).find(([id]) =>
        GUEST_ROLE.test(id),
      )!;
      expect((trust[1] as any).Properties.ManagedPolicyArns).toBeUndefined();
    });

    it("Grants EXACTLY iot:Connect + iot:Subscribe + iot:Receive and nothing else", () => {
      const statements = statementsOfRole(template, GUEST_ROLE);
      const actions = statements.flatMap(actionsOf).sort();
      expect(actions).toEqual(["iot:Connect", "iot:Receive", "iot:Subscribe"]);
      statements.forEach((s) => expect(s.Effect).toBe("Allow"));
    });

    it("iot:Connect is scoped to the dashboard client id prefix", () => {
      const stmt = statementsOfRole(template, GUEST_ROLE).find(
        (s) => s.Sid === "ConnectAsDashboardClientOnly",
      );
      expect(flat(stmt.Resource)).toContain(":client/ugp-dashboard-*");
      // The gateway client id must NOT fall inside the allowed pattern.
      expect("ugp-gateway-01".startsWith("ugp-dashboard-")).toBe(false);
    });

    it("iot:Subscribe is authorized on topicfilter/ of the exact topic (no wildcards)", () => {
      const stmt = statementsOfRole(template, GUEST_ROLE).find(
        (s) => s.Sid === "SubscribeTelemetryTopicFilterOnly",
      );
      const resource = flat(stmt.Resource);
      expect(resource).toContain(`:topicfilter/${TELEMETRY_TOPIC}`);
      expect(resource).not.toContain("topicfilter/ugp/telemetry/*");
      expect(resource).not.toContain("#");
    });

    it("iot:Receive is authorized on topic/ of the exact topic", () => {
      const stmt = statementsOfRole(template, GUEST_ROLE).find(
        (s) => s.Sid === "ReceiveTelemetryTopicOnly",
      );
      expect(flat(stmt.Resource)).toContain(`:topic/${TELEMETRY_TOPIC}`);
    });

    it("Does NOT grant iot:Publish nor access to the shadow, jobs or cognito-sync", () => {
      const actions = statementsOfRole(template, GUEST_ROLE).flatMap(actionsOf);
      [
        "iot:Publish",
        "iot:GetThingShadow",
        "iot:UpdateThingShadow",
        "iot:DescribeJobExecution",
        "iot:ListThings",
        "cognito-sync:*",
        "cognito-identity:*",
      ].forEach((forbidden) => expect(actions).not.toContain(forbidden));
    });

    it("Does NOT grant access to DynamoDB nor to any service outside iot:", () => {
      const actions = statementsOfRole(template, GUEST_ROLE).flatMap(actionsOf);
      actions.forEach((action) => expect(action.startsWith("iot:")).toBe(true));
    });

    it("No resource of the guest role is a '*' wildcard", () => {
      statementsOfRole(template, GUEST_ROLE).forEach((s) => {
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        resources.forEach((r: unknown) => expect(r).not.toBe("*"));
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Status Lambda — read-only", () => {
    const STATUS_ROLE = /StatusFunctionRole/;

    it("Runs on nodejs20.x over arm64 with bounded timeout and memory", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "ugp-dashboard-status",
        Runtime: "nodejs20.x",
        Architectures: ["arm64"],
        Handler: "index.handler",
        MemorySize: 256,
        Timeout: 10,
      });
    });

    it("Has reserved concurrency (cost cap of a public URL)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        ReservedConcurrentExecutions: 5,
      });
    });

    it("Receives the table name and the attempt cap through the environment", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: { Variables: { TABLE_NAME: TABLE_NAME, MAX_ATTEMPTS: "2" } },
      });
    });

    it("The code is inline and fits the 4096 char ZipFile limit", () => {
      expect(DASHBOARD_STATUS_HANDLER.length).toBeLessThan(4096);
      template.hasResourceProperties("AWS::Lambda::Function", {
        Code: { ZipFile: Match.stringLikeRegexp("@aws-sdk/client-dynamodb") },
      });
    });

    it("Uses its own log group with retention and sandbox deletion", () => {
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/lambda/ugp-dashboard-status",
        RetentionInDays: 7,
      });
      template.hasResource("AWS::Logs::LogGroup", { DeletionPolicy: "Delete" });
    });

    it("Its role can only READ the circuit breaker table", () => {
      const stmt = statementsOfRole(template, STATUS_ROLE).find(
        (s) => s.Sid === "ReadCircuitBreakerTableOnly",
      );
      expect(actionsOf(stmt).sort()).toEqual(["dynamodb:GetItem", "dynamodb:Scan"]);
      const resource = flat(stmt.Resource);
      expect(resource).toContain(`:table/${TABLE_NAME}`);
      // No indexes nor streams of other tables.
      expect(resource).not.toContain("/index/");
      expect(resource).not.toContain("/stream/");
    });

    it("Has NO write action on DynamoDB", () => {
      const actions = statementsOfRole(template, STATUS_ROLE).flatMap(actionsOf);
      [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:DeleteTable",
        "dynamodb:*",
      ].forEach((forbidden) => expect(actions).not.toContain(forbidden));
    });

    it("Only has dynamodb (read) and logs permissions, nothing else", () => {
      const actions = statementsOfRole(template, STATUS_ROLE).flatMap(actionsOf);
      actions.forEach((action) =>
        expect(action.startsWith("dynamodb:") || action.startsWith("logs:")).toBe(true),
      );
      expect(actions).toContain("logs:PutLogEvents");
      // `logs:CreateLogGroup` on `*` is exactly what the explicit log group avoids.
      expect(actions).not.toContain("logs:CreateLogGroup");
    });

    it("Does not carry AWSLambdaBasicExecutionRole (it grants logs over the whole account)", () => {
      const role = Object.entries(template.findResources("AWS::IAM::Role")).find(([id]) =>
        STATUS_ROLE.test(id),
      )!;
      expect((role[1] as any).Properties.ManagedPolicyArns).toBeUndefined();
    });

    it("Does not create the DynamoDB table: it is owned by SelfHealingStack", () => {
      template.resourceCountIs("AWS::DynamoDB::Table", 0);
    });

    it("Does not depend on SelfHealingStack via Fn::ImportValue", () => {
      expect(flat(template.toJSON())).not.toContain("Fn::ImportValue");
    });

    it("The handler does not invoke any DynamoDB write API", () => {
      ["PutItemCommand", "UpdateItemCommand", "DeleteItemCommand", "BatchWriteItemCommand"].forEach(
        (api) => expect(DASHBOARD_STATUS_HANDLER).not.toContain(api),
      );
    });

    it("The handler returns the data contract agreed with the frontend", () => {
      ["pipeline:", "circuitBreaker:", "crew:", "timeline", "pr: null"].forEach((key) =>
        expect(DASHBOARD_STATUS_HANDLER).toContain(key),
      );
      // The pipeline stays honest while the block 6 CI does not exist.
      expect(DASHBOARD_STATUS_HANDLER).toContain('status: "unknown"');
    });

    it("The handler does not expose the raw DynamoDB item (it filters the internal keys)", () => {
      // It projects only the needed attributes and drops the `_*` helpers from the response.
      expect(DASHBOARD_STATUS_HANDLER).toContain("ProjectionExpression");
      expect(DASHBOARD_STATUS_HANDLER).toContain("({ _createdAt, _lastUpdated, ...row })");
      expect(DASHBOARD_STATUS_HANDLER).not.toContain("expiresAt");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Function URL", () => {
    it("Is an anonymous GET with CORS configured", () => {
      template.hasResourceProperties("AWS::Lambda::Url", {
        AuthType: "NONE",
        Cors: {
          AllowMethods: ["GET"],
          AllowHeaders: ["content-type"],
          AllowOrigins: ["*"],
          MaxAge: 300,
        },
      });
    });

    it("Allows neither credentials nor write methods", () => {
      const url = Object.values(template.findResources("AWS::Lambda::Url"))[0] as any;
      expect(url.Properties.Cors.AllowCredentials).toBeUndefined();
      expect(url.Properties.Cors.AllowMethods).not.toContain("POST");
      expect(url.Properties.Cors.AllowMethods).not.toContain("*");
    });

    it("Scopes CORS to the origins passed via props", () => {
      const scoped = synth({ allowedOrigins: ["https://main.d1abc2def3.amplifyapp.com"] });
      scoped.hasResourceProperties("AWS::Lambda::Url", {
        Cors: { AllowOrigins: ["https://main.d1abc2def3.amplifyapp.com"] },
      });
    });

    // ── fail-closed ──────────────────────────────────────────────────────────
    it("FAILS CLOSED: throws with no origin and no wildcard opt-in", () => {
      expect(() => synth({}, {})).toThrow(/no CORS origin was provided/);
      expect(() => synth({}, {})).toThrow(/ugp:dashboardAllowedOrigins=/);
      expect(() => synth({}, {})).toThrow(/ugp:allowWildcardCors=true/);
    });

    it("FAILS CLOSED: throws on an explicit '*' without the opt-in", () => {
      expect(() => synth({ allowedOrigins: ["*"] }, {})).toThrow(
        /'\*' was passed as a CORS origin/,
      );
      // Mixed list: the wildcard makes the other origins irrelevant, so it is still closed.
      expect(() => synth({ allowedOrigins: ["https://example.com", "*"] }, {})).toThrow(
        /ugp:allowWildcardCors=true/,
      );
    });

    it("The opt-in synthesizes with '*' and keeps the warning", () => {
      const { stack, template: optIn } = synthStack({}, ALLOW_WILDCARD_CORS);
      optIn.hasResourceProperties("AWS::Lambda::Url", { Cors: { AllowOrigins: ["*"] } });
      const warnings = Annotations.fromStack(stack).findWarning(
        "*",
        Match.stringLikeRegexp("CORS from"),
      );
      expect(warnings.length).toBeGreaterThan(0);
    });

    it("Accepts the boolean form of the opt-in context", () => {
      const t = synth({}, { "ugp:allowWildcardCors": true });
      t.hasResourceProperties("AWS::Lambda::Url", { Cors: { AllowOrigins: ["*"] } });
    });

    it("A real origin produces that exact AllowOrigins and no warning", () => {
      const origin = "https://main.d1abc2def3.amplifyapp.com";
      // No opt-in context: a scoped origin needs no escape hatch.
      const { stack, template: scoped } = synthStack({ allowedOrigins: [origin] }, {});
      const url = Object.values(scoped.findResources("AWS::Lambda::Url"))[0] as any;
      expect(url.Properties.Cors.AllowOrigins).toEqual([origin]);
      expect(
        Annotations.fromStack(stack).findWarning("*", Match.stringLikeRegexp("CORS from")),
      ).toHaveLength(0);
    });

    it("Rejects an empty list of origins", () => {
      expect(() => synth({ allowedOrigins: [] })).toThrow(/allowedOrigins cannot be an empty list/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Amplify Hosting", () => {
    it("Connects no git repository (manual deploy)", () => {
      const app = Object.values(template.findResources("AWS::Amplify::App"))[0] as any;
      expect(app.Properties.Repository).toBeUndefined();
      expect(app.Properties.OauthToken).toBeUndefined();
      expect(app.Properties.AccessToken).toBeUndefined();
      expect(app.Properties.BuildSpec).toBeUndefined();
    });

    it("Configures the SPA rewrite to /index.html with status 200", () => {
      template.hasResourceProperties("AWS::Amplify::App", {
        Name: "ugp-dashboard",
        Platform: "WEB",
        CustomRules: [{ Source: "/<*>", Target: "/index.html", Status: "200" }],
      });
    });

    it("The branch has no auto-build (with no provider there is nothing to watch)", () => {
      template.hasResourceProperties("AWS::Amplify::Branch", {
        BranchName: "main",
        Stage: "PRODUCTION",
        EnableAutoBuild: false,
      });
    });

    // ── security headers ─────────────────────────────────────────────────────
    it("Serves the baseline security headers for every object", () => {
      const headers = customHeadersOf(template);
      expect(headers).toContain("customHeaders:");
      expect(headers).toContain("pattern: '**/*'");
      [
        "Content-Security-Policy",
        "Strict-Transport-Security",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
      ].forEach((key) => expect(headers).toContain(key));

      expect(headers).toContain("max-age=31536000; includeSubDomains");
      expect(headers).toContain("nosniff");
      expect(headers).toContain("DENY");
      expect(headers).toContain("strict-origin-when-cross-origin");
    });

    it("The CSP locks the document down (no inline scripts, no framing, no plugins)", () => {
      const headers = customHeadersOf(template);
      [
        "default-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
      ].forEach((directive) => expect(headers).toContain(directive));
      // 'unsafe-inline' is tolerated for styles only (React style={{...}} attributes).
      expect(headers).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(headers).not.toContain("'unsafe-eval'");
      expect(headers).toContain("style-src 'self' 'unsafe-inline'");
    });

    it("CSP connect-src is scoped to IoT (wss), Cognito Identity and the Function URL", () => {
      const endpoint = "abc123-ats.iot.us-east-1.amazonaws.com";
      const headers = customHeadersOf(synth({ iotEndpointAddress: endpoint }));
      expect(headers).toContain(`connect-src 'self' wss://${endpoint}`);
      expect(headers).toContain("https://cognito-identity.us-east-1.amazonaws.com");
      // The Function URL is a token, so the YAML resolves to an Fn::Join carrying its GetAtt.
      expect(headers).toContain("FunctionUrl");
      // No blanket wildcard: that would defeat the point of the allow-list.
      expect(headers).not.toContain("connect-src *");
      expect(headers).not.toContain("connect-src 'self' *");
    });

    it("With an unresolved endpoint the CSP carries NO IoT host at all", () => {
      const headers = customHeadersOf(template);
      // Not the sentence (invalid CSP source) and not a region-wide wildcard either: that
      // pattern would allow ANY account's IoT endpoint in the region, and on this branch
      // VITE_IOT_ENDPOINT is the sentinel so the SPA cannot connect to IoT anyway.
      expect(headers).not.toContain("UNRESOLVED");
      expect(headers).not.toContain("*.iot.");
      expect(headers).not.toContain("wss://");
      // The rest of the allow-list is intact.
      expect(headers).toContain(
        "connect-src 'self' https://cognito-identity.us-east-1.amazonaws.com",
      );
      expect(headers).toContain("FunctionUrl");
    });

    it("The CSP region follows the stack env", () => {
      const { template: eu } = synthStack({
        env: { account: TEST_ENV.account, region: "eu-west-1" },
      } as Partial<DashboardStackProps>);
      const headers = customHeadersOf(eu);
      expect(headers).toContain("https://cognito-identity.eu-west-1.amazonaws.com");
      expect(headers).not.toContain("cognito-identity.us-east-1");
    });

    it("Basic auth is disabled by default and the password never goes in the template", () => {      const app = Object.values(template.findResources("AWS::Amplify::App"))[0] as any;
      expect(app.Properties.BasicAuthConfig).toBeUndefined();

      // With a secret: the password is resolved at deploy time, it does not materialize in the
      // template.
      const arn =
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:ugp/dashboard/basic-auth-AbCdEf";
      const withAuth = synth({ basicAuthSecretArn: arn });
      const authApp = Object.values(withAuth.findResources("AWS::Amplify::App"))[0] as any;
      expect(authApp.Properties.BasicAuthConfig.EnableBasicAuth).toBe(true);
      expect(authApp.Properties.BasicAuthConfig.Password).toBe(
        `{{resolve:secretsmanager:${arn}:SecretString:password::}}`,
      );
      expect(flat(withAuth.toJSON())).not.toContain("password123");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Outputs and frontend contract", () => {
    it("Exposes every output the Vite build needs", () => {
      [
        "IdentityPoolId",
        "AwsRegion",
        "IotEndpoint",
        "TelemetryTopic",
        "MqttClientIdPrefix",
        "StatusApiUrl",
        "AmplifyAppId",
        "AmplifyDefaultDomain",
        "ViteEnvFile",
      ].forEach((key) => template.hasOutput(key, {}));
    });

    it("Each output maps to its VITE_* variable in the description", () => {
      const outputs = template.toJSON().Outputs as Record<string, { Description?: string }>;
      const mapping: Record<string, string> = {
        IdentityPoolId: "VITE_IDENTITY_POOL_ID",
        AwsRegion: "VITE_AWS_REGION",
        IotEndpoint: "VITE_IOT_ENDPOINT",
        TelemetryTopic: "VITE_TELEMETRY_TOPIC",
        StatusApiUrl: "VITE_STATUS_API_URL",
      };
      Object.entries(mapping).forEach(([key, viteVar]) => {
        expect(outputs[key].Description).toContain(viteVar);
      });
    });

    it("ViteEnvFile joins the five variables into a pasteable block", () => {
      const value = flat(template.toJSON().Outputs.ViteEnvFile.Value);
      [
        "VITE_AWS_REGION",
        "VITE_IDENTITY_POOL_ID",
        "VITE_IOT_ENDPOINT",
        "VITE_TELEMETRY_TOPIC",
        "VITE_STATUS_API_URL",
      ].forEach((viteVar) => expect(value).toContain(viteVar));
    });

    it("The region is not hardcoded: it comes from the stack env", () => {
      const { template: euTemplate } = synthStack({
        env: { account: TEST_ENV.account, region: "eu-west-1" },
      } as Partial<DashboardStackProps>);
      euTemplate.hasOutput("AwsRegion", { Value: "eu-west-1" });
    });

    it("ARNs are composed with tokens, not with the literal partition", () => {
      // `Arn.format` emits `arn:${AWS::Partition}:...`; a hand-written ARN would end up as a
      // plain "arn:aws:..." string and this assertion would catch it.
      const guestStatements = statementsOfRole(template, /GuestAccessGuestRole/);
      const statusStatements = statementsOfRole(template, /StatusFunctionRole/).filter(
        (s) => s.Sid === "ReadCircuitBreakerTableOnly",
      );
      [...guestStatements, ...statusStatements].forEach((stmt) => {
        expect(flat(stmt.Resource)).toContain('{"Ref":"AWS::Partition"}');
      });
      // And the account is never hand-written in the stack source code.
      expect(iamStatements(template).length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("IoT endpoint", () => {
    it("Without context it stays UNRESOLVED, says how to fix it and warns at synth time", () => {
      const { stack, template: t } = synthStack();
      t.hasOutput("IotEndpoint", {
        Value: "UNRESOLVED (pass -c ugp:iotEndpoint=... or -c ugp:resolveIotEndpoint=true)",
      });
      expect(
        Annotations.fromStack(stack).findWarning("*", Match.stringLikeRegexp("VITE_IOT_ENDPOINT")),
      ).not.toHaveLength(0);
    });

    it("Never hardcodes a real ATS endpoint when unresolved", () => {
      // An '-ats.iot.' host in the template would mean someone pasted the account's endpoint.
      expect(flat(synth().toJSON())).not.toContain("-ats.iot.");
    });

    it("Uses the endpoint passed via props without creating custom resources", () => {
      const t = synth({ iotEndpointAddress: "abc123-ats.iot.us-east-1.amazonaws.com" });
      t.hasOutput("IotEndpoint", { Value: "abc123-ats.iot.us-east-1.amazonaws.com" });
      t.resourceCountIs("Custom::AWS", 0);
    });

    // The literal endpoint lands inside a DOUBLE-QUOTED YAML scalar in the Amplify
    // customHeaders, so a '"' closes the scalar and a ';' ends the CSP directive: both are
    // injection vectors into a security header and must not reach the template.
    it.each([
      ['a double quote', 'abc-ats.iot.us-east-1.amazonaws.com" evil: "x'],
      ['a semicolon', "abc-ats.iot.us-east-1.amazonaws.com; script-src *"],
      ['a space', "abc-ats.iot.us-east-1.amazonaws.com http://evil.test"],
      ['a foreign domain', "evil.test"],
      ['an https scheme', "https://abc-ats.iot.us-east-1.amazonaws.com"],
      ['an empty-ish value', " "],
    ])("REJECTS a literal iotEndpoint with %s at synth time", (_label, endpoint) => {
      expect(() => synth({ iotEndpointAddress: endpoint })).toThrow(
        /is not a valid AWS IoT ATS data endpoint/,
      );
    });

    it("Accepts the valid ATS endpoint shape and puts it in the CSP", () => {
      const endpoint = "example1234abcd-ats.iot.eu-west-1.amazonaws.com";
      const t = synth({ iotEndpointAddress: endpoint });
      t.hasOutput("IotEndpoint", { Value: endpoint });
      expect(customHeadersOf(t)).toContain(`connect-src 'self' wss://${endpoint}`);
    });

    it("Does NOT validate the resolved endpoint (it is a CloudFormation token)", () => {
      // The custom resource path yields `${Token[...]}`, which the regex would reject for the
      // wrong reason; `Token.isUnresolved` short-circuits it.
      expect(() => synth({ resolveIotEndpoint: true })).not.toThrow();
    });

    it("With resolveIotEndpoint it creates a read-only custom resource", () => {
      const t = synth({ resolveIotEndpoint: true });
      t.resourceCountIs("Custom::AWS", 1);

      // Only the custom resource policy statements, not the guest role ones.
      const crPolicy = Object.entries(t.findResources("AWS::IAM::Policy")).find(([id]) =>
        /IotDataEndpointCustomResourcePolicy/.test(id),
      );
      expect(crPolicy).toBeDefined();
      const actions = ((crPolicy![1] as any).Properties.PolicyDocument.Statement as any[]).flatMap(
        actionsOf,
      );
      // Describe only: no Connect, no Subscribe, no Publish, nothing that writes.
      expect(actions).toEqual(["iot:DescribeEndpoint"]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Sandbox hygiene", () => {
    it("Every stateful resource is deleted when the stack is destroyed", () => {
      ["AWS::Logs::LogGroup", "AWS::Amplify::App", "AWS::Amplify::Branch"].forEach((type) => {
        Object.values(template.findResources(type)).forEach((resource: any) => {
          expect(resource.DeletionPolicy).toBe("Delete");
        });
      });
    });

    it("Tags the resources with the web-dashboard component", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Tags: Match.arrayWith([{ Key: "Component", Value: "web-dashboard" }]),
      });
    });

    it("Validates maxAttempts against the SelfHealingStack range", () => {
      expect(() => synth({ maxAttempts: 0 })).toThrow(/maxAttempts/);
      expect(() => synth({ maxAttempts: 11 })).toThrow(/maxAttempts/);
      expect(() => synth({ maxAttempts: 3 })).not.toThrow();
    });
  });
});
