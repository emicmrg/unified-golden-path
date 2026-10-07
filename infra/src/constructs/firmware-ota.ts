import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";
import * as s3 from "aws-cdk-lib/aws-s3";
// `aws-signer` is imported ONLY for the typed `Platform` enum. The signing profile itself is
// NOT created with the L1/L2 resource, and it is only created at all when
// `signingCertificateArn` is supplied — see section 2 of the constructor.
import * as signer from "aws-cdk-lib/aws-signer";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

/** Props of the FirmwareOtaPipeline construct. */
export interface FirmwareOtaPipelineProps {
  /**
   * AWS Signer Signing Profile name.
   * Signer restriction: only `[0-9a-zA-Z_]` (no hyphens).
   *
   * Only used when {@link signingCertificateArn} is supplied; with code-signing disabled no
   * profile is created and this name is not referenced anywhere in the template.
   */
  readonly signingProfileName: string;

  /**
   * ARN of the **ACM code-signing certificate** backing the signing profile. Supplying it is
   * what ENABLES code-signing — see the "Code-signing is optional" section of the class docs.
   *
   * `AWSIoTDeviceManagement-SHA256-ECDSA` is a *bring-your-own-certificate* platform:
   * `signer:PutSigningProfile` rejects the request without `signingMaterial.certificateArn`,
   * so there is no way to create a working profile for it without a real certificate.
   *
   * To enable it, import a SHA256-ECDSA code-signing certificate into ACM (self-signed is
   * enough for a sandbox) and pass the resulting ARN:
   *
   * ```bash
   * openssl ecparam -name prime256v1 -genkey -noout -out firmware-signing.key
   * openssl req -new -x509 -sha256 -days 365 -key firmware-signing.key \
   *   -out firmware-signing.crt -subj "/CN=ugp-firmware-signing" \
   *   -addext "keyUsage=critical,digitalSignature" \
   *   -addext "extendedKeyUsage=critical,codeSigning"
   * aws acm import-certificate \
   *   --certificate fileb://firmware-signing.crt --private-key fileb://firmware-signing.key
   * cdk deploy UgpIotStack -c ugp:signingCertificateArn=arn:aws:acm:...:certificate/<id>
   * ```
   *
   * @default undefined — code-signing DISABLED (no profile, no custom resource, no Signer IAM)
   */
  readonly signingCertificateArn?: string;

  /**
   * AWS Signer signing platform. Ignored when code-signing is disabled.
   * @default signer.Platform.AWS_IOT_DEVICE_MANAGEMENT_SHA256_ECDSA
   */
  readonly signingPlatform?: signer.Platform;

  /** Validity of the generated signatures. Ignored when code-signing is disabled. @default 365 days */
  readonly signatureValidity?: cdk.Duration;

  /**
   * S3 prefix where CI/CD uploads the binaries.
   *
   * With code-signing ENABLED it is the Signer input; with code-signing DISABLED (the default)
   * it is the object `create-ota-update` serves directly to the device.
   */
  readonly unsignedPrefix: string;

  /**
   * S3 prefix where Signer drops the signed binaries (output, source of the OTA).
   * Unused while code-signing is disabled, but the OTA role keeps the grant so that enabling
   * {@link signingCertificateArn} does not require a second deploy of the bucket layout.
   */
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
 *  1. S3 artifact bucket (versioned — OTA uses `GetObjectVersion`).
 *  2. AWS Signer Signing Profile — **OPTIONAL, disabled by default** (see below).
 *  3. Service role that AWS IoT assumes to create the stream, the job and the presigned URL
 *     (plus the signing job when code-signing is enabled).
 *  4. IoT Job Template with the job document the firmware interprets.
 *
 * ## Code-signing is OPTIONAL (and off by default)
 *
 * Passing {@link FirmwareOtaPipelineProps.signingCertificateArn} is what turns it on. Why it is
 * not on by default:
 *
 *  - `AWSIoTDeviceManagement-SHA256-ECDSA` is a *bring-your-own-certificate* platform:
 *    `signer:PutSigningProfile` fails without `signingMaterial.certificateArn`, and the project
 *    has no code-signing certificate in ACM. A profile cannot be created without one.
 *  - On-device signature verification is **deferred to Block 3** (debt A1: secure boot +
 *    `esp_ota_*` signature checks). Signing in the cloud while the device does not verify the
 *    signature buys exactly nothing — it would be security theater, plus it forces a
 *    `signer:PutSigningProfile` grant on `Resource: '*'` (that action has no resource-level
 *    permissions) into the stack for no benefit.
 *
 * **The OTA pipeline is fully functional without it.** On the default path the integrity chain is
 * (a) TLS 1.2+ on the S3 presigned URL (the bucket denies anything else) and (b) the SHA-256
 * digest ESP-IDF appends to every app image, which `esp_ota_end()` validates before the new
 * partition is marked bootable — so a truncated or corrupted download never boots. What is
 * missing versus a signed OTA is *authenticity* (proof of origin), which is precisely what A1
 * adds on the device side.
 *
 * To enable it: import a SHA256-ECDSA code-signing certificate into ACM and deploy with
 * `-c ugp:signingCertificateArn=<acm-arn>`. See {@link FirmwareOtaPipelineProps.signingCertificateArn}.
 *
 * ## OTA Update WIRING (the step that is NOT declarative in CloudFormation)
 *
 * `AWS::IoT::OTAUpdate` does not exist as a CloudFormation resource; the OTA Update is an API
 * call (`iot:CreateOTAUpdate`) triggered from CI/CD when there is a new binary.
 *
 * Why the Job Template does NOT carry the firmware URL: the final S3 key is only known at OTA
 * time (and with code-signing on, AWS Signer writes the signed object to
 * `<signedPrefix>/<signingJobId>` where `signingJobId` is a UUID generated at signing time), so
 * the template document carries the placeholder
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
 * # 1) upload the binary
 * aws s3 cp build/ugp-gateway.bin \
 *   "s3://$BUCKET/unsigned/$VERSION/ugp-gateway.bin"
 *
 * # 2) create the OTA Update. IoT creates the MQTT stream and the IoT Job with a job document
 * #    that ALREADY points at the real location of the binary.
 * #    DEFAULT PATH (code-signing disabled): NO `codeSigning` block.
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
 *     "fileLocation":{"s3Location":{"bucket":"'"$BUCKET"'","key":"unsigned/'"$VERSION"'/ugp-gateway.bin"}}
 *   }]'
 *
 * # 2-bis) ONLY with -c ugp:signingCertificateArn=<acm-arn>: add the inline signing job.
 * #   "codeSigning":{"startSigningJobParameter":{
 * #      "signingProfileName":"ugp_cold_chain_firmware",
 * #      "destination":{"s3Destination":{"bucket":"'"$BUCKET"'","prefix":"signed/"}}}}
 *
 * # 3) follow-up
 * aws iot get-ota-update --ota-update-id "ugp-ota-$VERSION"
 * ```
 *
 * Manual alternative, useful for debugging: create a job with an already resolved document.
 *
 * ```bash
 * aws iot create-job --job-id "ugp-ota-manual-$VERSION" --targets "$THING_ARN" \
 *   --document "$(jq -n --arg u "\${aws:iot:s3-presigned-url:https://s3.amazonaws.com/$BUCKET/$KEY}" \
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

  /**
   * `true` when {@link FirmwareOtaPipelineProps.signingCertificateArn} was supplied and the
   * signing profile (and its Signer IAM) therefore exists. `false` on the default path.
   */
  public readonly codeSigningEnabled: boolean;

  /**
   * Code-signing Signing Profile name (`create-ota-update` parameter).
   * `undefined` when code-signing is disabled — there is no profile to name.
   */
  public readonly signingProfileName?: string;

  /**
   * ARN of the code-signing Signing Profile, or `undefined` when code-signing is disabled.
   *
   * Built with {@link cdk.Arn.format} instead of read from a CloudFormation attribute, because
   * the profile is created by a custom resource (see {@link signingProfileResource}). Format per
   * the AWS Signer service authorization reference:
   * `arn:<partition>:signer:<region>:<account>:/signing-profiles/<profileName>` (note the single
   * leading slash in the resource part).
   */
  public readonly signingProfileArn?: string;

  /**
   * Custom resource that owns the lifecycle of the Signing Profile.
   * `undefined` when code-signing is disabled — NO custom resource is added to the stack.
   */
  public readonly signingProfileResource?: cr.AwsCustomResource;

  /**
   * Dedicated execution role of {@link signingProfileResource}, created only when code-signing
   * is enabled, so the `signer:PutSigningProfile` wildcard is not attached to a role CDK
   * generates implicitly. See the inline note on the singleton provider.
   */
  public readonly signingProfileResourceRole?: iam.Role;

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

    // ── 2. Code-signing profile (AWS Signer) — OPTIONAL, OFF BY DEFAULT ──────
    // GATE: no `signingCertificateArn` ⇒ no profile, no custom resource, no Signer IAM
    // anywhere in the stack. Two independent reasons (see the class docs for the long form):
    //
    //  a) `AWSIoTDeviceManagement-SHA256-ECDSA` is a bring-your-own-certificate platform:
    //     `signer:PutSigningProfile` is rejected without `signingMaterial.certificateArn`, and
    //     the project has no code-signing certificate in ACM. The profile simply cannot be
    //     created without one — deploying it unconditionally fails the stack.
    //  b) On-device signature verification is deferred to Block 3 (debt A1). Signing in the
    //     cloud while the device does not check the signature adds no security, and it would
    //     force a `signer:PutSigningProfile` grant on `Resource: '*'` into every deploy.
    //
    // The OTA pipeline below is complete without it: TLS 1.2+ presigned URL + the SHA-256
    // digest ESP-IDF embeds in the app image, validated by `esp_ota_end()` before the new
    // partition becomes bootable.
    const signingCertificateArn = props.signingCertificateArn?.trim();
    this.codeSigningEnabled = signingCertificateArn !== undefined && signingCertificateArn !== "";

    if (this.codeSigningEnabled && signingCertificateArn !== undefined) {
      // Fail fast on a malformed value: a typo here only surfaces as a CloudFormation
      // custom-resource failure several minutes into the deploy.
      if (!/^arn:[^:]*:acm:[^:]*:\d{12}:certificate\/.+$/.test(signingCertificateArn)) {
        throw new Error(
          "ugp:signingCertificateArn must be an ACM certificate ARN " +
            `(arn:<partition>:acm:<region>:<account>:certificate/<id>), got: ${signingCertificateArn}`,
        );
      }

      // WHY A CUSTOM RESOURCE AND NOT `AWS::Signer::SigningProfile`:
      // The CloudFormation registry schema for `AWS::Signer::SigningProfile` hard-codes a
      // STALE `PlatformId` enum — it only allows `AWSLambda-SHA384-ECDSA` and
      // `Notation-OCI-SHA384-ECDSA`. Deploying with `AWSIoTDeviceManagement-SHA256-ECDSA` (the
      // platform AWS IoT Device Management requires to sign OTA firmware for generic devices,
      // including the ESP32/ESP-IDF) is rejected before any API call with
      // `AWS::EarlyValidation::PropertyValidation`. It also has no way to express
      // `signingMaterial`, which that platform requires.
      //
      // The Signer SERVICE does accept it (verified with `aws signer list-signing-platforms`);
      // the gap is purely in the CFN resource schema. So we drive `signer:PutSigningProfile`
      // directly through an `AwsCustomResource`, which bypasses Early Validation while keeping
      // the profile under the stack lifecycle (created on deploy, cancelled on destroy).
      const signingPlatform =
        props.signingPlatform ?? signer.Platform.AWS_IOT_DEVICE_MANAGEMENT_SHA256_ECDSA;
      const signatureValidity = props.signatureValidity ?? cdk.Duration.days(365);

      this.signingProfileName = props.signingProfileName;
      this.signingProfileArn = cdk.Arn.format(
        {
          service: "signer",
          // Signer ARNs carry the resource inside the resourceName with a leading `/`:
          // `arn:aws:signer:<region>:<account>:/signing-profiles/<name>`.
          resource: "",
          resourceName: `signing-profiles/${props.signingProfileName}`,
          arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
        },
        stack,
      );

      // `putSigningProfile` is idempotent by profile name: on update it just publishes a new
      // profile version, so the physical id (the name) never changes and CloudFormation never
      // triggers a replacement.
      const putSigningProfile: cr.AwsSdkCall = {
        service: "Signer",
        action: "putSigningProfile", // SDK v3: PutSigningProfileCommand
        parameters: {
          profileName: props.signingProfileName,
          platformId: signingPlatform.platformId,
          // REQUIRED by AWSIoTDeviceManagement-SHA256-ECDSA (bring-your-own-certificate).
          signingMaterial: { certificateArn: signingCertificateArn },
          signatureValidityPeriod: { value: signatureValidity.toDays(), type: "DAYS" },
        },
        physicalResourceId: cr.PhysicalResourceId.of(props.signingProfileName),
      };

      // Dedicated execution role for the provider Lambda. `signer:PutSigningProfile` has NO
      // resource-level permissions in the AWS Signer service authorization reference (the
      // profile does not exist yet when the call is made), so it can only be granted on `*`.
      // Keeping that grant in a role we own and name makes the wildcard auditable instead of
      // hiding it in a CDK-generated role, and it never touches `otaServiceRole`.
      //
      // CAVEAT, stated explicitly because it is counter-intuitive: the `AwsCustomResource`
      // provider Lambda is a per-STACK singleton (fixed uuid), so this role backs EVERY
      // `AwsCustomResource` in the stack, and all of them execute the same function code. The
      // role prop only takes effect on the FIRST `AwsCustomResource` instantiated, hence the
      // assertion after the constructor call. Per-resource isolation is not achievable with
      // the shared provider; what this buys is (1) an explicit, reviewable home for the
      // wildcard, (2) zero Signer permissions in the stack on the default path, and (3) no
      // Signer permissions leaking into the IoT service role.
      this.signingProfileResourceRole = new iam.Role(this, "FirmwareSigningProfileRole", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Execution role of the AwsCustomResource provider that manages the firmware signing profile",
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        ],
      });

      this.signingProfileResource = new cr.AwsCustomResource(this, "FirmwareSigningProfile", {
        role: this.signingProfileResourceRole,
        onCreate: putSigningProfile,
        onUpdate: putSigningProfile,
        onDelete: {
          service: "Signer",
          // `cancelSigningProfile` (CancelSigningProfileCommand) is the profile-level teardown:
          // it moves the profile from ACTIVE to CANCELED so it can no longer sign. There is no
          // `DeleteSigningProfile` in the Signer API, and `revokeSigningProfile` is a different
          // operation (it invalidates already-issued SIGNATURES, not the profile).
          action: "cancelSigningProfile", // SDK v3: CancelSigningProfileCommand
          parameters: { profileName: props.signingProfileName },
          // A profile already gone/cancelled must not break `cdk destroy`.
          ignoreErrorCodesMatching: "ResourceNotFoundException|ValidationException",
        },
        // Least privilege, split by what the IAM reference actually supports:
        //  - `PutSigningProfile`: no resource types ⇒ `*` is the only grant that works.
        //  - `GetSigningProfile` / `CancelSigningProfile`: support the `signing-profile`
        //    resource type ⇒ scoped to OUR profile ARN.
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            sid: "CreateSigningProfileNoResourceLevelPerms",
            actions: ["signer:PutSigningProfile"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "ReadAndCancelProjectSigningProfileOnly",
            actions: ["signer:GetSigningProfile", "signer:CancelSigningProfile"],
            resources: [this.signingProfileArn],
          }),
        ]),
        // Supply-chain hygiene: use the SDK baked into the Lambda runtime (it ships Signer).
        installLatestAwsSdk: false,
      });

      // Enforces the "dedicated role" guarantee: if another `AwsCustomResource` had already
      // created the singleton provider, the `role` prop above would be silently ignored and
      // the wildcard would land on a CDK-generated role instead. Instantiate this construct
      // before any other `AwsCustomResource` in the stack.
      if (this.signingProfileResource.grantPrincipal !== this.signingProfileResourceRole) {
        throw new Error(
          "FirmwareOtaPipeline must be created before any other AwsCustomResource in the " +
            "stack: the provider Lambda is a per-stack singleton and its execution role is " +
            "fixed by the first instance, so the dedicated signing-profile role was ignored.",
        );
      }
    }

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
      description: this.codeSigningEnabled
        ? "Role AWS IoT assumes to sign firmware, create streams and launch IoT Jobs (OTA)"
        : "Role AWS IoT assumes to create streams and launch IoT Jobs (OTA, code-signing disabled)",
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

    // 3b. AWS Signer — ONLY when code-signing is enabled. On the default path AWS IoT never
    //     starts a signing job, so the role carries ZERO `signer:*` permissions (including
    //     `DescribeSigningJob`, whose `*` resource would otherwise be the only wildcard in the
    //     whole stack for an action that can never be exercised).
    if (this.codeSigningEnabled && this.signingProfileArn !== undefined) {
      this.otaServiceRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "SignWithProjectProfileOnly",
          actions: ["signer:StartSigningJob", "signer:GetSigningProfile"],
          resources: [this.signingProfileArn],
        }),
      );
      this.otaServiceRole.addToPolicy(
        new iam.PolicyStatement({
          // `signer:DescribeSigningJob` does not support resource-level permissions (the
          // signing job ARN is only known after creating it), hence the `*`.
          sid: "DescribeSigningJobs",
          actions: ["signer:DescribeSigningJob"],
          resources: ["*"],
        }),
      );
    }

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
        // Only advertised when a profile actually exists: a dangling profile name in the
        // document would make the firmware (and whoever reads the template) believe the image
        // is signed when it is not.
        ...(this.codeSigningEnabled ? { signingProfile: this.signingProfileName } : {}),
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

    // Typed sub-configurations: SINGLE SOURCE OF TRUTH for the rollout semantics. They are
    // passed to the L1 below AND re-used by `forcePascalCasePropertyKeys` (see the workaround
    // note after the construct) so there is no risk of the two drifting apart.
    const presignedUrlConfig: iot.CfnJobTemplate.PresignedUrlConfigProperty = {
      roleArn: this.otaServiceRole.roleArn,
      expiresInSec: 3600,
    };
    const timeoutConfig: iot.CfnJobTemplate.TimeoutConfigProperty = {
      inProgressTimeoutInMinutes: 15,
    };
    const jobExecutionsRolloutConfig: iot.CfnJobTemplate.JobExecutionsRolloutConfigProperty = {
      maximumPerMinute: 5,
    };
    const abortConfig: iot.CfnJobTemplate.AbortConfigProperty = {
      criteriaList: [
        {
          // Intent for the demo (fleet of 1 device): fail-fast. With a single execution, one
          // FAILED reaches 100% and the job is cancelled, so the `numberOfRetries: 2` of
          // `jobExecutionsRetryConfig` only materializes with fleets > 1.
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
    };

    this.otaJobTemplate = new iot.CfnJobTemplate(this, "OtaJobTemplate", {
      jobTemplateId: props.jobTemplateId,
      description: "A/B OTA of the cold chain gateway firmware (ESP32)",
      document: stack.toJsonString(jobDocument),
      presignedUrlConfig,
      timeoutConfig,
      jobExecutionsRolloutConfig,
      // NOTE: this one is NOT part of the workaround below — aws-cdk-lib already renders its
      // nested keys in the correct PascalCase (`RetryCriteriaList`/`FailureType`/
      // `NumberOfRetries`). Do not add it to `forcePascalCasePropertyKeys`.
      jobExecutionsRetryConfig: {
        retryCriteriaList: [{ failureType: "FAILED", numberOfRetries: 2 }],
      },
      abortConfig,
    });
    this.otaJobTemplate.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ── WORKAROUND: aws-cdk-lib 2.260.0 L1 casing bug on AWS::IoT::JobTemplate ───────────
    // The generated L1 for `AWS::IoT::JobTemplate` leaks the TypeScript (camelCase) key names
    // of these four sub-properties into the synthesized template — e.g. it renders
    // `AbortConfig: { criteriaList: [{ action, failureType, ... }] }` instead of
    // `AbortConfig: { CriteriaList: [{ Action, FailureType, ... }] }`.
    // CloudFormation's Early Validation rejects the change set with
    // `AWS::EarlyValidation::PropertyValidation` because those keys are unknown.
    // (`JobExecutionsRetryConfig` is unaffected — its mapper is correct.)
    //
    // This is a CASING-ONLY fix: the values come from the typed props above, untouched.
    // TODO(aws-cdk-lib): remove this whole block (and `forcePascalCasePropertyKeys`) once the
    // upstream resource mappers are fixed; the typed props alone will then be enough.
    forcePascalCasePropertyKeys(this.otaJobTemplate, {
      AbortConfig: abortConfig,
      TimeoutConfig: timeoutConfig,
      PresignedUrlConfig: presignedUrlConfig,
      JobExecutionsRolloutConfig: jobExecutionsRolloutConfig,
    });
  }
}

/** CloudFormation intrinsic function (`Ref` / `Fn::*`) rendered as an object. */
function isCfnIntrinsic(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "Ref" || keys[0].startsWith("Fn::"));
}

/**
 * Recursively upper-cases the first letter of every object key, leaving values untouched.
 * Intrinsics (`Ref`, `Fn::*`) and unresolved tokens are passed through verbatim.
 *
 * Part of the `AWS::IoT::JobTemplate` casing workaround — see {@link forcePascalCasePropertyKeys}.
 */
function pascalCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pascalCaseKeys);
  }
  if (value !== null && typeof value === "object" && !cdk.Token.isUnresolved(value)) {
    const record = value as Record<string, unknown>;
    if (isCfnIntrinsic(record)) {
      return record;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, nested]) => [
        key.charAt(0).toUpperCase() + key.slice(1),
        pascalCaseKeys(nested),
      ]),
    );
  }
  return value;
}

/**
 * Forces the given top-level resource properties to be synthesized with PascalCase sub-keys.
 *
 * WORKAROUND for the aws-cdk-lib 2.260.0 L1 casing bug on `AWS::IoT::JobTemplate`, whose
 * property mappers emit the TypeScript (camelCase) key names for the nested structures, which
 * CloudFormation Early Validation rejects (`AWS::EarlyValidation::PropertyValidation`).
 *
 * For every block it (a) overrides the property with a PascalCase copy of the SAME values and
 * (b) adds an explicit deletion override for each original camelCase key — necessary because
 * CDK *deep-merges* raw overrides into the rendered properties, so without (b) both spellings
 * would end up in the template.
 *
 * TODO(aws-cdk-lib): delete this helper once the upstream mappers are fixed.
 *
 * @param resource  L1 resource to patch.
 * @param blocks    Map of PascalCase property name → the typed (camelCase) config object that
 *                  was passed to the L1, used as the single source of truth for the values.
 */
function forcePascalCasePropertyKeys(
  resource: cdk.CfnResource,
  blocks: Record<string, object>,
): void {
  for (const [propertyName, config] of Object.entries(blocks)) {
    resource.addPropertyOverride(propertyName, pascalCaseKeys(config));
    for (const camelCaseKey of Object.keys(config)) {
      resource.addPropertyDeletionOverride(`${propertyName}.${camelCaseKey}`);
    }
  }
}
