import * as cdk from "aws-cdk-lib";
import * as iot from "aws-cdk-lib/aws-iot";
import { Construct } from "constructs";

/**
 * Provisioning mode for the device X.509 certificate.
 *
 * CloudFormation CANNOT generate a key pair (there is no declarative equivalent of
 * `iot:CreateKeysAndCertificate`), so the certificate is resolved through one of these paths:
 *
 *  - `CSR`: we pass a PEM Certificate Signing Request; AWS IoT signs and registers the cert.
 *           The private key NEVER leaves the machine/device that generated the CSR.
 *           Recommended path.
 *  - `IMPORTED_ARN`: the cert already exists in the account (created out of band) and we only
 *           reference it to make the attachments (Thing ↔ cert ↔ policy).
 *  - `NONE`: there is no cert yet. The IoT Policy is created but not the attachments; the stack
 *           still synthesizes and emits a warning with the instructions.
 */
export enum CertificateProvisioningMode {
  CSR = "CSR",
  IMPORTED_ARN = "IMPORTED_ARN",
  NONE = "NONE",
}

/** Props of the EdgeDevice construct. */
export interface EdgeDeviceProps {
  /** IoT Thing name (also used as the MQTT client id, enforced by the policy). */
  readonly thingName: string;

  /** Name of the IoT Thing Type that groups the cold chain gateways. */
  readonly thingTypeName: string;

  /** Thing Type description. */
  readonly thingTypeDescription: string;

  /** Telemetry topic prefix (e.g. `ugp/telemetry`). No trailing slash. */
  readonly telemetryTopicPrefix: string;

  /** Cloud→device command topic prefix (e.g. `ugp/commands`). No trailing slash. */
  readonly commandTopicPrefix: string;

  /** ESP32 MAC address, as a searchable Thing attribute. */
  readonly macAddress: string;

  /** Logical site/location of the gateway (searchable attribute). */
  readonly site: string;

  /** Hardware revision (searchable attribute). */
  readonly hardware: string;

  /** PEM CSR. Mutually exclusive with `importedCertificateArn`. */
  readonly certificateSigningRequestPem?: string;

  /** ARN of an already registered certificate. Mutually exclusive with `certificateSigningRequestPem`. */
  readonly importedCertificateArn?: string;
}

/**
 * EdgeDevice — full registration of an ESP32 gateway in AWS IoT Core.
 *
 * Creates Thing Type + Thing + least-privilege IoT Policy and, when a certificate is
 * available, the Thing↔certificate and policy↔certificate attachments.
 *
 * L1 constructs (`CfnThing*`) are used because AWS IoT Core has no stable L2 for Things.
 */
export class EdgeDevice extends Construct {
  /** Name of the created Thing. */
  public readonly thingName: string;

  /** Thing Type ARN. */
  public readonly thingTypeArn: string;

  /** Thing ARN. */
  public readonly thingArn: string;

  /** Name of the least-privilege IoT Policy. */
  public readonly policyName: string;

  /** Device certificate ARN, if it could be resolved. */
  public readonly certificateArn?: string;

  /** Mode the certificate was resolved with. */
  public readonly certificateProvisioningMode: CertificateProvisioningMode;

  constructor(scope: Construct, id: string, props: EdgeDeviceProps) {
    super(scope, id);

    if (props.certificateSigningRequestPem && props.importedCertificateArn) {
      throw new Error(
        "EdgeDevice: 'certificateSigningRequestPem' and 'importedCertificateArn' are mutually exclusive.",
      );
    }

    this.thingName = props.thingName;

    // ── 1. Thing Type ────────────────────────────────────────────────────────
    // Operational note: deleting a Thing Type requires deprecating it and waiting 5 min (AWS
    // IoT API limit). CloudFormation tries anyway, so a `destroy` may take a while.
    const thingType = new iot.CfnThingType(this, "ThingType", {
      thingTypeName: props.thingTypeName,
      thingTypeProperties: {
        thingTypeDescription: props.thingTypeDescription,
        searchableAttributes: ["mac", "site", "hardware"],
      },
    });
    thingType.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.thingTypeArn = thingType.attrArn;

    // ── 2. Thing ─────────────────────────────────────────────────────────────
    // Known limitation: `AWS::IoT::Thing` does not expose `thingTypeName` in CloudFormation.
    // The Thing↔ThingType association is done at provisioning time, with:
    //   aws iot update-thing --thing-name <thing> --thing-type-name <thingType>
    // We keep the explicit dependency so the Thing Type exists before the Thing.
    const thing = new iot.CfnThing(this, "Thing", {
      thingName: props.thingName,
      attributePayload: {
        attributes: {
          mac: props.macAddress,
          site: props.site,
          hardware: props.hardware,
        },
      },
    });
    thing.addDependency(thingType);
    thing.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.thingArn = thing.attrArn;

    // ── 3. Least-privilege IoT Policy scoped by ThingName ────────────────────
    this.policyName = `${props.thingTypeName}-least-privilege`;
    const policy = new iot.CfnPolicy(this, "DevicePolicy", {
      policyName: this.policyName,
      policyDocument: this.buildLeastPrivilegePolicyDocument(props),
    });
    policy.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ── 4. Certificate and attachments ───────────────────────────────────────
    if (props.certificateSigningRequestPem) {
      const certificate = new iot.CfnCertificate(this, "DeviceCertificate", {
        certificateSigningRequest: props.certificateSigningRequestPem,
        certificateMode: "DEFAULT",
        status: "ACTIVE",
      });
      certificate.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      this.certificateArn = certificate.attrArn;
      this.certificateProvisioningMode = CertificateProvisioningMode.CSR;
    } else if (props.importedCertificateArn) {
      this.certificateArn = props.importedCertificateArn;
      this.certificateProvisioningMode = CertificateProvisioningMode.IMPORTED_ARN;
    } else {
      this.certificateProvisioningMode = CertificateProvisioningMode.NONE;
      cdk.Annotations.of(this).addWarningV2(
        "ugp:edge-device:no-certificate",
        "No CSR nor certificate ARN was provided: the IoT Policy will be created but NOT the " +
          "attachments. Generate the CSR with `openssl req -new -newkey rsa:2048 -nodes " +
          "-keyout device.key -out device.csr` and pass the context `-c ugp:deviceCsrPath=./device.csr`.",
      );
    }

    if (this.certificateArn) {
      // The principal of both attachments is the X.509 certificate ARN.
      const thingAttachment = new iot.CfnThingPrincipalAttachment(this, "ThingCertAttachment", {
        thingName: props.thingName,
        principal: this.certificateArn,
      });
      thingAttachment.addDependency(thing);

      new iot.CfnPolicyPrincipalAttachment(this, "PolicyCertAttachment", {
        policyName: policy.ref,
        principal: this.certificateArn,
      });
    }
  }

  /**
   * IoT Policy document using policy variables so that the certificate can only act on behalf
   * of ITS own Thing. Zero open topic wildcards (`topic/*`).
   *
   * Variables used (resolved by AWS IoT at connection time):
   *  - `${iot:Connection.Thing.ThingName}` → name of the Thing attached to the certificate.
   *
   * The `iot:Connection.Thing.IsAttached = true` condition guarantees the certificate is
   * actually attached to the Thing (otherwise the variable would be empty and the policy
   * would not apply).
   */
  private buildLeastPrivilegePolicyDocument(props: EdgeDeviceProps): Record<string, unknown> {
    const stack = cdk.Stack.of(this);
    // Single quotes on purpose: this is NOT a TS template literal, it is an AWS IoT policy
    // variable resolved on the broker side.
    const thingVar = "${iot:Connection.Thing.ThingName}";

    const iotArn = (resource: string, resourceName: string): string =>
      cdk.Arn.format({ service: "iot", resource, resourceName }, stack);

    /** Paths (without the `topic/` prefix) the device is allowed to publish to. */
    const publishPaths = [
      // The device's own temp+humidity telemetry.
      `${props.telemetryTopicPrefix}/${thingVar}`,
      `${props.telemetryTopicPrefix}/${thingVar}/*`,
      // The device's own AWS IoT Jobs MQTT protocol (get, start-next, update, …).
      `$aws/things/${thingVar}/jobs/*`,
      // MQTT streams used by OTA to download blocks of the signed firmware.
      `$aws/things/${thingVar}/streams/*`,
    ];

    /** Paths the device is allowed to subscribe to / receive from. */
    const subscribePaths = [
      `${props.commandTopicPrefix}/${thingVar}`,
      `${props.commandTopicPrefix}/${thingVar}/*`,
      `$aws/things/${thingVar}/jobs/*`,
      `$aws/things/${thingVar}/streams/*`,
    ];

    return {
      Version: "2012-10-17",
      Statement: [
        {
          // It can only connect with client id == its ThingName.
          Sid: "ConnectAsOwnThingOnly",
          Effect: "Allow",
          Action: ["iot:Connect"],
          Resource: [iotArn("client", thingVar)],
          Condition: {
            Bool: { "iot:Connection.Thing.IsAttached": ["true"] },
          },
        },
        {
          Sid: "PublishOwnTopicsOnly",
          Effect: "Allow",
          Action: ["iot:Publish"],
          Resource: publishPaths.map((path) => iotArn("topic", path)),
        },
        {
          Sid: "SubscribeOwnTopicFiltersOnly",
          Effect: "Allow",
          Action: ["iot:Subscribe"],
          // `iot:Subscribe` is authorized against `topicfilter/`, not against `topic/`.
          Resource: subscribePaths.map((path) => iotArn("topicfilter", path)),
        },
        {
          Sid: "ReceiveOwnTopicsOnly",
          Effect: "Allow",
          Action: ["iot:Receive"],
          Resource: subscribePaths.map((path) => iotArn("topic", path)),
        },
      ],
    };
  }
}
