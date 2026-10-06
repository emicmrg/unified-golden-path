import * as fs from "node:fs";
import * as path from "node:path";

import * as cdk from "aws-cdk-lib";

import { DashboardStack } from "./stacks/dashboard-stack";
import { SelfHealingStack } from "./stacks/self-healing-stack";
import { UgpIotStack } from "./stacks/ugp-iot-stack";

const app = new cdk.App();

/**
 * Environment shared by every stack.
 * The account is NEVER hardcoded: it comes from the active profile/credentials
 * (CDK_DEFAULT_ACCOUNT). If empty, the stack stays environment-agnostic and the deploy
 * resolves it at that moment.
 */
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  // Fallback ONLY so that `cdk synth` works without a configured profile (CI, tests, demo).
  // It does not pin the deploy region: `cdk deploy` uses CDK_DEFAULT_REGION / AWS_REGION from
  // the active profile. To synthesize in another region: `AWS_REGION=eu-west-1 pnpm synth`.
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

/**
 * Reads a PEM CSR from the path passed via context:
 *   cdk synth -c ugp:deviceCsrPath=./device.csr
 *
 * Generate the CSR (the private key stays local and never enters the repo nor the template):
 *   openssl req -new -newkey rsa:2048 -nodes -keyout device.key -out device.csr \
 *     -subj "/CN=ugp-gateway-01"
 */
function readDeviceCsr(): string | undefined {
  const csrPath = app.node.tryGetContext("ugp:deviceCsrPath") as string | undefined;
  if (!csrPath) {
    return undefined;
  }
  const resolved = path.resolve(csrPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`ugp:deviceCsrPath points to a non-existent file: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf-8");
}

new UgpIotStack(app, "UgpIotStack", {
  env,
  description:
    "Unified Golden Path — edge platform: IoT Core registry (Thing/cert/policy) + signed OTA pipeline",
  deviceCsrPem: readDeviceCsr(),
  deviceCertificateArn: app.node.tryGetContext("ugp:deviceCertificateArn") as string | undefined,
  resolveIotEndpoint: app.node.tryGetContext("ugp:resolveIotEndpoint") === "true",
});

/**
 * Self-healing agent runner.
 *
 * `githubOrg` / `githubRepo` are passed via context because the git repository does not exist
 * yet; with the placeholders the stack synthesizes, but nobody can assume the CI role trust
 * policy (the stack emits a synth warning as a reminder):
 *
 *   cdk synth SelfHealingStack -c ugp:githubOrg=my-org -c ugp:githubRepo=unified-golden-path
 */
new SelfHealingStack(app, "SelfHealingStack", {
  env,
  description:
    "Unified Golden Path — self-healing crew runner: ECR + ECS/Fargate + Bedrock (1 model) + " +
    "DynamoDB circuit breaker + least-privilege CI role via OIDC",
  githubOrg: app.node.tryGetContext("ugp:githubOrg") as string | undefined,
  githubRepo: app.node.tryGetContext("ugp:githubRepo") as string | undefined,
  githubAppId: app.node.tryGetContext("ugp:githubAppId") as string | undefined,
  githubInstallationId: app.node.tryGetContext("ugp:githubInstallationId") as string | undefined,
  githubAppSecretArn: app.node.tryGetContext("ugp:githubAppSecretArn") as string | undefined,
});

/**
 * Read-only backend of the `web-dashboard`.
 *
 * It does NOT depend on SelfHealingStack via `Fn::ImportValue`: the circuit breaker table is
 * referenced by NAME (deterministic, pinned in SelfHealingStack) and the ARN is composed with
 * `Arn.format`. That way both stacks deploy and tear down in any order, at the cost of the
 * table name being an explicit contract between them (documented on both sides).
 *
 * Before the final deploy it is worth narrowing CORS and resolving the IoT endpoint:
 *   cdk deploy DashboardStack \
 *     -c ugp:dashboardAllowedOrigins=https://main.d1abc2def3.amplifyapp.com \
 *     -c ugp:resolveIotEndpoint=true
 */
new DashboardStack(app, "DashboardStack", {
  env,
  description:
    "Unified Golden Path — read-only dashboard backend: guest Cognito Identity Pool " +
    "(IoT subscribe only) + status Lambda with Function URL + manual Amplify Hosting",
  allowedOrigins: (app.node.tryGetContext("ugp:dashboardAllowedOrigins") as string | undefined)
    ?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  iotEndpointAddress: app.node.tryGetContext("ugp:iotEndpoint") as string | undefined,
  resolveIotEndpoint: app.node.tryGetContext("ugp:resolveIotEndpoint") === "true",
  // TODO(demo): to lock down the hosting during rehearsals, manually create a secret with
  // {"username","password"} and pass its ARN. The password never enters the repo nor the
  // template: CloudFormation resolves it at deploy time via dynamic reference.
  basicAuthSecretArn: app.node.tryGetContext("ugp:dashboardBasicAuthSecretArn") as
    | string
    | undefined,
});

// Project tags, applied to every resource that supports tagging.
cdk.Tags.of(app).add("Project", "unified-golden-path");
cdk.Tags.of(app).add("Component", "edge-platform");
cdk.Tags.of(app).add("Environment", "sandbox");
cdk.Tags.of(app).add("ManagedBy", "cdk");

app.synth();
