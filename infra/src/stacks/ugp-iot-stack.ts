import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

import { CertificateProvisioningMode, EdgeDevice } from "../constructs/edge-device";
import { FirmwareOtaPipeline } from "../constructs/firmware-ota";

/** Use-case defaults (clinical cold chain, 1 ESP32 gateway). */
const DEFAULTS = {
  thingName: "ugp-gateway-01",
  thingTypeName: "ugp-cold-chain-gateway",
  thingTypeDescription:
    "ESP32 environmental monitoring gateway (temperature + humidity) for the clinical cold chain",
  telemetryTopicPrefix: "ugp/telemetry",
  commandTopicPrefix: "ugp/commands",
  /** MAC of the demo ESP32-D0WD-V3. It is not a secret: it is hardware identity. */
  macAddress: "70:4b:ca:8f:23:10",
  site: "gdl-innovation-labs",
  hardware: "esp32-d0wd-v3",
  /** AWS Signer only accepts [0-9a-zA-Z_] in the profile name. */
  signingProfileName: "ugp_cold_chain_firmware",
  unsignedPrefix: "unsigned",
  signedPrefix: "signed",
  firmwareObjectName: "ugp-gateway.bin",
  jobTemplateId: "ugp-cold-chain-ota",
} as const;

/** Props of UgpIotStack. */
export interface UgpIotStackProps extends cdk.StackProps {
  /** Thing name. @default 'ugp-gateway-01' */
  readonly thingName?: string;

  /** Thing Type name. @default 'ugp-cold-chain-gateway' */
  readonly thingTypeName?: string;

  /** PEM CSR so that AWS IoT issues the device certificate. */
  readonly deviceCsrPem?: string;

  /** ARN of a certificate already registered in the account (alternative to the CSR). */
  readonly deviceCertificateArn?: string;

  /**
   * If `true`, adds a read-only custom resource (`iot:DescribeEndpoint`) to expose the ATS
   * data endpoint as an output. It adds a Lambda to the stack, which is why it is opt-in.
   * @default false
   */
  readonly resolveIotEndpoint?: boolean;
}

/**
 * UgpIotStack — control plane of The Unified Golden Path *edge platform*.
 *
 * Creates the gateway registration in AWS IoT Core (Thing Type, Thing, X.509 certificate and a
 * least-privilege IoT Policy scoped by ThingName) and the signed OTA pipeline (S3 artifact
 * bucket, AWS Signer signing profile, OTA service role and IoT Job Template).
 *
 * It contains nothing hardcoded about account/region: everything comes from `props.env` /
 * `this.account`.
 */
export class UgpIotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UgpIotStackProps) {
    super(scope, id, props);

    const thingName = props.thingName ?? DEFAULTS.thingName;
    const thingTypeName = props.thingTypeName ?? DEFAULTS.thingTypeName;

    // ── Edge device: Thing Type + Thing + Policy + cert ──────────────────────
    const device = new EdgeDevice(this, "ColdChainGateway", {
      thingName,
      thingTypeName,
      thingTypeDescription: DEFAULTS.thingTypeDescription,
      telemetryTopicPrefix: DEFAULTS.telemetryTopicPrefix,
      commandTopicPrefix: DEFAULTS.commandTopicPrefix,
      macAddress: DEFAULTS.macAddress,
      site: DEFAULTS.site,
      hardware: DEFAULTS.hardware,
      certificateSigningRequestPem: props.deviceCsrPem,
      importedCertificateArn: props.deviceCertificateArn,
    });

    // ── Signed OTA pipeline ──────────────────────────────────────────────────
    const ota = new FirmwareOtaPipeline(this, "FirmwareOta", {
      signingProfileName: DEFAULTS.signingProfileName,
      unsignedPrefix: DEFAULTS.unsignedPrefix,
      signedPrefix: DEFAULTS.signedPrefix,
      firmwareObjectName: DEFAULTS.firmwareObjectName,
      jobTemplateId: DEFAULTS.jobTemplateId,
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ThingName", {
      value: device.thingName,
      description: "Gateway IoT Thing name (it is also the mandatory MQTT client id)",
    });

    new cdk.CfnOutput(this, "ThingArn", {
      value: device.thingArn,
      description: "IoT Thing ARN (use as --targets in create-ota-update/create-job)",
    });

    new cdk.CfnOutput(this, "ThingTypeArn", {
      value: device.thingTypeArn,
      description: "ARN of the cold chain gateways IoT Thing Type",
    });

    new cdk.CfnOutput(this, "IotPolicyName", {
      value: device.policyName,
      description: "Least-privilege IoT Policy scoped by ${iot:Connection.Thing.ThingName}",
    });

    new cdk.CfnOutput(this, "DeviceCertificateStatus", {
      value: device.certificateArn
        ? `${device.certificateProvisioningMode}:${device.certificateArn}`
        : "NONE: pass the context 'ugp:deviceCsrPath' (CSR) or 'ugp:deviceCertificateArn'",
      description: "Provisioning mode and ARN of the device X.509 certificate",
    });

    new cdk.CfnOutput(this, "FirmwareBucketName", {
      value: ota.firmwareBucket.bucketName,
      description: `OTA firmware bucket (upload to ${DEFAULTS.unsignedPrefix}/, Signer writes to ${DEFAULTS.signedPrefix}/)`,
    });

    new cdk.CfnOutput(this, "SigningProfileArn", {
      value: ota.signingProfile.signingProfileArn,
      description: "ARN of the AWS Signer signing profile used to sign the firmware",
    });

    new cdk.CfnOutput(this, "SigningProfileName", {
      value: ota.signingProfile.signingProfileName,
      description: "Signing profile name (create-ota-update parameter)",
    });

    new cdk.CfnOutput(this, "OtaServiceRoleArn", {
      value: ota.otaServiceRole.roleArn,
      description: "Role AWS IoT assumes to sign, create streams and launch the OTA IoT Jobs",
    });

    new cdk.CfnOutput(this, "OtaJobTemplateArn", {
      value: ota.otaJobTemplate.attrArn,
      description: "OTA IoT Job Template ARN (use with aws iot create-job --job-template-arn)",
    });

    // The IoT data endpoint is not a CloudFormation attribute. By default we only document the
    // command (it is a stable value per account/region).
    if (props.resolveIotEndpoint === true) {
      const endpoint = new cr.AwsCustomResource(this, "IotDataEndpoint", {
        onUpdate: {
          service: "Iot",
          action: "describeEndpoint",
          parameters: { endpointType: "iot:Data-ATS" },
          physicalResourceId: cr.PhysicalResourceId.of(`iot-data-ats-${this.region}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          // iot:DescribeEndpoint does not support resource-level permissions.
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        installLatestAwsSdk: false,
      });

      new cdk.CfnOutput(this, "IotDataEndpointAddress", {
        value: endpoint.getResponseField("endpointAddress"),
        description: "ATS MQTT endpoint the firmware connects to",
      });
    } else {
      new cdk.CfnOutput(this, "IotDataEndpointHint", {
        value: `aws iot describe-endpoint --endpoint-type iot:Data-ATS --region ${this.region}`,
        description:
          "Command to get the ATS MQTT endpoint (or synthesize with -c ugp:resolveIotEndpoint=true)",
      });
    }

    // Notice if the stack is synthesized without a certificate: the device will not connect.
    if (device.certificateProvisioningMode === CertificateProvisioningMode.NONE) {
      cdk.Annotations.of(this).addInfo(
        "The gateway will be registered with no certificate attached; the firmware will not be " +
          "able to connect until the X.509 certificate is provisioned.",
      );
    }
  }
}
