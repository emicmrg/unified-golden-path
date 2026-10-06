import * as cdk from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as cr from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { IotGuestIdentityPool } from "../constructs/iot-guest-identity-pool";
import { DASHBOARD_STATUS_HANDLER } from "../lambda/dashboard-status-handler";

/** CloudFormation hard limit for `AWS::Lambda::Function.Code.ZipFile`. */
const INLINE_CODE_MAX_CHARS = 4096;

/**
 * Shape of an AWS IoT ATS data endpoint: `<prefix>-ats.iot.<region>.amazonaws.com`.
 *
 * This is not cosmetic validation. The endpoint is interpolated into the CSP `connect-src` of
 * the Amplify `customHeaders` YAML, inside a DOUBLE-QUOTED scalar. A `"` would close the scalar
 * and a `;` would end the CSP directive — i.e. an operator typo (or a malicious
 * `-c ugp:iotEndpoint=...`) could inject an arbitrary CSP directive or corrupt the header. The
 * allow-list of characters here (`[a-z0-9-]`, `.`) makes both impossible by construction.
 */
const IOT_ENDPOINT_PATTERN = /^[a-z0-9-]+\.iot\.[a-z0-9-]+\.amazonaws\.com$/;

/** Dashboard defaults. */
const DEFAULTS = {
  identityPoolName: "ugp_dashboard_guest",
  /**
   * CONTRACT with `UgpIotStack` (`EdgeDevice`): the gateway publishes to
   * `<telemetryTopicPrefix>/<thingName>` = `ugp/telemetry/ugp-gateway-01`.
   * If it changes there, it must change here in the same commit: they are two different
   * stacks, CloudFormation is not going to warn about it.
   */
  telemetryTopic: "ugp/telemetry/ugp-gateway-01",
  /** Prefix required of the browser MQTT client id (see IotGuestIdentityPool). */
  clientIdPrefix: "ugp-dashboard-",
  /**
   * CONTRACT with `SelfHealingStack`: explicit, deterministic `tableName`. It is referenced by
   * NAME (and the ARN is composed with `Arn.format`) instead of through a CloudFormation
   * export/import. Reason: an `Fn::ImportValue` creates a hard dependency between stacks —
   * SelfHealingStack could no longer be deleted nor have its output renamed while
   * DashboardStack exists, and the deploy order would become coupled. With the name, both
   * stacks deploy and tear down in any order; if the table does not exist, the Lambda responds
   * in `degraded` mode instead of breaking the deploy.
   */
  circuitBreakerTableName: "ugp-self-healing-circuit-breaker",
  /** Must match `maxAttempts` of SelfHealingStack (only used to render `N/M`). */
  maxAttempts: 2,
  statusFunctionName: "ugp-dashboard-status",
  amplifyAppName: "ugp-dashboard",
  amplifyBranchName: "main",
  /** Concurrency cap of the public Function URL (see rationale in the constructor). */
  reservedConcurrency: 5,
  /**
   * Context key that opts IN to a wildcard (`*`) CORS origin on the status Function URL.
   * Without it the stack fails closed (see the guard in the constructor).
   */
  allowWildcardCorsContextKey: "ugp:allowWildcardCors",
  /**
   * Amplify custom-headers path pattern meaning "every object served by the app".
   * Amplify evaluates the patterns in order; one rule covering everything is enough for an SPA
   * whose whole surface needs the same baseline.
   */
  customHeadersPattern: "**/*",
  /** Value the `IotEndpoint` output carries when neither context key is provided. */
  unresolvedIotEndpoint:
    "UNRESOLVED (pass -c ugp:iotEndpoint=... or -c ugp:resolveIotEndpoint=true)",
} as const;

/** Props of {@link DashboardStack}. */
export interface DashboardStackProps extends cdk.StackProps {
  /**
   * Origins allowed by CORS on the status Function URL.
   *
   * There is NO wildcard default: if omitted (or if the list contains `'*'`) the stack FAILS
   * CLOSED at synth time unless the wildcard is opted into explicitly with
   * `-c ugp:allowWildcardCors=true`. See the guard in the constructor.
   */
  readonly allowedOrigins?: readonly string[];

  /** MQTT telemetry topic. @default 'ugp/telemetry/ugp-gateway-01' */
  readonly telemetryTopic?: string;

  /** Circuit breaker table name. @default 'ugp-self-healing-circuit-breaker' */
  readonly circuitBreakerTableName?: string;

  /** Attempt cap the dashboard renders as the denominator. @default 2 */
  readonly maxAttempts?: number;

  /**
   * AWS IoT ATS data endpoint (`<prefix>-ats.iot.<region>.amazonaws.com`).
   * It is stable per account+region and is NOT a secret, but it is not hardcoded either: it is
   * passed via context or resolved with {@link DashboardStackProps.resolveIotEndpoint}.
   *
   * A literal value is VALIDATED against {@link IOT_ENDPOINT_PATTERN} and synth throws if it
   * does not match: this string is interpolated into the CSP `connect-src` of the Amplify
   * headers, so it must not be able to carry `"` or `;`.
   */
  readonly iotEndpointAddress?: string;

  /**
   * If `true`, resolves the ATS endpoint with a read-only custom resource
   * (`iot:DescribeEndpoint`). It adds a Lambda to the stack, which is why it is opt-in.
   * @default false
   */
  readonly resolveIotEndpoint?: boolean;

  /**
   * ARN of a Secrets Manager secret holding `{"username": "...", "password": "..."}` to protect
   * the Amplify hosting with basic auth during rehearsals.
   *
   * TODO(demo): if the dashboard should be locked down before the talk, create the secret by
   * hand and pass its ARN. The template does NOT carry the password: it is injected as a
   * *dynamic reference* (`{{resolve:secretsmanager:...}}`) that CloudFormation resolves at
   * deploy time. While it is empty the hosting is public, which is the intended end state
   * (it is a public demo).
   */
  readonly basicAuthSecretArn?: string;
}

/**
 * DashboardStack — **read-only** backend of the `web-dashboard`.
 *
 * The dashboard is a public SPA with no login that shows three things: live gateway telemetry,
 * the golden path, and the self-healing crew timeline. For that it needs two channels with two
 * very different natures, and that separation is the design of this stack:
 *
 *  1. **Push, low latency** → MQTT over WSS against AWS IoT Core directly from the browser,
 *     with temporary credentials from a Cognito Identity Pool in guest mode
 *     ({@link IotGuestIdentityPool}). There is no backend in between: the browser is an MQTT
 *     client.
 *  2. **Pull, aggregated state** → a read-only Lambda behind a Function URL that the SPA polls.
 *     IoT is not used for this because the state (circuit breaker counters) lives in DynamoDB
 *     and is not published to any topic.
 *
 * Why there is NO API Gateway: a GET endpoint with no auth, no usage plans, no WAF and a single
 * consumer does not justify the cost nor the extra resource. A Function URL is the same HTTP
 * contract with less surface to explain.
 *
 * Security posture (the two public surfaces, made explicit):
 *  - The **guest role** hands real AWS credentials to anyone's browser. Absolute minimum:
 *     3 IoT actions, 1 topic, 1 client id prefix. Zero writes.
 *  - The **Function URL** has `authType=NONE`: it is an anonymous GET. It only returns counters
 *     and aggregated states (never the raw DynamoDB item), its role can only *read* one table,
 *     and it carries reserved concurrency to bound the cost of abuse.
 *
 * Nothing hardcoded about `account`/`region`: everything comes from `this.account` / `this.region`.
 */
export class DashboardStack extends cdk.Stack {
  /** Guest Identity Pool + IoT-subscribe-only role. */
  public readonly guestAccess: IotGuestIdentityPool;

  /** Status Lambda (read-only). */
  public readonly statusFunction: lambda.Function;

  /** Public Function URL of the status Lambda. */
  public readonly statusFunctionUrl: lambda.FunctionUrl;

  /** Amplify Hosting app (manual deploy, no git repository connected). */
  public readonly amplifyApp: amplify.CfnApp;

  constructor(scope: Construct, id: string, props: DashboardStackProps = {}) {
    super(scope, id, props);

    const telemetryTopic = props.telemetryTopic ?? DEFAULTS.telemetryTopic;
    const tableName = props.circuitBreakerTableName ?? DEFAULTS.circuitBreakerTableName;
    const maxAttempts = props.maxAttempts ?? DEFAULTS.maxAttempts;

    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new Error(
        `maxAttempts must be an integer between 1 and 10 (SelfHealingStack contract), received: ${maxAttempts}`,
      );
    }

    // ── FAIL-CLOSED on the CORS policy of the status Function URL ────────────
    // The Function URL is `authType=NONE`: CORS is the only thing deciding WHICH pages may read
    // it from their visitors' browsers. With `'*'` any site on the internet can embed this
    // endpoint, and a wildcard that is also the *default* is a wildcard nobody notices. The
    // payload is not sensitive, so the risk is low — but it is surface given away for free, and
    // the whole point of the golden path is that the insecure option has to be typed out loud.
    // Same pattern as the OIDC guard in `SelfHealingStack`: synth aborts unless the wildcard is
    // opted into EXPLICITLY, in which case only the warning below is emitted.
    const originsFromProps = props.allowedOrigins ? [...props.allowedOrigins] : undefined;
    if (originsFromProps && originsFromProps.length === 0) {
      throw new Error("allowedOrigins cannot be an empty list: use ['*'] or specific domains.");
    }

    const allowWildcardCorsContext = this.node.tryGetContext(
      DEFAULTS.allowWildcardCorsContextKey,
    );
    const allowWildcardCors =
      allowWildcardCorsContext === true || allowWildcardCorsContext === "true";
    // No origins at all is the same request as `['*']`: "let anyone read it".
    const wildcardRequested = originsFromProps === undefined || originsFromProps.includes("*");

    if (wildcardRequested && !allowWildcardCors) {
      throw new Error(
        `${id}: the status Function URL has authType=NONE and ` +
          (originsFromProps === undefined
            ? "no CORS origin was provided"
            : "'*' was passed as a CORS origin") +
          ", so the template would let ANY website read this endpoint from its visitors' " +
          "browsers. Pass the Amplify domain: " +
          "-c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com " +
          "(get it from the AmplifyDefaultDomain output; comma-separate several origins). " +
          `For a local synth/demo opt in explicitly: -c ${DEFAULTS.allowWildcardCorsContextKey}=true ` +
          "(that template keeps CORS at '*': do NOT deploy it as the final state).",
      );
    }

    const allowedOrigins = originsFromProps ?? ["*"];

    cdk.Tags.of(this).add("Component", "web-dashboard", { priority: 300 });

    // ── 1. Guest access to the telemetry (Cognito + IoT) ─────────────────────
    this.guestAccess = new IotGuestIdentityPool(this, "GuestAccess", {
      identityPoolName: DEFAULTS.identityPoolName,
      telemetryTopic,
      clientIdPrefix: DEFAULTS.clientIdPrefix,
    });

    // ── 2. Status Lambda (read-only) ─────────────────────────────────────────
    if (DASHBOARD_STATUS_HANDLER.length > INLINE_CODE_MAX_CHARS) {
      // Fail in `cdk synth`, not halfway through `cdk deploy`.
      throw new Error(
        `The inline handler is ${DASHBOARD_STATUS_HANDLER.length} characters and CloudFormation ` +
          `limits Code.ZipFile to ${INLINE_CODE_MAX_CHARS}. Move it to lambda.Code.fromAsset().`,
      );
    }

    // Explicit log group (and not the `logRetention` prop, deprecated: it creates a custom
    // resource with an extra Lambda and `logs:PutRetentionPolicy` permissions over the whole
    // account). By passing `logGroup`, CDK grants write access ONLY to this group: the role
    // does not carry `logs:CreateLogGroup` on `*`.
    const statusLogGroup = new logs.LogGroup(this, "StatusFunctionLogGroup", {
      logGroupName: `/aws/lambda/${DEFAULTS.statusFunctionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const statusRole = new iam.Role(this, "StatusFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Dashboard status Lambda role: ONLY reads the circuit breaker table + its own logs. " +
        "Zero writes.",
      // No AWSLambdaBasicExecutionRole: that managed policy allows CreateLogGroup/PutLogEvents
      // on ANY log group in the account. The explicit `logGroup` above scopes it down.
    });

    // By passing our own role, CDK does NOT add `AWSLambdaBasicExecutionRole`, so log
    // permissions must be granted by hand — and scoped to THIS log group. `grantWrite` gives
    // `logs:CreateLogStream` + `logs:PutLogEvents` on it; not `logs:CreateLogGroup` on `*`.
    statusLogGroup.grantWrite(statusRole);

    // Composed ARN, not imported: see DEFAULTS.circuitBreakerTableName for the reason.
    const circuitBreakerTableArn = cdk.Arn.format(
      { service: "dynamodb", resource: "table", resourceName: tableName },
      this,
    );

    statusRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadCircuitBreakerTableOnly",
        // `Scan` because the dashboard needs to LIST the runs and nobody knows the PKs
        // (`REPO#<org/repo>#RUN#<run_key>`) up front. A `Query` would require knowing the exact
        // PK or a GSI the table does not have. The table is tiny (one item per run, 7-day TTL),
        // so the Scan is correct here — and the handler's `Limit: 100` bounds it.
        // `GetItem` is included for the case of a per-run detail view, without widening the
        // surface: it is still the same table and still read-only.
        actions: ["dynamodb:Scan", "dynamodb:GetItem"],
        // Only the table. No `/index/*`: the table has no GSIs and must not be able to read
        // anyone else's. No `/stream/*`.
        resources: [circuitBreakerTableArn],
      }),
    );

    this.statusFunction = new lambda.Function(this, "StatusFunction", {
      functionName: DEFAULTS.statusFunctionName,
      description:
        "Aggregated golden path status for the web-dashboard (read-only, no auth)",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64, // ~20% cheaper per ms than x86, same code.
      handler: "index.handler",
      code: lambda.Code.fromInline(DASHBOARD_STATUS_HANDLER),
      role: statusRole,
      logGroup: statusLogGroup,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      // The Function URL is anonymous: with no cap, a `curl` loop scales the Lambda without
      // limit and the bill with it. 5 concurrent executions are plenty for a dashboard polling
      // every few seconds, and they turn abuse into 429s instead of cost.
      reservedConcurrentExecutions: DEFAULTS.reservedConcurrency,
      environment: {
        TABLE_NAME: tableName,
        MAX_ATTEMPTS: String(maxAttempts),
      },
    });

    // ── 3. Function URL ──────────────────────────────────────────────────────
    // `authType=NONE` is deliberate: the SPA is anonymous, it has no credentials to sign SigV4
    // with (the guest ones are only valid for IoT). The compensating control is that the
    // endpoint is read-only and returns nothing sensitive.
    this.statusFunctionUrl = this.statusFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        // Narrowed by context; a wildcard requires the explicit opt-in checked at the top of
        // the constructor:
        //   cdk deploy DashboardStack -c ugp:dashboardAllowedOrigins=https://main.d1234.amplifyapp.com
        allowedOrigins,
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ["content-type"],
        maxAge: cdk.Duration.minutes(5),
        // `allowCredentials` is left false: there are no cookies nor session to send.
      },
    });

    // Reached only on the explicit opt-in path (`-c ugp:allowWildcardCors=true`); without it the
    // fail-closed guard at the top of the constructor already aborted the synth.
    if (allowedOrigins.includes("*")) {
      cdk.Annotations.of(this).addWarningV2(
        "ugp:dashboard:cors-wildcard",
        "The status Function URL accepts CORS from '*' " +
          `(${DEFAULTS.allowWildcardCorsContextKey}=true). This template is for LOCAL SYNTH / ` +
          "DEMO: before the final deploy, narrow it to the Amplify domain with " +
          "-c ugp:dashboardAllowedOrigins=https://<branch>.<appId>.amplifyapp.com",
      );
    }

    // ── 4. IoT data endpoint ─────────────────────────────────────────────────
    // It is not a CloudFormation attribute, `iot:DescribeEndpoint` has to be called. The
    // endpoint is stable per account+region and is NOT a secret, but it is NOT hardcoded
    // either: either it is passed literally or it is resolved read-only at deploy time. With
    // neither path taken, the output says so out loud instead of shipping a wrong value.
    //
    // Resolved BEFORE the Amplify app on purpose: the CSP `connect-src` below is built from it.
    let iotEndpoint: string;
    /**
     * Host the CSP allows for the MQTT-over-WSS connection, or `undefined` when there is no
     * endpoint to allow (see the unresolved branch).
     */
    let iotCspHost: string | undefined;
    if (props.iotEndpointAddress) {
      // Only LITERAL endpoints are validated. A value coming from a custom resource is a
      // CloudFormation token (`${Token[...]}`), it never reaches this branch, and the regex
      // would reject it for the wrong reason.
      if (
        !cdk.Token.isUnresolved(props.iotEndpointAddress) &&
        !IOT_ENDPOINT_PATTERN.test(props.iotEndpointAddress)
      ) {
        throw new Error(
          `${id}: iotEndpointAddress ('${props.iotEndpointAddress}') is not a valid AWS IoT ATS ` +
            "data endpoint. Expected <prefix>-ats.iot.<region>.amazonaws.com " +
            `(pattern ${IOT_ENDPOINT_PATTERN.source}). This value is interpolated into the CSP ` +
            "connect-src of the Amplify security headers, so characters like '\"' or ';' could " +
            "corrupt the header or inject a CSP directive and are rejected here. Get the real " +
            "value with: aws iot describe-endpoint --endpoint-type iot:Data-ATS.",
        );
      }
      iotEndpoint = props.iotEndpointAddress;
      iotCspHost = props.iotEndpointAddress;
    } else if (props.resolveIotEndpoint === true) {
      const endpoint = new cr.AwsCustomResource(this, "IotDataEndpoint", {
        onUpdate: {
          service: "Iot",
          action: "describeEndpoint",
          parameters: { endpointType: "iot:Data-ATS" },
          physicalResourceId: cr.PhysicalResourceId.of(`iot-data-ats-${this.region}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          // `iot:DescribeEndpoint` does not accept resource-level permissions.
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        installLatestAwsSdk: false,
      });
      iotEndpoint = endpoint.getResponseField("endpointAddress");
      iotCspHost = iotEndpoint;
    } else {
      iotEndpoint = DEFAULTS.unresolvedIotEndpoint;
      // No IoT host in the CSP at all on this branch. Two reasons: the 'UNRESOLVED (...)'
      // sentence is not a valid CSP source (the browser would drop the whole connect-src), and
      // a region-wide `wss://*.iot.<region>.amazonaws.com` pattern would allow ANY account's
      // endpoint in the region — surface granted for nothing, because `VITE_IOT_ENDPOINT` is
      // the sentinel here, so the SPA cannot connect to IoT in this configuration anyway.
      iotCspHost = undefined;
      cdk.Annotations.of(this).addWarningV2(
        "ugp:dashboard:iot-endpoint-unresolved",
        "VITE_IOT_ENDPOINT comes out unresolved, so the Amplify CSP connect-src carries NO IoT " +
          "host (the SPA cannot open the MQTT-over-WSS connection with this template). Resolve " +
          "it with -c ugp:resolveIotEndpoint=true (read-only custom resource) or pass it " +
          "directly with -c ugp:iotEndpoint=<prefix>-ats.iot.<region>.amazonaws.com " +
          "(aws iot describe-endpoint --endpoint-type iot:Data-ATS).",
      );
    }

    // ── 5. Security headers served by Amplify Hosting ────────────────────────
    // Amplify serves the SPA from its own CloudFront distribution; without custom headers it
    // sends neither CSP nor HSTS, which on a public, anonymous dashboard means an injected
    // script could exfiltrate the guest IoT credentials the page holds in memory.
    //
    // `connect-src` is the interesting one: it is the EXACT allow-list of what this page may
    // talk to — the IoT ATS endpoint over WSS (only when it is known: see the unresolved branch
    // above), Cognito Identity (which mints the guest credentials) and the status Function URL.
    // Anything else, including an attacker's collector, is blocked by the browser. The Function
    // URL is a CloudFormation token, so the YAML below resolves to an `Fn::Join` at synth time:
    // the header is always consistent with the URL this very stack creates.
    const cognitoIdentityEndpoint = `https://cognito-identity.${this.region}.amazonaws.com`;
    const connectSrc = [
      "'self'",
      ...(iotCspHost ? [`wss://${iotCspHost}`] : []),
      cognitoIdentityEndpoint,
      // `.url` already includes the scheme and a trailing '/', which CSP reads as a path prefix.
      this.statusFunctionUrl.url,
    ].join(" ");

    const contentSecurityPolicy = [
      "default-src 'self'",
      // Vite emits hashed bundles as files: no inline <script> and no eval needed.
      "script-src 'self'",
      // 'unsafe-inline' is required for STYLE only: the SPA uses `style={{...}}` attributes
      // (e.g. SelfHealing.tsx) and React writes them as inline styles. It does not widen the
      // script surface, which is what matters here.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src ${connectSrc}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // Modern equivalent of X-Frame-Options: DENY (sent too, for old browsers).
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

    /**
     * Amplify custom headers (YAML, same schema as the console's "Custom headers" tab).
     * Double-quoted scalars on purpose: the CSP is full of single quotes (`'self'`, `'none'`),
     * which inside a single-quoted YAML scalar would have to be doubled.
     */
    const customHeaders = [
      "customHeaders:",
      `  - pattern: '${DEFAULTS.customHeadersPattern}'`,
      "    headers:",
      `      - key: 'Content-Security-Policy'`,
      `        value: "${contentSecurityPolicy}"`,
      // 1 year + subdomains. No `preload`: that is a one-way submission to the browser list and
      // this is a demo domain under amplifyapp.com.
      `      - key: 'Strict-Transport-Security'`,
      `        value: "max-age=31536000; includeSubDomains"`,
      `      - key: 'X-Content-Type-Options'`,
      `        value: "nosniff"`,
      `      - key: 'X-Frame-Options'`,
      `        value: "DENY"`,
      `      - key: 'Referrer-Policy'`,
      `        value: "strict-origin-when-cross-origin"`,
      // The dashboard reads telemetry: it needs none of these capabilities.
      `      - key: 'Permissions-Policy'`,
      `        value: "geolocation=(), camera=(), microphone=(), payment=(), usb=()"`,
      "",
    ].join("\n");

    // Optional basic auth for the rehearsals. CloudFormation's `basicAuthConfig` asks for the
    // username and password in clear text, so the password does NOT travel in the template: it
    // is injected as a Secrets Manager dynamic reference, which CloudFormation resolves at
    // deploy time. `unsafeUnwrap()` is necessary and justified: `basicAuthConfig.password` is a
    // regular string field, not a "secret" field recognized by CDK, so without the unwrap
    // `@aws-cdk/core:checkSecretUsage` aborts the synthesis.
    const basicAuthConfig = props.basicAuthSecretArn
      ? {
          enableBasicAuth: true,
          username: cdk.SecretValue.secretsManager(props.basicAuthSecretArn, {
            jsonField: "username",
          }).unsafeUnwrap(),
          password: cdk.SecretValue.secretsManager(props.basicAuthSecretArn, {
            jsonField: "password",
          }).unsafeUnwrap(),
        }
      : undefined;

    // ── 6. Amplify Hosting (MANUAL deploy, no git) ───────────────────────────
    // No `sourceCodeProvider`/`oauthToken`: the repository does not exist yet and connecting a
    // provider would require a GitHub token with `repo` scope stored in the account. An app
    // without a provider is exactly what Amplify calls "manual deployment": you upload the
    // build zip. The cost of a manual deploy is also lower: no build minutes are paid.
    this.amplifyApp = new amplify.CfnApp(this, "DashboardApp", {
      name: DEFAULTS.amplifyAppName,
      description: "Read-only SPA of the Unified Golden Path (manual deploy, no git)",
      platform: "WEB", // static SPA; 'WEB_COMPUTE' is for Next.js SSR.
      // SPA rewrite: without this, reloading /fleet returns 404 because that object does not
      // exist. `/<*>` is the Amplify syntax for "any path"; status 200 = rewrite (not
      // redirect), so the browser URL does not change and react-router resolves the route
      // client-side.
      customRules: [
        {
          source: "/<*>",
          target: "/index.html",
          status: "200",
        },
      ],
      // Security headers (CSP/HSTS/nosniff/...) built in section 5.
      customHeaders,
      basicAuthConfig,
    });
    this.amplifyApp.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const branch = new amplify.CfnBranch(this, "DashboardBranch", {
      appId: this.amplifyApp.attrAppId,
      branchName: DEFAULTS.amplifyBranchName,
      stage: "PRODUCTION",
      // With no git provider there is nothing to watch; leaving it true would only create noise.
      enableAutoBuild: false,
      enablePerformanceMode: false,
      description: "Hosting branch for the manual deploys of the Vite build",
    });
    branch.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ── 7. Outputs ───────────────────────────────────────────────────────────
    const amplifyDomain = `${branch.branchName}.${this.amplifyApp.attrDefaultDomain}`;

    new cdk.CfnOutput(this, "IdentityPoolId", {
      value: this.guestAccess.identityPoolId,
      description: "VITE_IDENTITY_POOL_ID - Cognito Identity Pool with guest access (public value)",
    });

    new cdk.CfnOutput(this, "GuestRoleArn", {
      value: this.guestAccess.unauthenticatedRole.roleArn,
      description:
        "Role handed to the anonymous browser: only iot:Connect/Subscribe/Receive on 1 topic",
    });

    new cdk.CfnOutput(this, "AwsRegion", {
      value: this.region,
      description: "VITE_AWS_REGION - region of Cognito and of the IoT endpoint",
    });

    new cdk.CfnOutput(this, "IotEndpoint", {
      value: iotEndpoint,
      description:
        "VITE_IOT_ENDPOINT - ATS MQTT endpoint for Amplify PubSub (wss://<endpoint>/mqtt)",
    });

    new cdk.CfnOutput(this, "TelemetryTopic", {
      value: telemetryTopic,
      description: "VITE_TELEMETRY_TOPIC - the only topic the guest role can subscribe to",
    });

    new cdk.CfnOutput(this, "MqttClientIdPrefix", {
      value: DEFAULTS.clientIdPrefix,
      description:
        "MANDATORY prefix of the Amplify PubSub clientId (the guest role policy requires it)",
    });

    new cdk.CfnOutput(this, "StatusApiUrl", {
      value: this.statusFunctionUrl.url,
      description: "VITE_STATUS_API_URL - status Function URL (GET, authType=NONE)",
    });

    new cdk.CfnOutput(this, "StatusFunctionRoleArn", {
      value: statusRole.roleArn,
      description: "Status Lambda role: dynamodb:Scan/GetItem on 1 table + its own logs",
    });

    new cdk.CfnOutput(this, "CircuitBreakerTableNameRead", {
      value: tableName,
      description: "DynamoDB table the Lambda reads (owned by SelfHealingStack, not created here)",
    });

    new cdk.CfnOutput(this, "AmplifyAppId", {
      value: this.amplifyApp.attrAppId,
      description: "Amplify Hosting app id (amplify create-deployment parameter)",
    });

    new cdk.CfnOutput(this, "AmplifyDefaultDomain", {
      value: amplifyDomain,
      description: "SPA domain (https://<branch>.<appId>.amplifyapp.com)",
    });

    new cdk.CfnOutput(this, "AmplifyManualDeployCommands", {
      value: cdk.Fn.join(" && ", [
        "pnpm --dir web-dashboard run build",
        "(cd web-dashboard/dist && zip -r ../dist.zip .)",
        cdk.Fn.join("", [
          "aws amplify create-deployment --app-id ",
          this.amplifyApp.attrAppId,
          ` --branch-name ${DEFAULTS.amplifyBranchName}`,
        ]),
      ]),
      description:
        "Manual deploy: create-deployment returns zipUploadUrl; upload the zip with " +
        "'curl -X PUT --upload-file dist.zip <zipUploadUrl>' and finish with " +
        "'aws amplify start-deployment --app-id <id> --branch-name main --job-id <jobId>'",
    });

    // Single block ready to paste into `web-dashboard/.env.production`.
    new cdk.CfnOutput(this, "ViteEnvFile", {
      value: cdk.Fn.join("\n", [
        cdk.Fn.join("=", ["VITE_AWS_REGION", this.region]),
        cdk.Fn.join("=", ["VITE_IDENTITY_POOL_ID", this.guestAccess.identityPoolId]),
        cdk.Fn.join("=", ["VITE_IOT_ENDPOINT", iotEndpoint]),
        cdk.Fn.join("=", ["VITE_TELEMETRY_TOPIC", telemetryTopic]),
        cdk.Fn.join("=", ["VITE_STATUS_API_URL", this.statusFunctionUrl.url]),
        cdk.Fn.join("=", ["VITE_MQTT_CLIENT_ID_PREFIX", DEFAULTS.clientIdPrefix]),
      ]),
      description:
        "Contents of web-dashboard/.env.production. Dump it with: aws cloudformation " +
        "describe-stacks --stack-name DashboardStack --query " +
        "\"Stacks[0].Outputs[?OutputKey=='ViteEnvFile'].OutputValue\" --output text",
    });
  }
}
