import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as cr from "aws-cdk-lib/custom-resources";

import { CertificateProvisioningMode, EdgeDevice } from "../src/constructs/edge-device";
import { FirmwareOtaPipeline, FirmwareOtaPipelineProps } from "../src/constructs/firmware-ota";
import { UgpIotStack } from "../src/stacks/ugp-iot-stack";

/** Dummy CSR: CloudFormation does not validate it at synth time. */
const FAKE_CSR_PEM = [
  "-----BEGIN CERTIFICATE REQUEST-----",
  "MIIBdTCB3wIBADAeMRwwGgYDVQQDExN1Z3AtZ2F0ZXdheS0wMS10ZXN0",
  "-----END CERTIFICATE REQUEST-----",
].join("\n");

const FAKE_CERT_ARN = "arn:aws:iot:us-east-1:123456789012:cert/0123456789abcdef";

/**
 * Dummy ACM code-signing certificate ARN. Only its SHAPE matters at synth time: it is what
 * flips the pipeline onto the code-signing path.
 */
const FAKE_SIGNING_CERT_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";

const TEST_ENV = { region: "us-east-1", account: "123456789012" } as const;

/** Standalone props for the construct-level tests (no code-signing unless overridden). */
const OTA_PROPS: FirmwareOtaPipelineProps = {
  signingProfileName: "ugp_cold_chain_firmware",
  unsignedPrefix: "unsigned",
  signedPrefix: "signed",
  firmwareObjectName: "ugp-gateway.bin",
  jobTemplateId: "ugp-cold-chain-ota",
};

/** Builds the stack under test with optional props. */
function synth(props: Partial<ConstructorParameters<typeof UgpIotStack>[2]> = {}): Template {
  const app = new cdk.App();
  const stack = new UgpIotStack(app, "TestUgpIotStack", { env: TEST_ENV, ...props });
  return Template.fromStack(stack);
}

/** Every statement of every AWS::IAM::Policy in the template. */
function iamStatements(template: Template): any[] {
  const statements: any[] = [];
  Object.values(template.findResources("AWS::IAM::Policy")).forEach((resource: any) => {
    statements.push(...(resource.Properties?.PolicyDocument?.Statement ?? []));
  });
  return statements;
}

function statementBySid(template: Template, sid: string): any {
  const stmt = iamStatements(template).find((s) => s.Sid === sid);
  expect(stmt).toBeDefined();
  return stmt;
}

describe("UgpIotStack — IoT/IAM security", () => {
  let template: Template;

  beforeEach(() => {
    template = synth();
  });

  describe("IoT Policy — least-privilege", () => {
    it("There is one IoT Policy for the device", () => {
      template.resourceCountIs("AWS::IoT::Policy", 1);
    });

    it("iot:Connect is scoped to client/${thing} with IsAttached=true", () => {
      const policies = template.findResources("AWS::IoT::Policy");
      Object.values(policies).forEach((resource: any) => {
        const doc = resource.Properties.PolicyDocument;
        expect(doc.Version).toBe("2012-10-17");
        const connectStmt = doc.Statement.find((s: any) => s.Sid === "ConnectAsOwnThingOnly");
        expect(connectStmt).toBeDefined();
        expect(connectStmt.Effect).toBe("Allow");
        expect(connectStmt.Action).toContain("iot:Connect");
        expect(JSON.stringify(connectStmt.Resource)).toContain(
          "client/${iot:Connection.Thing.ThingName}",
        );
        expect(connectStmt.Condition?.Bool?.["iot:Connection.Thing.IsAttached"]).toContain("true");
      });
    });

    it("Publish/Subscribe/Receive contain ${iot:Connection.Thing.ThingName}", () => {
      const policies = template.findResources("AWS::IoT::Policy");
      let foundRestrictions = false;

      Object.values(policies).forEach((resource: any) => {
        const doc = resource.Properties.PolicyDocument;
        doc.Statement.forEach((stmt: any) => {
          if (stmt.Action && stmt.Resource) {
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            const relevantActions = actions.filter(
              (a: string) =>
                a.includes("iot:Publish") ||
                a.includes("iot:Subscribe") ||
                a.includes("iot:Receive"),
            );

            if (relevantActions.length > 0) {
              // The resource may be an Fn::Join, so stringify and check
              const resourceStr = JSON.stringify(stmt.Resource);
              expect(resourceStr).toContain("${iot:Connection.Thing.ThingName}");
              foundRestrictions = true;
            }
          }
        });
      });

      expect(foundRestrictions).toBe(true);
    });

    it("iot:Subscribe is authorized on topicfilter/ and not on topic/", () => {
      const policy = Object.values(template.findResources("AWS::IoT::Policy"))[0] as any;
      const stmt = policy.Properties.PolicyDocument.Statement.find(
        (s: any) => s.Sid === "SubscribeOwnTopicFiltersOnly",
      );
      const resourceStr = JSON.stringify(stmt.Resource);
      expect(resourceStr).toContain("topicfilter/");
      expect(resourceStr).not.toContain('"topic/');
    });

    it("No Resource of the IoT Policy is an open wildcard", () => {
      const policy = Object.values(template.findResources("AWS::IoT::Policy"))[0] as any;
      policy.Properties.PolicyDocument.Statement.forEach((stmt: any) => {
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        resources.forEach((r: any) => {
          expect(r).not.toBe("*");
          const str = JSON.stringify(r);
          expect(str).not.toContain('"topic/*"');
          expect(str).not.toContain("topic/*\"]");
        });
      });
    });
  });

  describe("S3 Firmware Bucket — security", () => {
    it("Bucket exists", () => {
      template.resourceCountIs("AWS::S3::Bucket", 1);
    });

    it("BlockPublicAccess is fully enabled", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("Versioning is enabled (OTA flow requirement)", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        VersioningConfiguration: { Status: "Enabled" },
      });
    });

    it("S3-managed encryption is configured", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            }),
          ]),
        },
      });
    });

    it("ObjectOwnership is BucketOwnerEnforced (ACLs disabled)", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        OwnershipControls: {
          Rules: Match.arrayWith([
            Match.objectLike({ ObjectOwnership: "BucketOwnerEnforced" }),
          ]),
        },
      });
    });

    it("Has a lifecycle rule expiring noncurrent versions", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: "expire-old-firmware-versions",
              Status: "Enabled",
              NoncurrentVersionExpiration: { NoncurrentDays: 90 },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            }),
          ]),
        },
      });
    });

    it("enforceSSL: the BucketPolicy denies aws:SecureTransport=false", () => {
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Action: "s3:*",
              Principal: { AWS: "*" },
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        }),
      });
    });

    it("minimumTLSVersion: the BucketPolicy denies s3:TlsVersion < 1.2", () => {
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Action: "s3:*",
              Principal: { AWS: "*" },
              Condition: { NumericLessThan: { "s3:TlsVersion": 1.2 } },
            }),
          ]),
        }),
      });
    });

    it("The TLS Deny statements cover the bucket and its objects", () => {
      const bucketPolicy = Object.values(template.findResources("AWS::S3::BucketPolicy"))[0] as any;
      const denies = bucketPolicy.Properties.PolicyDocument.Statement.filter(
        (s: any) => s.Effect === "Deny",
      );
      expect(denies.length).toBe(2);
      denies.forEach((stmt: any) => {
        const resourceStr = JSON.stringify(stmt.Resource);
        expect(resourceStr).toContain("Arn");
        expect(resourceStr).toContain("/*");
      });
    });
  });

  describe("OTA Service Role — IAM security", () => {
    it("Role exists and trusts iot.amazonaws.com", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: "iot.amazonaws.com" },
            }),
          ]),
        }),
      });
    });

    it("AssumeRole contains anti-confused-deputy conditions (SourceAccount + SourceArn)", () => {
      const roles = template.findResources("AWS::IAM::Role");
      let foundCondition = false;

      Object.values(roles).forEach((resource: any) => {
        const stmts = resource.Properties?.AssumeRolePolicyDocument?.Statement || [];
        stmts.forEach((stmt: any) => {
          if (stmt.Principal?.Service === "iot.amazonaws.com") {
            expect(stmt.Condition?.StringEquals?.["aws:SourceAccount"]).toBe(TEST_ENV.account);
            expect(stmt.Condition?.ArnLike?.["aws:SourceArn"]).toBeDefined();
            foundCondition = true;
          }
        });
      });

      expect(foundCondition).toBe(true);
    });

    it("Contains iam:PassRole with the PassedToService=iot.amazonaws.com condition", () => {
      const stmt = statementBySid(template, "PassSelfToIot");
      expect(stmt.Action).toContain("iam:PassRole");
      expect(stmt.Condition?.StringEquals?.["iam:PassedToService"]).toBe("iot.amazonaws.com");
      expect(stmt.Resource).not.toBe("*");
    });

    it("S3 permissions allow Read on unsigned/ and Write on signed/", () => {
      const readUnsigned = statementBySid(template, "ReadUnsignedFirmware");
      expect(readUnsigned.Action).toContain("s3:GetObject");
      expect(readUnsigned.Action).toContain("s3:GetObjectVersion");
      expect(JSON.stringify(readUnsigned.Resource)).toContain("/unsigned/*");
      expect(readUnsigned.Action).not.toContain("s3:PutObject");

      const writeSigned = statementBySid(template, "WriteAndReadSignedFirmware");
      expect(writeSigned.Action).toContain("s3:PutObject");
      expect(JSON.stringify(writeSigned.Resource)).toContain("/signed/*");
      expect(JSON.stringify(writeSigned.Action)).not.toContain("s3:DeleteObject");
    });

    it("DEFAULT: the OTA role carries no Signer statement (see the Signer block)", () => {
      expect(iamStatements(template).find((s) => s.Sid === "SignWithProjectProfileOnly")).toBeUndefined();
      expect(iamStatements(template).find((s) => s.Sid === "DescribeSigningJobs")).toBeUndefined();
    });

    it("IoT Jobs: scoped to job/* and jobtemplate/* of this account and region", () => {
      const stmt = statementBySid(template, "ManageOtaJobs");
      const resourceStr = JSON.stringify(stmt.Resource);
      expect(resourceStr).toContain(":job/*");
      expect(resourceStr).toContain(":jobtemplate/*");
      expect(resourceStr).toContain(TEST_ENV.account);
      expect(resourceStr).toContain(TEST_ENV.region);
      expect(stmt.Resource).not.toBe("*");
      // It must not include OTA-update creation nor thing creation actions.
      expect(JSON.stringify(stmt.Action)).not.toContain("iot:CreateThing");
    });

    it("IoT Streams: scoped to stream/* of this account and region", () => {
      const stmt = statementBySid(template, "ManageOtaStreams");
      const resourceStr = JSON.stringify(stmt.Resource);
      expect(resourceStr).toContain(":stream/*");
      expect(resourceStr).toContain(TEST_ENV.account);
      expect(resourceStr).toContain(TEST_ENV.region);
      expect(stmt.Action).toEqual(
        expect.arrayContaining(["iot:CreateStream", "iot:DescribeStream", "iot:DeleteStream"]),
      );
    });

    it("Target resolution: scoped to thing/* and thinggroup/*, read-only", () => {
      const stmt = statementBySid(template, "ResolveJobTargets");
      const resourceStr = JSON.stringify(stmt.Resource);
      expect(resourceStr).toContain(":thing/*");
      expect(resourceStr).toContain(":thinggroup/*");
      const actions: string[] = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      actions.forEach((a) => expect(a.startsWith("iot:Describe")).toBe(true));
    });

    it("Bucket metadata: scoped to the bucket ARN (without /*)", () => {
      const stmt = statementBySid(template, "FirmwareBucketMetadata");
      expect(JSON.stringify(stmt.Resource)).not.toContain("/*");
      expect(stmt.Action).toContain("s3:ListBucket");
    });
  });

  describe("AWS Signer — code-signing is OPTIONAL (default: disabled)", () => {
    it("DEFAULT: no signing-profile custom resource at all", () => {
      const signerResources = Object.keys(template.findResources("Custom::AWS")).filter(
        (logicalId) => logicalId.includes("FirmwareSigningProfile"),
      );
      expect(signerResources).toHaveLength(0);
    });

    it("DEFAULT: nothing in the template calls putSigningProfile", () => {
      const serialized = JSON.stringify(template.toJSON());
      expect(serialized).not.toContain("putSigningProfile");
      expect(serialized).not.toContain("PutSigningProfile");
      expect(serialized).not.toContain("cancelSigningProfile");
      expect(serialized).not.toContain("AWSIoTDeviceManagement-SHA256-ECDSA");
    });

    it("REGRESSION: there is NO AWS::Signer::SigningProfile L1 in the template", () => {
      // Even with code-signing ENABLED the profile is NOT the L1: the CloudFormation registry
      // schema of AWS::Signer::SigningProfile hard-codes a stale PlatformId enum
      // (AWSLambda-SHA384-ECDSA / Notation-OCI-SHA384-ECDSA), rejects
      // AWSIoTDeviceManagement-SHA256-ECDSA at Early Validation, and cannot express
      // `signingMaterial`. This test fails if the L1 ever comes back, on either path.
      template.resourceCountIs("AWS::Signer::SigningProfile", 0);
      expect(JSON.stringify(template.toJSON())).not.toContain("AWS::Signer::SigningProfile");

      const enabled = synth({ signingCertificateArn: FAKE_SIGNING_CERT_ARN });
      enabled.resourceCountIs("AWS::Signer::SigningProfile", 0);
      expect(JSON.stringify(enabled.toJSON())).not.toContain("AWS::Signer::SigningProfile");
    });

    it("DEFAULT: the OTA role has ZERO signer:* permissions", () => {
      const signerStatements = iamStatements(template).filter((s) =>
        JSON.stringify(s.Action ?? "").includes("signer:"),
      );
      expect(signerStatements).toHaveLength(0);
      // Belt and braces on the specific actions the reviewers flagged.
      const serializedPolicies = JSON.stringify(
        Object.values(template.findResources("AWS::IAM::Policy")),
      );
      expect(serializedPolicies).not.toContain("signer:StartSigningJob");
      expect(serializedPolicies).not.toContain("signer:PutSigningProfile");
      expect(serializedPolicies).not.toContain("signer:GetSigningProfile");
      expect(serializedPolicies).not.toContain("signer:DescribeSigningJob");
    });

    it("DEFAULT: there is NO statement with Resource '*' anywhere in the stack", () => {
      // The previous `signer:DescribeSigningJob` wildcard is gone with the signing profile:
      // without a profile AWS IoT never starts a signing job, so the grant was dead weight.
      const wildcards = iamStatements(template).filter(
        (s) => s.Resource === "*" || (Array.isArray(s.Resource) && s.Resource.includes("*")),
      );
      expect(wildcards.map((s) => s.Sid ?? "(no sid)")).toEqual([]);
    });

    it("DEFAULT: the status output is honest and no profile ARN is emitted", () => {
      template.hasOutput("CodeSigningStatus", {
        Value: Match.stringLikeRegexp("^DISABLED: no AWS Signer profile"),
      });
      expect(Object.keys(template.findOutputs("SigningProfileArn"))).toHaveLength(0);
      expect(Object.keys(template.findOutputs("SigningProfileName"))).toHaveLength(0);
    });

    it("DEFAULT: the construct exposes the disabled state with no profile name nor ARN", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "OtaOnlyStack", { env: TEST_ENV });
      const ota = new FirmwareOtaPipeline(stack, "Ota", OTA_PROPS);

      expect(ota.codeSigningEnabled).toBe(false);
      expect(ota.signingProfileName).toBeUndefined();
      expect(ota.signingProfileArn).toBeUndefined();
      expect(ota.signingProfileResource).toBeUndefined();
      expect(ota.signingProfileResourceRole).toBeUndefined();
    });

    it("An empty/blank signingCertificateArn is treated as not provided", () => {
      const blank = synth({ signingCertificateArn: "   " });
      expect(JSON.stringify(blank.toJSON())).not.toContain("putSigningProfile");
      blank.hasOutput("CodeSigningStatus", {
        Value: Match.stringLikeRegexp("^DISABLED:"),
      });
    });

    it("A malformed signingCertificateArn fails fast at synth time", () => {
      expect(() => synth({ signingCertificateArn: "not-an-arn" })).toThrow(
        /must be an ACM certificate ARN/,
      );
      expect(() =>
        synth({ signingCertificateArn: "arn:aws:iam::123456789012:role/not-acm" }),
      ).toThrow(/must be an ACM certificate ARN/);
    });
  });

  describe("AWS Signer — code-signing ENABLED (-c ugp:signingCertificateArn)", () => {
    let enabled: Template;

    beforeEach(() => {
      enabled = synth({ signingCertificateArn: FAKE_SIGNING_CERT_ARN });
    });

    /** Parsed `Create`/`Update`/`Delete` payload of the signing-profile custom resource. */
    function signerCall(t: Template, key: "Create" | "Update" | "Delete"): any {
      const resources = Object.entries(t.findResources("Custom::AWS")).filter(([logicalId]) =>
        logicalId.includes("FirmwareSigningProfile"),
      );
      expect(resources).toHaveLength(1);
      const raw = (resources[0][1] as any).Properties[key];
      expect(typeof raw).toBe("string");
      return JSON.parse(raw);
    }

    it("A custom resource creates the profile with putSigningProfile + signingMaterial", () => {
      const create = signerCall(enabled, "Create");
      expect(create.service).toBe("Signer");
      expect(create.action).toBe("putSigningProfile");
      expect(create.parameters.profileName).toBe("ugp_cold_chain_firmware");
      expect(create.parameters.platformId).toBe("AWSIoTDeviceManagement-SHA256-ECDSA");
      // AWSIoTDeviceManagement-SHA256-ECDSA is bring-your-own-certificate: without
      // signingMaterial.certificateArn the API call is rejected.
      expect(create.parameters.signingMaterial).toEqual({
        certificateArn: FAKE_SIGNING_CERT_ARN,
      });
      expect(create.parameters.signatureValidityPeriod).toEqual({ value: 365, type: "DAYS" });
      expect(create.physicalResourceId).toEqual({ id: "ugp_cold_chain_firmware" });
    });

    it("Update repeats putSigningProfile with a stable physical id (no replacement)", () => {
      expect(signerCall(enabled, "Update")).toEqual(signerCall(enabled, "Create"));
    });

    it("Delete cancels the profile (cancelSigningProfile, not revoke)", () => {
      const del = signerCall(enabled, "Delete");
      expect(del.service).toBe("Signer");
      expect(del.action).toBe("cancelSigningProfile");
      expect(del.parameters).toEqual({ profileName: "ugp_cold_chain_firmware" });
      expect(del.ignoreErrorCodesMatching).toContain("ResourceNotFoundException");
    });

    it("installLatestAwsSdk is disabled (supply-chain hygiene)", () => {
      const resources = Object.entries(enabled.findResources("Custom::AWS")).filter(
        ([logicalId]) => logicalId.includes("FirmwareSigningProfile"),
      );
      expect((resources[0][1] as any).Properties.InstallLatestAwsSdk).toBe(false);
    });

    it("HIGH-1 FIX: PutSigningProfile is split onto '*', Get/Cancel stay scoped", () => {
      // signer:PutSigningProfile has NO resource types in the service authorization reference
      // (the profile does not exist yet), so scoping it to the profile ARN silently denies the
      // call. It is therefore isolated in its own statement on '*'...
      const put = statementBySid(enabled, "CreateSigningProfileNoResourceLevelPerms");
      expect(put.Effect).toBe("Allow");
      expect(put.Action).toBe("signer:PutSigningProfile");
      expect(put.Resource).toBe("*");

      // ...while the two actions that DO support `signing-profile` stay scoped.
      const scoped = statementBySid(enabled, "ReadAndCancelProjectSigningProfileOnly");
      expect(scoped.Action).toEqual(["signer:GetSigningProfile", "signer:CancelSigningProfile"]);
      expect(scoped.Resource).not.toBe("*");
      const scopedArn = JSON.stringify(scoped.Resource);
      expect(scopedArn).toContain("/signing-profiles/ugp_cold_chain_firmware");
      expect(scopedArn).toContain(TEST_ENV.account);
      expect(scopedArn).toContain(TEST_ENV.region);
      expect(scopedArn).not.toContain("signing-profiles/*");

      // No broad signer:* and nothing beyond the profile lifecycle.
      const allSignerActions = JSON.stringify(
        iamStatements(enabled)
          .filter((s) => JSON.stringify(s.Action ?? "").includes("signer:"))
          .map((s) => s.Action),
      );
      expect(allSignerActions).not.toContain("signer:*");
      expect(allSignerActions).not.toContain("signer:RevokeSigningProfile");
      expect(allSignerActions).not.toContain("signer:AddProfilePermission");
    });

    it("HIGH-1 FIX: the wildcard lives in the DEDICATED role, not a CDK-generated one", () => {
      // The dedicated role is declared by us (logical id under FirmwareSigningProfileRole) so
      // the wildcard is auditable instead of hidden in an implicitly generated provider role.
      const roles = Object.keys(enabled.findResources("AWS::IAM::Role"));
      const dedicated = roles.filter((id) => id.includes("FirmwareSigningProfileRole"));
      expect(dedicated).toHaveLength(1);

      const [, policy] = Object.entries(enabled.findResources("AWS::IAM::Policy")).find(
        ([, resource]: [string, any]) =>
          (resource.Properties?.PolicyDocument?.Statement ?? []).some(
            (s: any) => s.Sid === "CreateSigningProfileNoResourceLevelPerms",
          ),
      ) as [string, any];
      // Attached to the dedicated role and to NOTHING else.
      expect(policy.Properties.Roles).toEqual([{ Ref: dedicated[0] }]);

      // And it really is the provider's execution role, i.e. the `role` prop was honoured
      // (it is silently ignored if another AwsCustomResource claimed the singleton first).
      const providers = Object.entries(enabled.findResources("AWS::Lambda::Function")).filter(
        ([id]) => !id.includes("AutoDeleteObjects"),
      );
      expect(providers).toHaveLength(1);
      expect((providers[0][1] as any).Properties.Role).toEqual({
        "Fn::GetAtt": [dedicated[0], "Arn"],
      });

      // The OTA service role must never carry the wildcard.
      const otaPolicy = JSON.stringify(
        Object.entries(enabled.findResources("AWS::IAM::Policy")).filter(([id]) =>
          id.includes("OtaServiceRole"),
        ),
      );
      expect(otaPolicy).not.toContain("signer:PutSigningProfile");
    });

    it("The OTA role regains the SCOPED signer grants", () => {
      const stmt = statementBySid(enabled, "SignWithProjectProfileOnly");
      expect(stmt.Action).toEqual(
        expect.arrayContaining(["signer:StartSigningJob", "signer:GetSigningProfile"]),
      );
      expect(stmt.Resource).not.toBe("*");
      const resourceStr = JSON.stringify(stmt.Resource);
      expect(resourceStr).toContain("/signing-profiles/ugp_cold_chain_firmware");
      expect(resourceStr).toContain(TEST_ENV.account);
      expect(resourceStr).not.toContain("signing-profiles/*");

      // DescribeSigningJob has no resource-level perms; documented and only on this path.
      const describe = statementBySid(enabled, "DescribeSigningJobs");
      expect(describe.Action).toBe("signer:DescribeSigningJob");
      expect(describe.Resource).toBe("*");
    });

    it("The only wildcards on this path are the two documented Signer actions", () => {
      const wildcards = iamStatements(enabled).filter(
        (s) => s.Resource === "*" || (Array.isArray(s.Resource) && s.Resource.includes("*")),
      );
      expect(wildcards.map((s) => s.Sid).sort()).toEqual([
        "CreateSigningProfileNoResourceLevelPerms",
        "DescribeSigningJobs",
      ]);
    });

    it("Honest outputs: the profile ARN/name are emitted only on this path", () => {
      enabled.hasOutput("CodeSigningStatus", { Value: "ENABLED:ugp_cold_chain_firmware" });
      enabled.hasOutput("SigningProfileName", { Value: "ugp_cold_chain_firmware" });
      enabled.hasOutput("SigningProfileArn", Match.anyValue());
    });

    it("The construct exposes the profile name and the constructed ARN", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "OtaSignedStack", { env: TEST_ENV });
      const ota = new FirmwareOtaPipeline(stack, "Ota", {
        ...OTA_PROPS,
        signingCertificateArn: FAKE_SIGNING_CERT_ARN,
      });

      expect(ota.codeSigningEnabled).toBe(true);
      expect(ota.signingProfileName).toBe("ugp_cold_chain_firmware");
      expect(ota.signingProfileResource).toBeDefined();
      expect(ota.signingProfileResourceRole).toBeDefined();
      expect(stack.resolve(ota.signingProfileArn)).toEqual({
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            `:signer:${TEST_ENV.region}:${TEST_ENV.account}:/signing-profiles/ugp_cold_chain_firmware`,
          ],
        ],
      });
    });

    it("Guard: the construct refuses to be built after another AwsCustomResource", () => {
      // The AwsCustomResource provider Lambda is a per-STACK singleton, so the `role` prop is
      // honoured only for the first instance. Building the pipeline second would silently drop
      // the dedicated role and put the wildcard on a CDK-generated one.
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "LateOtaStack", { env: TEST_ENV });
      new cr.AwsCustomResource(stack, "SomeOtherCr", {
        onUpdate: {
          service: "Iot",
          action: "describeEndpoint",
          parameters: { endpointType: "iot:Data-ATS" },
          physicalResourceId: cr.PhysicalResourceId.of("endpoint"),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        installLatestAwsSdk: false,
      });

      expect(
        () =>
          new FirmwareOtaPipeline(stack, "Ota", {
            ...OTA_PROPS,
            signingCertificateArn: FAKE_SIGNING_CERT_ARN,
          }),
      ).toThrow(/must be created before any other AwsCustomResource/);
    });
  });

  describe("IoT Job Template", () => {
    /** The already parsed job template document. */
    function jobDocument(t: Template): any {
      const jobTemplate = Object.values(t.findResources("AWS::IoT::JobTemplate"))[0] as any;
      const raw = jobTemplate.Properties.Document;
      expect(typeof raw).toBe("string");
      return JSON.parse(raw);
    }

    it("JobTemplate exists with the expected id", () => {
      template.resourceCountIs("AWS::IoT::JobTemplate", 1);
      template.hasResourceProperties("AWS::IoT::JobTemplate", {
        JobTemplateId: "ugp-cold-chain-ota",
      });
    });

    it("JobTemplate has PresignedUrlConfig, rollout, retry, abort and timeout", () => {
      template.hasResourceProperties("AWS::IoT::JobTemplate", {
        PresignedUrlConfig: Match.objectLike({
          RoleArn: Match.anyValue(),
          ExpiresInSec: 3600,
        }),
        JobExecutionsRolloutConfig: Match.objectLike({ MaximumPerMinute: 5 }),
        TimeoutConfig: Match.objectLike({ InProgressTimeoutInMinutes: 15 }),
        JobExecutionsRetryConfig: Match.objectLike({
          RetryCriteriaList: Match.arrayWith([
            Match.objectLike({ FailureType: "FAILED", NumberOfRetries: 2 }),
          ]),
        }),
        AbortConfig: Match.objectLike({
          CriteriaList: Match.arrayWith([
            Match.objectLike({ Action: "CANCEL", FailureType: "FAILED" }),
          ]),
        }),
      });
    });

    it("REGRESSION: every JobTemplate sub-property is synthesized in PascalCase", () => {
      // aws-cdk-lib 2.260.0 leaked the TypeScript (camelCase) key names of AbortConfig /
      // TimeoutConfig / PresignedUrlConfig / JobExecutionsRolloutConfig into the template,
      // which CloudFormation Early Validation rejects with
      // `AWS::EarlyValidation::PropertyValidation`. `firmware-ota.ts` works around it with
      // `forcePascalCasePropertyKeys`; this test fails if the workaround is dropped or broken.
      const jobTemplate = Object.values(
        template.findResources("AWS::IoT::JobTemplate"),
      )[0] as any;
      const props = jobTemplate.Properties;

      expect(props.AbortConfig.CriteriaList).toHaveLength(1);
      expect(props.AbortConfig.CriteriaList[0]).toEqual({
        Action: "CANCEL",
        FailureType: "FAILED",
        MinNumberOfExecutedThings: 1,
        ThresholdPercentage: 100,
      });
      expect(props.TimeoutConfig).toEqual({ InProgressTimeoutInMinutes: 15 });
      expect(props.JobExecutionsRolloutConfig).toEqual({ MaximumPerMinute: 5 });
      expect(props.PresignedUrlConfig.ExpiresInSec).toBe(3600);
      // The role ARN must stay a reference (Fn::GetAtt), never a hardcoded string.
      expect(props.PresignedUrlConfig.RoleArn).toEqual({
        "Fn::GetAtt": [expect.any(String), "Arn"],
      });
      expect(props.PresignedUrlConfig.RoleArn["Fn::GetAtt"][0]).toMatch(/OtaServiceRole/);

      // JobExecutionsRetryConfig is NOT part of the workaround: upstream already renders it
      // correctly, so it must keep working without any override.
      expect(props.JobExecutionsRetryConfig).toEqual({
        RetryCriteriaList: [{ FailureType: "FAILED", NumberOfRetries: 2 }],
      });

      // No camelCase leftovers anywhere in the resource (the deep-merge of raw overrides keeps
      // non-overridden keys, so a partial workaround would leave both spellings behind).
      const configKeys = [
        "AbortConfig",
        "TimeoutConfig",
        "PresignedUrlConfig",
        "JobExecutionsRolloutConfig",
        "JobExecutionsRetryConfig",
      ];
      configKeys.forEach((key) => {
        const camelCase = key.charAt(0).toLowerCase() + key.slice(1);
        expect(props).not.toHaveProperty(camelCase);
        Object.keys(props[key]).forEach((nested) => {
          expect(nested.charAt(0)).toBe(nested.charAt(0).toUpperCase());
        });
      });

      const serialized = JSON.stringify({ ...props, Document: undefined });
      [
        "abortConfig",
        "timeoutConfig",
        "presignedUrlConfig",
        "jobExecutionsRolloutConfig",
        "criteriaList",
        "inProgressTimeoutInMinutes",
        "maximumPerMinute",
        "roleArn",
        "expiresInSec",
        "minNumberOfExecutedThings",
        "thresholdPercentage",
        "failureType",
        "numberOfRetries",
      ].forEach((camelCaseKey) => {
        expect(serialized).not.toContain(`"${camelCaseKey}"`);
      });
    });

    it("The document declares operation=ota-update and schemaVersion", () => {
      const doc = jobDocument(template);
      expect(doc.operation).toBe("ota-update");
      expect(doc.schemaVersion).toBe("1.0");
      expect(doc.firmware.fileName).toBe("ugp-gateway.bin");
    });

    it("DEFAULT: firmware.signingProfile is OMITTED (no profile exists)", () => {
      // Advertising a profile name that does not exist would tell the firmware the image is
      // signed when it is not.
      const doc = jobDocument(template);
      expect(doc.firmware).not.toHaveProperty("signingProfile");
      expect(JSON.stringify(doc)).not.toContain("ugp_cold_chain_firmware");
    });

    it("ENABLED: firmware.signingProfile carries the real profile name", () => {
      const doc = jobDocument(synth({ signingCertificateArn: FAKE_SIGNING_CERT_ARN }));
      expect(doc.firmware.signingProfile).toBe("ugp_cold_chain_firmware");
    });

    it("REGRESSION: the firmware URL is an explicit placeholder, not a made-up key", () => {
      const doc = jobDocument(template);
      // The signed object lives in signed/<signingJobId> (UUID), unknown at synth time:
      // the template must NOT fabricate a URL that would resolve to a silent 404.
      expect(doc.firmware.url).toBe(FirmwareOtaPipeline.FIRMWARE_URL_PLACEHOLDER);
      expect(doc.firmware.url).not.toMatch(/^https?:\/\//);
      expect(doc.firmware.url).not.toContain("s3-presigned-url");
      expect(JSON.stringify(doc)).not.toContain("signed/ugp-gateway.bin");
    });

    it("The A/B rollback contract is declared (implementation in Block 3)", () => {
      const doc = jobDocument(template);
      expect(doc.rollback.enabled).toBe(true);
      expect(doc.rollback.healthCheckSeconds).toBe(120);
    });
  });

  describe("IoT Thing Type + Thing", () => {
    it("Thing Type exists with searchable attributes", () => {
      template.resourceCountIs("AWS::IoT::ThingType", 1);
      template.hasResourceProperties("AWS::IoT::ThingType", {
        ThingTypeName: "ugp-cold-chain-gateway",
        ThingTypeProperties: Match.objectLike({
          SearchableAttributes: Match.arrayWith(["mac", "site", "hardware"]),
        }),
      });
    });

    it("Thing exists with the hardware identity attributes", () => {
      template.resourceCountIs("AWS::IoT::Thing", 1);
      template.hasResourceProperties("AWS::IoT::Thing", {
        ThingName: "ugp-gateway-01",
        AttributePayload: Match.objectLike({
          Attributes: {
            mac: "70:4b:ca:8f:23:10",
            site: "gdl-innovation-labs",
            hardware: "esp32-d0wd-v3",
          },
        }),
      });
    });
  });

  describe("Outputs", () => {
    it("Emits the edge platform wiring outputs", () => {
      template.hasOutput("ThingName", { Value: "ugp-gateway-01" });
      template.hasOutput("ThingArn", Match.anyValue());
      template.hasOutput("ThingTypeArn", Match.anyValue());
      template.hasOutput("IotPolicyName", {
        Value: "ugp-cold-chain-gateway-least-privilege",
      });
      template.hasOutput("FirmwareBucketName", Match.anyValue());
      template.hasOutput("CodeSigningStatus", Match.anyValue());
      template.hasOutput("OtaServiceRoleArn", Match.anyValue());
      template.hasOutput("OtaJobTemplateArn", Match.anyValue());
    });
  });
});

describe("UgpIotStack — certificate provisioning", () => {
  it("NONE mode: without CSR nor ARN there is no certificate and no attachments", () => {
    const template = synth();
    template.resourceCountIs("AWS::IoT::Certificate", 0);
    template.resourceCountIs("AWS::IoT::ThingPrincipalAttachment", 0);
    template.resourceCountIs("AWS::IoT::PolicyPrincipalAttachment", 0);
    template.hasOutput("DeviceCertificateStatus", {
      Value: Match.stringLikeRegexp("^NONE:"),
    });
  });

  it("CSR mode: creates an ACTIVE AWS::IoT::Certificate and both attachments", () => {
    const template = synth({ deviceCsrPem: FAKE_CSR_PEM });
    template.resourceCountIs("AWS::IoT::Certificate", 1);
    template.hasResourceProperties("AWS::IoT::Certificate", {
      CertificateSigningRequest: FAKE_CSR_PEM,
      CertificateMode: "DEFAULT",
      Status: "ACTIVE",
    });
    template.resourceCountIs("AWS::IoT::ThingPrincipalAttachment", 1);
    template.resourceCountIs("AWS::IoT::PolicyPrincipalAttachment", 1);
    template.hasResourceProperties("AWS::IoT::ThingPrincipalAttachment", {
      ThingName: "ugp-gateway-01",
      Principal: Match.anyValue(),
    });
    template.hasOutput("DeviceCertificateStatus", {
      Value: Match.objectLike({ "Fn::Join": Match.anyValue() }),
    });
  });

  it("IMPORTED_ARN mode: creates no certificate and attaches the existing ARN", () => {
    const template = synth({ deviceCertificateArn: FAKE_CERT_ARN });
    template.resourceCountIs("AWS::IoT::Certificate", 0);
    template.hasResourceProperties("AWS::IoT::ThingPrincipalAttachment", {
      ThingName: "ugp-gateway-01",
      Principal: FAKE_CERT_ARN,
    });
    template.hasResourceProperties("AWS::IoT::PolicyPrincipalAttachment", {
      Principal: FAKE_CERT_ARN,
    });
    template.hasOutput("DeviceCertificateStatus", {
      Value: `IMPORTED_ARN:${FAKE_CERT_ARN}`,
    });
  });

  it("CSR + ARN at the same time: throws (mutual exclusion)", () => {
    expect(() =>
      synth({ deviceCsrPem: FAKE_CSR_PEM, deviceCertificateArn: FAKE_CERT_ARN }),
    ).toThrow(/mutually exclusive/);
  });

  it("EdgeDevice exposes the resolved provisioning mode", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "DeviceOnlyStack", { env: TEST_ENV });
    const common = {
      thingName: "t1",
      thingTypeName: "tt1",
      thingTypeDescription: "d",
      telemetryTopicPrefix: "ugp/telemetry",
      commandTopicPrefix: "ugp/commands",
      macAddress: "00:00:00:00:00:01",
      site: "s",
      hardware: "h",
    };

    const none = new EdgeDevice(stack, "None", common);
    expect(none.certificateProvisioningMode).toBe(CertificateProvisioningMode.NONE);
    expect(none.certificateArn).toBeUndefined();

    const imported = new EdgeDevice(stack, "Imported", {
      ...common,
      thingName: "t2",
      thingTypeName: "tt2",
      importedCertificateArn: FAKE_CERT_ARN,
    });
    expect(imported.certificateProvisioningMode).toBe(CertificateProvisioningMode.IMPORTED_ARN);
    expect(imported.certificateArn).toBe(FAKE_CERT_ARN);

    const csr = new EdgeDevice(stack, "Csr", {
      ...common,
      thingName: "t3",
      thingTypeName: "tt3",
      certificateSigningRequestPem: FAKE_CSR_PEM,
    });
    expect(csr.certificateProvisioningMode).toBe(CertificateProvisioningMode.CSR);
    expect(csr.certificateArn).toBeDefined();
  });
});

describe("UgpIotStack — IoT endpoint resolution", () => {
  // With code-signing disabled (the default) the stack has NO custom resource at all, so the
  // endpoint CR is the only possible `Custom::AWS`.
  it("By default there is no custom resource whatsoever", () => {
    const template = synth();
    template.resourceCountIs("Custom::AWS", 0);
    // The only Lambda left is the S3 auto-delete-objects provider (sandbox teardown), i.e.
    // there is no AwsCustomResource provider in the stack at all.
    const functions = Object.keys(template.findResources("AWS::Lambda::Function"));
    expect(functions.filter((id) => !id.includes("AutoDeleteObjects"))).toEqual([]);
    template.hasOutput("IotDataEndpointHint", {
      Value: Match.stringLikeRegexp("aws iot describe-endpoint"),
    });
  });

  it("resolveIotEndpoint=true adds the read-only custom resource and the output", () => {
    const template = synth({ resolveIotEndpoint: true });
    template.resourceCountIs("Custom::AWS", 1);
    template.hasOutput("IotDataEndpointAddress", Match.anyValue());

    // The custom resource can only call iot:DescribeEndpoint.
    const sdkPolicy = iamStatements(template).find((s) =>
      JSON.stringify(s.Action).includes("iot:DescribeEndpoint"),
    );
    expect(sdkPolicy).toBeDefined();
    expect(sdkPolicy.Effect).toBe("Allow");
    expect(JSON.stringify(sdkPolicy.Action)).not.toContain("iot:CreateThing");

    // The hint must not exist when it is actually resolved.
    expect(Object.keys(template.findOutputs("IotDataEndpointHint")).length).toBe(0);
  });

  it("With code-signing enabled both custom resources share the singleton provider", () => {
    // Documented consequence of the `AwsCustomResource` per-stack singleton: there are two
    // Custom::AWS resources but ONE provider Lambda, running on the dedicated signing-profile
    // role. This is asserted so the trade-off cannot be forgotten.
    const template = synth({
      resolveIotEndpoint: true,
      signingCertificateArn: FAKE_SIGNING_CERT_ARN,
    });
    template.resourceCountIs("Custom::AWS", 2);

    const providers = Object.entries(template.findResources("AWS::Lambda::Function")).filter(
      ([id]) => !id.includes("AutoDeleteObjects"),
    );
    expect(providers).toHaveLength(1);

    const dedicated = Object.keys(template.findResources("AWS::IAM::Role")).filter((id) =>
      id.includes("FirmwareSigningProfileRole"),
    );
    expect(dedicated).toHaveLength(1);
    expect((providers[0][1] as any).Properties.Role).toEqual({
      "Fn::GetAtt": [dedicated[0], "Arn"],
    });
  });
});
