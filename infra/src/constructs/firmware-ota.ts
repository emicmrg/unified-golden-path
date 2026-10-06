import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as signer from "aws-cdk-lib/aws-signer";
import { Construct } from "constructs";

/** Props of the FirmwareOtaPipeline construct. */
export interface FirmwareOtaPipelineProps {
  /**
   * AWS Signer Signing Profile name.
   * Signer restriction: only `[0-9a-zA-Z_]` (no hyphens).
   */
  readonly signingProfileName: string;

  /**
   * AWS Signer signing platform.
   * @default signer.Platform.AWS_IOT_DEVICE_MANAGEMENT_SHA256_ECDSA
   */
  readonly signingPlatform?: signer.Platform;

  /** Validity of the generated signatures. @default 365 days */
  readonly signatureValidity?: cdk.Duration;

  /** S3 prefix where unsigned binaries are uploaded (Signer input). */
  readonly unsignedPrefix: string;

  /** S3 prefix where Signer drops the signed binaries (output, source of the OTA). */
  readonly signedPrefix: string;

  /**
   * Firmware file name as published by CI/CD (e.g. `ugp-gateway.bin`).
   * It goes in the `firmware.fileName` field of the job document; it is NOT used to build the
   * URL of the signed binary (see {@link FirmwareOtaPipeline.FIRMWARE_URL_PLACEHOLDER}).
   */
  readonly firmwareObjectName: string;

  /** OTA IoT Job Template id. Allows `[a-zA-Z0-9_-]`. */
  readonly jobTemplateId: string;
}

/**
 * FirmwareOtaPipeline — OTA control plane for the ESP32 firmware.
 *
 * It contains the four pieces AWS IoT needs for a signed OTA Update:
 *
 *  1. S3 artifact bucket (versioned — OTA uses `GetObjectVersion`).
 *  2. AWS Signer Signing Profile (binary code-signing).
 *  3. Service role that AWS IoT assumes to sign, create the stream and create the job.
 *  4. IoT Job Template with the job document the firmware interprets.
 *
 * OTA Update WIRING (the step that is NOT declarative in CloudFormation):
 * `AWS::IoT::OTAUpdate` does not exist as a CloudFormation resource; the OTA Update is an API
 * call (`iot:CreateOTAUpdate`) triggered from CI/CD when there is a new binary.
 *
 * Why the Job Template does NOT carry the signed binary URL: AWS Signer writes the signed
 * object to `<signedPrefix>/<signingJobId>`, with `signingJobId` = a UUID generated at signing
 * time. That key is not known at synth time, so the template document carries the placeholder
 * {@link FirmwareOtaPipeline.FIRMWARE_URL_PLACEHOLDER} and it is `create-ota-update` that
 * generates the final job document with the correct location.
 *
 * ```bash
 * BUCKET=$(aws cloudformation describe-stacks --stack-name UgpIotStack \
 *   --query "Stacks[0].Outputs[?OutputKey=='FirmwareBucketName'].OutputValue" --output text)
 * OTA_ROLE=$(aws cloudformation describe-stacks --stack-name UgpIotStack \
 *   --query "Stacks[0].Outputs[?OutputKey=='OtaServiceRoleArn'].OutputValue" --output text)
 * THING_ARN=$(aws cloudformation describe-stacks --stack-name UgpIotStack \
 *   --query "Stacks[0].Outputs[?OutputKey=='ThingArn'].OutputValue" --output text)
 * VERSION=1.0.1
 *
 * # 1) upload the UNSIGNED binary (Signer input)
 * aws s3 cp build/ugp-gateway.bin \
 *   "s3://$BUCKET/unsigned/$VERSION/ugp-gateway.bin"
 *
 * # 2) create the OTA Update. IoT: (a) calls Signer with our profile, (b) leaves the signed
 * #    binary in signed/<signingJobId>, (c) creates the MQTT stream and (d) creates the IoT Job
 * #    with a job document that ALREADY points at the real location of the signed binary.
 * aws iot create-ota-update \
 *   --ota-update-id "ugp-ota-$VERSION" \
 *   --description "Cold chain OTA $VERSION" \
 *   --targets "$THING_ARN" \
 *   --target-selection SNAPSHOT \
 *   --protocols MQTT \
 *   --role-arn "$OTA_ROLE" \
 *   --aws-job-executions-rollout-config '{"maximumPerMinute":5}' \
 *   --aws-job-abort-config '{"abortCriteriaList":[{"failureType":"FAILED","action":"CANCEL","thresholdPercentage":100,"minNumberOfExecutedThings":1}]}' \
 *   --aws-job-timeout-config '{"inProgressTimeoutInMinutes":15}' \
 *   --files '[{
 *     "fileName":"ugp-gateway.bin",
 *     "fileType":0,
 *     "fileLocation":{"s3Location":{"bucket":"'"$BUCKET"'","key":"unsigned/'"$VERSION"'/ugp-gateway.bin"}},
 *     "codeSigning":{"startSigningJobParameter":{
 *        "signingProfileName":"ugp_cold_chain_firmware",
 *        "destination":{"s3Destination":{"bucket":"'"$BUCKET"'","prefix":"signed/"}}}}
 *   }]'
 *
 * # 3) follow-up
 * aws iot get-ota-update --ota-update-id "ugp-ota-$VERSION"
 * ```
 *
 * Manual alternative (without inline Signer), useful for debugging: sign separately, read the
 * REAL key of the signed object and create a job with an already resolved document.
 *
 * ```bash
 * SIGNED_KEY=$(aws signer describe-signing-job --job-id "$SIGNING_JOB_ID" \
 *   --query 'signedObject.s3.key' --output text)
 * aws iot create-job --job-id "ugp-ota-manual-$VERSION" --targets "$THING_ARN" \
 *   --document "$(jq -n --arg u "\${aws:iot:s3-presigned-url:https://s3.amazonaws.com/$BUCKET/$SIGNED_KEY}" \
 *      '{operation:"ota-update",schemaVersion:"1.0",firmware:{url:$u,fileName:"ugp-gateway.bin"},rollback:{enabled:true,healthCheckSeconds:120}}')" \
 *   --presigned-url-config "{\"roleArn\":\"$OTA_ROLE\",\"expiresInSec\":3600}"
 * ```
 *
 * The Job Template of this construct (`aws iot create-job --job-template-arn ...`) provides the
 * reusable rollout/retry/abort schema; its `firmware.url` must always be overwritten.
 */
export class FirmwareOtaPipeline extends Construct {
  /**
   * Value standing in for the signed firmware URL in the Job Template document.
   *
   * It is not a URL on purpose: if a job reached the device without this value being replaced,
   * the OTA fails immediately and visibly in the firmware logs, instead of trying to download a
   * non-existent key and getting a silent 404.
   */
  public static readonly FIRMWARE_URL_PLACEHOLDER =
    "REPLACE_VIA_CREATE_OTA_UPDATE:signed-firmware-presigned-url";

  /** Firmware artifact bucket. */
  public readonly firmwareBucket: s3.Bucket;

  /** Code-signing Signing Profile. */
  public readonly signingProfile: signer.SigningProfile;

  /** Service role AWS IoT assumes for OTA/Jobs. */
  public readonly otaServiceRole: iam.Role;

  /** Reusable OTA Job Template. */
  public readonly otaJobTemplate: iot.CfnJobTemplate;

  constructor(scope: Construct, id: string, props: FirmwareOtaPipelineProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // ── 1. S3 firmware bucket ────────────────────────────────────────────────
    // `versioned: true` is a requirement of the OTA flow: the job references the exact object
    // version. SSE with S3-managed keys (SSE-S3) so that AWS Signer and the OTA service can
    // read without needing an additional KMS policy.
    this.firmwareBucket = new s3.Bucket(this, "FirmwareBucket", {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Demo sandbox: we want to be able to clean up without leftovers.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: "expire-old-firmware-versions",
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(90),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ── 2. Signing Profile (AWS Signer) ──────────────────────────────────────
    // Default platform: AWSIoTDeviceManagement-SHA256-ECDSA, the one AWS IoT Device Management
    // uses for OTA of generic devices (including ESP32 with ESP-IDF).
    // If the firmware uses the FreeRTOS OTA Agent, switch to AMAZON_FREE_RTOS_DEFAULT.
    this.signingProfile = new signer.SigningProfile(this, "FirmwareSigningProfile", {
      platform: props.signingPlatform ?? signer.Platform.AWS_IOT_DEVICE_MANAGEMENT_SHA256_ECDSA,
      signingProfileName: props.signingProfileName,
      signatureValidity: props.signatureValidity ?? cdk.Duration.days(365),
    });

    // ── 3. OTA/Jobs service role ─────────────────────────────────────────────
    // AWS IoT (iot.amazonaws.com) assumes it when creating the OTA Update / generating
    // presigned URLs. The trust conditions prevent the "confused deputy" problem: only this
    // account and only from IoT resources of this account.
    this.otaServiceRole = new iam.Role(this, "OtaServiceRole", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: {
            "aws:SourceArn": cdk.Arn.format({ service: "iot", resource: "*" }, stack),
          },
        },
      }),
      description: "Role AWS IoT assumes to sign firmware, create streams and launch IoT Jobs (OTA)",
    });

    // 3a. S3: read the unsigned binary + write the signed one.
    //     `addToPolicy` is used (not `inlinePolicies`) so the statements live in a separate
    //     AWS::IAM::Policy; that allows `iam:PassRole` on itself without creating a circular
    //     dependency in CloudFormation.
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "FirmwareBucketMetadata",
        actions: ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:ListBucket", "s3:ListBucketVersions"],
        resources: [this.firmwareBucket.bucketArn],
      }),
    );
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadUnsignedFirmware",
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [this.firmwareBucket.arnForObjects(`${props.unsignedPrefix}/*`)],
      }),
    );
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteAndReadSignedFirmware",
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
        resources: [this.firmwareBucket.arnForObjects(`${props.signedPrefix}/*`)],
      }),
    );

    // 3b. AWS Signer: it can only sign with OUR signing profile.
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SignWithProjectProfileOnly",
        actions: ["signer:StartSigningJob", "signer:GetSigningProfile"],
        resources: [this.signingProfile.signingProfileArn],
      }),
    );
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        // `signer:DescribeSigningJob` does not support resource-level permissions (the signing
        // job ARN is only known after creating it), hence the `*`.
        sid: "DescribeSigningJobs",
        actions: ["signer:DescribeSigningJob"],
        resources: ["*"],
      }),
    );

    // 3c. IoT Jobs + Streams, scoped to this account/region.
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageOtaJobs",
        actions: [
          "iot:CreateJob",
          "iot:DescribeJob",
          "iot:UpdateJob",
          "iot:CancelJob",
          "iot:DeleteJob",
          "iot:ListJobExecutionsForJob",
        ],
        resources: [
          cdk.Arn.format({ service: "iot", resource: "job", resourceName: "*" }, stack),
          cdk.Arn.format({ service: "iot", resource: "jobtemplate", resourceName: "*" }, stack),
        ],
      }),
    );
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageOtaStreams",
        actions: ["iot:CreateStream", "iot:DescribeStream", "iot:DeleteStream"],
        resources: [cdk.Arn.format({ service: "iot", resource: "stream", resourceName: "*" }, stack)],
      }),
    );
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ResolveJobTargets",
        actions: ["iot:DescribeThing", "iot:DescribeJobExecution", "iot:DescribeThingGroup"],
        resources: [
          cdk.Arn.format({ service: "iot", resource: "thing", resourceName: "*" }, stack),
          cdk.Arn.format({ service: "iot", resource: "thinggroup", resourceName: "*" }, stack),
        ],
      }),
    );

    // 3d. PassRole on itself: AWS IoT passes this role to Signer and to the streams service.
    this.otaServiceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassSelfToIot",
        actions: ["iam:PassRole"],
        resources: [this.otaServiceRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "iot.amazonaws.com" } },
      }),
    );

    // ── 4. OTA IoT Job Template ──────────────────────────────────────────────
    // IMPORTANT (design decision): this Job Template defines ONLY the *rollout schema*
    // (timeout, rate limit, retries, abort) and the shape of the document the firmware knows
    // how to parse. It does NOT contain — and cannot contain — the real location of the signed
    // binary:
    //
    //  - AWS Signer drops the signed object in `<signedPrefix>/<signingJobId>`, where
    //    `signingJobId` is a UUID that only exists AFTER running the signing job.
    //    Any fixed key we put here would resolve to a silent 404.
    //  - `iot:CreateOTAUpdate` generates its OWN job document with the correct location of the
    //    signed binary (MQTT stream or presigned URL), so the `firmware.url` field of this
    //    template is an explicit, fail-loud placeholder.
    //  - `iot:CreateJob --document-parameters` does NOT apply to custom job templates
    //    (only to AWS managed templates), so it cannot be parameterized via API either.
    //
    // See `FIRMWARE_URL_PLACEHOLDER` and the class documentation block.
    const jobDocument = {
      operation: "ota-update",
      // The firmware validates this field before acting (firmware↔cloud contract).
      schemaVersion: "1.0",
      firmware: {
        // INTENTIONAL placeholder. It is replaced at runtime through one of these two paths:
        //  a) `aws iot create-ota-update` → IoT rewrites the document with the real location
        //     of the signed binary (recommended path, see the class docs).
        //  b) `aws iot create-job --document <doc>` with the already resolved document, using
        //     `${aws:iot:s3-presigned-url:https://s3.<region>.amazonaws.com/<bucket>/<key>}`
        //     where `<key>` is the REAL key returned by `signer:DescribeSigningJob`.
        // If it reached the device unreplaced, the OTA fails visibly (it is not a URL).
        url: FirmwareOtaPipeline.FIRMWARE_URL_PLACEHOLDER,
        fileName: props.firmwareObjectName,
        signingProfile: props.signingProfileName,
      },
      rollback: {
        // Contract with the firmware: after booting the new image, the device has
        // `healthCheckSeconds` to confirm health; if it does not confirm, the ESP32 bootloader
        // reverts to the previous partition (A/B scheme from `partitions.csv`).
        // DEFERRED TO BLOCK 3: the firmware implementation of the health check and of
        // `esp_ota_mark_app_valid_cancel_rollback()` ships in that block. The field is declared
        // here on purpose to pin the contract, not to simulate it.
        enabled: true,
        healthCheckSeconds: 120,
      },
    };

    this.otaJobTemplate = new iot.CfnJobTemplate(this, "OtaJobTemplate", {
      jobTemplateId: props.jobTemplateId,
      description: "A/B OTA of the cold chain gateway firmware (ESP32)",
      document: stack.toJsonString(jobDocument),
      presignedUrlConfig: {
        roleArn: this.otaServiceRole.roleArn,
        expiresInSec: 3600,
      },
      timeoutConfig: {
        inProgressTimeoutInMinutes: 15,
      },
      jobExecutionsRolloutConfig: {
        maximumPerMinute: 5,
      },
      jobExecutionsRetryConfig: {
        retryCriteriaList: [{ failureType: "FAILED", numberOfRetries: 2 }],
      },
      abortConfig: {
        criteriaList: [
          {
            // Intent for the demo (fleet of 1 device): fail-fast. With a single execution, one
            // FAILED reaches 100% and the job is cancelled, so the `numberOfRetries: 2` above
            // only materializes with fleets > 1.
            // This is deliberate: in the demo we prefer a bad OTA to cut the rollout
            // immediately instead of retrying on the only gateway.
            // To consume the retries before aborting, raise `minNumberOfExecutedThings` above
            // the fleet size.
            action: "CANCEL",
            failureType: "FAILED",
            minNumberOfExecutedThings: 1,
            thresholdPercentage: 100,
          },
        ],
      },
    });
    this.otaJobTemplate.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
