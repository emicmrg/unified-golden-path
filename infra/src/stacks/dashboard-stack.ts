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
} as const;

/** Props of {@link DashboardStack}. */
export interface DashboardStackProps extends cdk.StackProps {
  /**
   * Origins allowed by CORS on the status Function URL.
   *
   * @default ['*'] — and the stack emits a synth warning.
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
    const allowedOrigins = [...(props.allowedOrigins ?? ["*"])];

    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new Error(
        `maxAttempts must be an integer between 1 and 10 (SelfHealingStack contract), received: ${maxAttempts}`,
      );
    }
    if (allowedOrigins.length === 0) {
      throw new Error("allowedOrigins cannot be an empty list: use ['*'] or specific domains.");
    }

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
        // TODO(debt): narrow to the Amplify URL as soon as the domain is known:
        //   cdk deploy DashboardStack -c ugp:dashboardAllowedOrigins=https://main.d1234.amplifyapp.com
        // With '*' any page can read this endpoint from its visitors' browsers. Since the
        // payload is not sensitive the risk is low, but it is not zero: it is surface given
        // away for free and it must be closed before the talk.
        allowedOrigins,
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ["content-type"],
        maxAge: cdk.Duration.minutes(5),
        // `allowCredentials` is left false: there are no cookies nor session to send.
      },
    });

    if (allowedOrigins.includes("*")) {
      cdk.Annotations.of(this).addWarningV2(
        "ugp:dashboard:cors-wildcard",
        "The status Function URL accepts CORS from '*'. Before the final deploy, narrow it " +
          "to the Amplify domain: -c ugp:dashboardAllowedOrigins=https://<branch>.<appId>.amplifyapp.com",
      );
    }

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

    // ── 4. Amplify Hosting (MANUAL deploy, no git) ───────────────────────────
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

    // ── 5. IoT data endpoint ─────────────────────────────────────────────────
    // It is not a CloudFormation attribute, `iot:DescribeEndpoint` has to be called.
    let iotEndpoint: string;
    if (props.iotEndpointAddress) {
      iotEndpoint = props.iotEndpointAddress;
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
    } else {
      iotEndpoint = "UNRESOLVED";
      cdk.Annotations.of(this).addWarningV2(
        "ugp:dashboard:iot-endpoint-unresolved",
        "VITE_IOT_ENDPOINT comes out as 'UNRESOLVED'. Resolve it with " +
          "-c ugp:resolveIotEndpoint=true (read-only custom resource) or pass it directly with " +
          "-c ugp:iotEndpoint=<prefix>-ats.iot.<region>.amazonaws.com " +
          "(aws iot describe-endpoint --endpoint-type iot:Data-ATS).",
      );
    }

    // ── 6. Outputs ───────────────────────────────────────────────────────────
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
