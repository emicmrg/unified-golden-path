import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";

import { CertificateProvisioningMode, EdgeDevice } from "../src/constructs/edge-device";
import { FirmwareOtaPipeline } from "../src/constructs/firmware-ota";
import { UgpIotStack } from "../src/stacks/ugp-iot-stack";

/** Dummy CSR: CloudFormation does not validate it at synth time. */
const FAKE_CSR_PEM = [
  "-----BEGIN CERTIFICATE REQUEST-----",
  "MIIBdTCB3wIBADAeMRwwGgYDVQQDExN1Z3AtZ2F0ZXdheS0wMS10ZXN0",
  "-----END CERTIFICATE REQUEST-----",
].join("\n");

const FAKE_CERT_ARN = "arn:aws:iot:us-east-1:123456789012:cert/0123456789abcdef";

const TEST_ENV = { region: "us-east-1", account: "123456789012" } as const;

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

    it("Signer is scoped to OUR signing profile", () => {
      const stmt = statementBySid(template, "SignWithProjectProfileOnly");
      expect(stmt.Action).toContain("signer:StartSigningJob");
      expect(stmt.Resource).not.toBe("*");
      expect(JSON.stringify(stmt.Resource)).toContain("SigningProfile");
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

    it("The only statement with Resource '*' is the documented signer:DescribeSigningJob one", () => {
      const wildcards = iamStatements(template).filter(
        (s) => s.Resource === "*" || (Array.isArray(s.Resource) && s.Resource.includes("*")),
      );
      expect(wildcards.length).toBe(1);
      expect(wildcards[0].Sid).toBe("DescribeSigningJobs");
      expect(wildcards[0].Action).toBe("signer:DescribeSigningJob");
    });
  });

  describe("AWS Signer — Signing Profile", () => {
    it("SigningProfile exists", () => {
      template.resourceCountIs("AWS::Signer::SigningProfile", 1);
    });

    it("SigningProfile uses the AWS_IOT_DEVICE_MANAGEMENT_SHA256_ECDSA platform", () => {
      template.hasResourceProperties("AWS::Signer::SigningProfile", {
        PlatformId: "AWSIoTDeviceManagement-SHA256-ECDSA",
      });
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
          roleArn: Match.anyValue(),
          expiresInSec: 3600,
        }),
        JobExecutionsRolloutConfig: Match.objectLike({ maximumPerMinute: 5 }),
        TimeoutConfig: Match.objectLike({ inProgressTimeoutInMinutes: 15 }),
        JobExecutionsRetryConfig: Match.objectLike({
          RetryCriteriaList: Match.arrayWith([
            Match.objectLike({ FailureType: "FAILED", NumberOfRetries: 2 }),
          ]),
        }),
        AbortConfig: Match.objectLike({
          criteriaList: Match.arrayWith([
            Match.objectLike({ action: "CANCEL", failureType: "FAILED" }),
          ]),
        }),
      });
    });

    it("The document declares operation=ota-update and schemaVersion", () => {
      const doc = jobDocument(template);
      expect(doc.operation).toBe("ota-update");
      expect(doc.schemaVersion).toBe("1.0");
      expect(doc.firmware.fileName).toBe("ugp-gateway.bin");
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
      template.hasOutput("SigningProfileArn", Match.anyValue());
      template.hasOutput("SigningProfileName", Match.anyValue());
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
  it("By default it only documents the command (no Lambda added)", () => {
    const template = synth();
    template.resourceCountIs("Custom::AWS", 0);
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
});
