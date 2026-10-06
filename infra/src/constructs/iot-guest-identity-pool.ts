import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** Props of {@link IotGuestIdentityPool}. */
export interface IotGuestIdentityPoolProps {
  /** Identity Pool name (visible in the Cognito console). */
  readonly identityPoolName: string;

  /**
   * Exact MQTT telemetry topic the browser is allowed to subscribe to,
   * without the `topic/` or `topicfilter/` prefix (e.g. `ugp/telemetry/ugp-gateway-01`).
   *
   * It is a SPECIFIC topic on purpose: a wildcard (`ugp/telemetry/*`) would let any anonymous
   * visitor read the telemetry of the whole fleet, not just the demo gateway's.
   */
  readonly telemetryTopic: string;

  /**
   * Mandatory prefix of the browser MQTT client id (e.g. `ugp-dashboard-`).
   *
   * CONTRACT with the frontend: Amplify PubSub must connect with a `clientId` starting with
   * this prefix, otherwise the broker rejects the CONNECT. Scoping the client id prevents
   * stolen guest credentials from being used to impersonate the gateway client id
   * (`ugp-gateway-01`) and kick it off the broker: MQTT disconnects the previous client when
   * another one reuses its client id.
   */
  readonly clientIdPrefix: string;
}

/**
 * IotGuestIdentityPool — Cognito Identity Pool with **guest/unauthenticated** access whose IAM
 * role can only **subscribe** to one AWS IoT Core telemetry topic.
 *
 * Why it exists: the dashboard is public and read-only (a talk, not a product), so there is no
 * login. But MQTT over WSS against AWS IoT Core requires SigV4 credentials, and the only
 * supported way to obtain temporary credentials without a user is an Identity Pool with
 * unauthenticated identities.
 *
 * Why it is the most sensitive resource in the project: anyone who opens the dashboard gets
 * real (temporary) AWS credentials in their browser. The `identityPoolId` is public by design,
 * so **the unauth role is the only security boundary**. Hence the absolute minimum:
 * 3 IoT actions (`Connect`, `Subscribe`, `Receive`), one topic, one client id prefix.
 * No `iot:Publish` (it could not send commands to the gateway), no `iot:GetThingShadow`,
 * no DynamoDB, no `cognito-sync` (the Cognito console default, which is unnecessary here
 * because the dashboard does not sync datasets).
 */
export class IotGuestIdentityPool extends Construct {
  /** The created Identity Pool. */
  public readonly identityPool: cognito.CfnIdentityPool;

  /** Identity Pool id (public value: it is embedded in the frontend bundle). */
  public readonly identityPoolId: string;

  /** Role that STS hands out to anonymous visitors. */
  public readonly unauthenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: IotGuestIdentityPoolProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // ── 1. Identity Pool ─────────────────────────────────────────────────────
    // No `cognitoIdentityProviders`, no `supportedLoginProviders`: there are no IdPs because
    // there is no login. The pool only exists to exchange an anonymous identity for STS
    // credentials.
    this.identityPool = new cognito.CfnIdentityPool(this, "Pool", {
      identityPoolName: props.identityPoolName,
      allowUnauthenticatedIdentities: true,
      // `allowClassicFlow` is left false (the default): the basic flow lets the client call
      // `sts:AssumeRoleWithWebIdentity` on its own with the pool token. The enhanced flow
      // (`GetCredentialsForIdentity`) keeps Cognito as the only issuer and is the one that
      // honors the role attachment below.
      allowClassicFlow: false,
    });
    this.identityPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.identityPoolId = this.identityPool.ref;

    // ── 2. Unauthenticated role ──────────────────────────────────────────────
    // Trust policy exactly as AWS documents it for unauthenticated identities:
    //  - `aud` == THIS pool's id → another pool in the account cannot borrow this role.
    //  - `amr` contains 'unauthenticated' → if login is added tomorrow, an authenticated user
    //    CANNOT assume the guest role (their `amr` would carry the IdP, not 'unauthenticated').
    // `ForAnyValue:StringLike` on `amr` is mandatory: `amr` is a multi-valued key and with
    // `StringEquals` the condition would never match.
    this.unauthenticatedRole = new iam.Role(this, "GuestRole", {
      assumedBy: new iam.WebIdentityPrincipal("cognito-identity.amazonaws.com", {
        StringEquals: { "cognito-identity.amazonaws.com:aud": this.identityPoolId },
        "ForAnyValue:StringLike": {
          "cognito-identity.amazonaws.com:amr": "unauthenticated",
        },
      }),
      description:
        "Anonymous dashboard visitor: ONLY iot:Connect/Subscribe/Receive on 1 telemetry " +
        "topic. No Publish, no DynamoDB, no other services.",
      // No `managedPolicies`: neither ReadOnlyAccess nor anything similar.
      maxSessionDuration: cdk.Duration.hours(1), // the minimum IAM accepts.
    });

    const iotArn = (resource: string, resourceName: string): string =>
      cdk.Arn.format({ service: "iot", resource, resourceName }, stack);

    // 2a. CONNECT: only with a client id from the dashboard namespace.
    this.unauthenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ConnectAsDashboardClientOnly",
        actions: ["iot:Connect"],
        resources: [iotArn("client", `${props.clientIdPrefix}*`)],
      }),
    );

    // 2b. SUBSCRIBE: authorized against `topicfilter/`, NOT against `topic/`. Mixing them up is
    // the classic mistake: the subscription fails with AUTHORIZATION_FAILURE and no further hint.
    this.unauthenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SubscribeTelemetryTopicFilterOnly",
        actions: ["iot:Subscribe"],
        resources: [iotArn("topicfilter", props.telemetryTopic)],
      }),
    );

    // 2c. RECEIVE: authorized against `topic/` (the specific message the broker delivers).
    this.unauthenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReceiveTelemetryTopicOnly",
        actions: ["iot:Receive"],
        resources: [iotArn("topic", props.telemetryTopic)],
      }),
    );

    // ── 3. Role attachment ───────────────────────────────────────────────────
    // Without this the pool exists but `GetCredentialsForIdentity` fails: there is no role to
    // hand out. Only `unauthenticated` is declared; `authenticated` is omitted on purpose
    // (there is no login).
    new cognito.CfnIdentityPoolRoleAttachment(this, "RoleAttachment", {
      identityPoolId: this.identityPoolId,
      roles: { unauthenticated: this.unauthenticatedRole.roleArn },
    });
  }
}
