import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";

import { GithubOidcSubjectScope } from "../src/constructs/github-oidc-role";
import { SelfHealingStack, SelfHealingStackProps } from "../src/stacks/self-healing-stack";

const TEST_ENV = { region: "us-east-1", account: "123456789012" } as const;

const PROFILE_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const MODEL_ID = "anthropic.claude-sonnet-4-5-20250929-v1:0";

function synth(props: Partial<SelfHealingStackProps> = {}): Template {
  const app = new cdk.App();
  const stack = new SelfHealingStack(app, "TestSelfHealingStack", { env: TEST_ENV, ...props });
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

/** Serializes a template fragment to text in order to compare ARNs with Fn::Join/Ref. */
function flat(value: unknown): string {
  return JSON.stringify(value);
}

/** Checks that `value` is an Fn::GetAtt .Arn of a logical id matching `pattern`. */
function expectArnOf(value: any, pattern: RegExp): void {
  expect(Object.keys(value)).toEqual(["Fn::GetAtt"]);
  expect(value["Fn::GetAtt"][1]).toBe("Arn");
  expect(value["Fn::GetAtt"][0]).toMatch(pattern);
}

function statementBySid(template: Template, sid: string): any {
  const stmt = iamStatements(template).find((s) => s.Sid === sid);
  expect(stmt).toBeDefined();
  return stmt;
}

/** Environment of the single task definition container, as a Name -> Value map. */
function containerEnv(template: Template): Record<string, any> {
  const defs = template.findResources("AWS::ECS::TaskDefinition");
  const entries = (Object.values(defs)[0].Properties.ContainerDefinitions[0].Environment ??
    []) as Array<{ Name: string; Value: unknown }>;
  return Object.fromEntries(entries.map((e) => [e.Name, e.Value]));
}

describe("SelfHealingStack — crew runner", () => {
  let template: Template;

  beforeEach(() => {
    template = synth({ githubOrg: "demo-org", githubRepo: "demo-repo" });
  });

  describe("ECR", () => {
    it("Creates a repository with scan-on-push and cleanup on delete", () => {
      template.hasResourceProperties("AWS::ECR::Repository", {
        RepositoryName: "ugp-self-healing-crew",
        ImageScanningConfiguration: { ScanOnPush: true },
        EmptyOnDelete: true,
      });
    });

    it("The TagStatus.any rule has the highest priority (ECR requirement)", () => {
      const repos = template.findResources("AWS::ECR::Repository");
      const policyText = Object.values(repos)[0].Properties.LifecyclePolicy.LifecyclePolicyText;
      const rules = JSON.parse(policyText).rules as Array<{
        rulePriority: number;
        selection: { tagStatus: string };
      }>;
      const anyRule = rules.find((r) => r.selection.tagStatus === "any");
      expect(anyRule).toBeDefined();
      expect(Math.max(...rules.map((r) => r.rulePriority))).toBe(anyRule!.rulePriority);
    });
  });

  describe("Fargate — on-demand job", () => {
    it("awsvpc/FARGATE task definition with 1 vCPU and 2 GB", () => {
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        Family: "ugp-self-healing-crew",
        NetworkMode: "awsvpc",
        RequiresCompatibilities: ["FARGATE"],
        Cpu: "1024",
        Memory: "2048",
      });
    });

    it("The container does NOT expose ports (it is a job, not a service)", () => {
      const defs = template.findResources("AWS::ECS::TaskDefinition");
      const container = Object.values(defs)[0].Properties.ContainerDefinitions[0];
      expect(container.PortMappings).toBeUndefined();
    });

    it("No ECS Service nor Load Balancer is created", () => {
      template.resourceCountIs("AWS::ECS::Service", 0);
      template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
    });

    it("Logs to the dedicated log group with 1 week retention", () => {
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/ecs/ugp-self-healing-crew",
        RetentionInDays: 7,
      });
      const defs = template.findResources("AWS::ECS::TaskDefinition");
      const container = Object.values(defs)[0].Properties.ContainerDefinitions[0];
      expect(container.LogConfiguration.LogDriver).toBe("awslogs");
    });

    it("CONTRACT: injects the env vars with the EXACT aliases of crew/config.py", () => {
      const env = containerEnv(template);

      // Literal names and values required by `Settings` (pydantic-settings).
      expect(Object.keys(env.DDB_TABLE_NAME)).toEqual(["Ref"]);
      expect(env.DDB_TABLE_NAME.Ref).toMatch(/CircuitBreakerTable/);
      expect(env.GITHUB_REPO).toBe("demo-org/demo-repo");
      expect(env.BEDROCK_MODEL_ID).toBe(`bedrock/${PROFILE_ID}`);
      expect(env.MAX_ATTEMPTS).toBe("2");
      expect(env.AWS_REGION).toBe(TEST_ENV.region);
      expect(env.GITHUB_APP_ID).toBeDefined();
      expect(env.GITHUB_INSTALLATION_ID).toBeDefined();
      // The secret ARN arrives as Ref/Join, not as a literal.
      expect(flat(env.GITHUB_TOKEN_SECRET_ARN)).toContain("GithubAppSecret");
    });

    it("CONTRACT: the env model name and the ARN allowed in IAM are coupled", () => {
      // If the inference profile is changed, env and IAM must move TOGETHER: both derive from
      // the same `profileId`, so the container can never request a model the task role does
      // not authorize.
      const otherProfile = "us.anthropic.claude-3-5-haiku-20241022-v1:0";
      const t = synth({
        githubOrg: "demo-org",
        githubRepo: "demo-repo",
        bedrockInferenceProfileId: otherProfile,
      });
      expect(containerEnv(t).BEDROCK_MODEL_ID).toBe(`bedrock/${otherProfile}`);
      expect(flat(statementBySid(t, "InvokeClaudeSonnetViaInferenceProfile").Resource)).toContain(
        `:inference-profile/${otherProfile}`,
      );
    });

    it("REGRESSION: no env vars with old names nor phantom config remain", () => {
      // The names on the left do NOT exist in config.py: with `extra="ignore"` the crew would
      // discard them silently (mute failure), so they must never show up again.
      const names = Object.keys(containerEnv(template));
      [
        "CIRCUIT_BREAKER_TABLE",
        "GITHUB_APP_PRIVATE_KEY_SECRET_ARN",
        "GITHUB_OWNER",
        "BEDROCK_INFERENCE_PROFILE_ID",
        "PROTECTED_BRANCH",
        "ALLOW_DIRECT_PUSH",
      ].forEach((stale) => expect(names).not.toContain(stale));
    });

    it("No container env var carries a secret (only the ARN)", () => {
      const env = containerEnv(template);
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(flat(env)).not.toContain("BEGIN PRIVATE KEY");
    });

    it("The task definition does NOT inject the secret via `secrets` (the task role reads it)", () => {
      const defs = template.findResources("AWS::ECS::TaskDefinition");
      const container = Object.values(defs)[0].Properties.ContainerDefinitions[0];
      expect(container.Secrets).toBeUndefined();
    });
  });

  describe("Network — egress only, no NAT", () => {
    it("Zero NAT Gateways (the job runs for minutes; a NAT would cost ~32 USD/month/AZ)", () => {
      template.resourceCountIs("AWS::EC2::NatGateway", 0);
    });

    it("The task security group has no ingress rules", () => {
      const sgs = template.findResources("AWS::EC2::SecurityGroup");
      const crewSg = Object.values(sgs).find((sg: any) =>
        String(sg.Properties?.GroupDescription ?? "").includes("Self-healing crew"),
      ) as any;
      expect(crewSg).toBeDefined();
      expect(crewSg.Properties.SecurityGroupIngress).toBeUndefined();
    });
  });

  describe("Task role — Bedrock scoped to a single model", () => {
    it("Allows the inference profile AND the foundation models of the 3 routed regions", () => {
      const stmt = statementBySid(template, "InvokeClaudeSonnetViaInferenceProfile");
      expect(stmt.Effect).toBe("Allow");
      expect(stmt.Action).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);

      const resources = flat(stmt.Resource);
      expect(resources).toContain(`:inference-profile/${PROFILE_ID}`);
      ["us-east-1", "us-east-2", "us-west-2"].forEach((region) => {
        expect(resources).toContain(`:bedrock:${region}::foundation-model/${MODEL_ID}`);
      });
      // 1 profile + 3 foundation models, nothing else.
      expect(stmt.Resource).toHaveLength(4);
    });

    it("REGRESSION: never bedrock:* nor a foundation-model/* wildcard", () => {
      const stmt = statementBySid(template, "InvokeClaudeSonnetViaInferenceProfile");
      const body = flat(stmt);
      expect(body).not.toContain("bedrock:*");
      expect(body).not.toContain("foundation-model/*");
      expect(stmt.Resource).not.toContain("*");
    });

    it("Only GetSecretValue on the GitHub App secret", () => {
      const stmt = statementBySid(template, "ReadGithubAppPrivateKey");
      expect(stmt.Action).toBe("secretsmanager:GetSecretValue");
      expect(Object.keys(stmt.Resource)).toEqual(["Ref"]);
      expect(stmt.Resource.Ref).toMatch(/GithubAppSecret/);
    });

    it("DynamoDB: only GetItem/UpdateItem on the circuit breaker table", () => {
      const stmt = statementBySid(template, "CircuitBreakerState");
      // The crew uses update_item + get_item. PutItem would overwrite the whole counter.
      expect(stmt.Action).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
      expectArnOf(stmt.Resource, /CircuitBreakerTable/);
    });

    it("REGRESSION: the task role cannot PutItem nor delete/scan the table", () => {
      const body = flat(statementBySid(template, "CircuitBreakerState"));
      ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:*"].forEach(
        (action) => expect(body).not.toContain(action),
      );
    });

    it("The task role CANNOT read logs nor launch tasks", () => {
      const roles = template.findResources("AWS::IAM::Policy");
      const taskPolicy = Object.values(roles).find((p: any) =>
        (p.Properties.PolicyDocument.Statement as any[]).some(
          (s) => s.Sid === "CircuitBreakerState",
        ),
      ) as any;
      const sids = (taskPolicy.Properties.PolicyDocument.Statement as any[]).map((s) => s.Sid);
      expect(sids).toEqual([
        "InvokeClaudeSonnetViaInferenceProfile",
        "ReadGithubAppPrivateKey",
        "CircuitBreakerState",
      ]);
    });
  });

  describe("Execution role — pull scoped to our repository", () => {
    it("ecr:BatchGetImage is not granted on '*'", () => {
      const stmts = iamStatements(template).filter((s) =>
        JSON.stringify(s.Action).includes("ecr:BatchGetImage"),
      );
      expect(stmts).toHaveLength(1);
      expectArnOf(stmts[0].Resource, /CrewRepository/);
    });

    it("The only Resource '*' is ecr:GetAuthorizationToken (it accepts no resource)", () => {
      const wildcard = iamStatements(template).filter((s) => s.Resource === "*");
      expect(wildcard).toHaveLength(1);
      expect(wildcard[0].Action).toBe("ecr:GetAuthorizationToken");
    });

    it("Does not use the AmazonECSTaskExecutionRolePolicy managed policy", () => {
      expect(JSON.stringify(template.toJSON())).not.toContain(
        "AmazonECSTaskExecutionRolePolicy",
      );
    });
  });

  describe("Circuit breaker — DynamoDB", () => {
    it("PAY_PER_REQUEST, string PK/SK, TTL and AWS-managed encryption", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        SSESpecification: { SSEEnabled: true },
      });
    });

    it("CRITICAL INTEGRATION: the PK/SK schema matches circuit_breaker.py", () => {
      // circuit_breaker.py calls the low-level API with:
      //   Key = { "PK": {"S": "REPO#<org/repo>#RUN#<run_key>"}, "SK": {"S": "ATTEMPT_COUNTER"} }
      // DynamoDB is case-sensitive and requires the COMPLETE key: if the sort key were missing
      // (or if the names were lowercase), UpdateItem would fail with ValidationException at
      // runtime.
      const circuitBreakerTable = Object.values(
        template.findResources("AWS::DynamoDB::Table"),
      ).find(
        (table: any) => table.Properties?.TableName === "ugp-self-healing-circuit-breaker",
      ) as any;
      expect(circuitBreakerTable).toBeDefined();

      expect(circuitBreakerTable.Properties.KeySchema).toEqual([
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ]);
      expect(circuitBreakerTable.Properties.AttributeDefinitions).toEqual([
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ]);
      // The TTL attribute is a contract with the crew, which writes `expiresAt`.
      expect(circuitBreakerTable.Properties.TimeToLiveSpecification).toEqual({
        AttributeName: "expiresAt",
        Enabled: true,
      });
    });
  });

  describe("GitHub App secret", () => {
    it("Does not contain the private key in the template", () => {
      const body = JSON.stringify(template.toJSON());
      expect(body).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(body).not.toContain("BEGIN PRIVATE KEY");
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Description: Match.stringLikeRegexp("PLACEHOLDER"),
      });
    });

    it("With githubAppSecretArn it is imported instead of created", () => {
      const imported = synth({
        githubOrg: "demo-org",
        githubRepo: "demo-repo",
        githubAppSecretArn:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:ugp/github-app-AbCdEf",
      });
      imported.resourceCountIs("AWS::SecretsManager::Secret", 0);
    });
  });

  describe("OIDC — ugp-ci-deploy-role", () => {
    it("Does NOT declare an OpenIDConnectProvider (the existing one is imported)", () => {
      template.resourceCountIs("AWS::IAM::OIDCProvider", 0);
      template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    });

    it("Trust policy: web identity with exact aud and sub (StringEquals)", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        RoleName: "ugp-ci-deploy-role",
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: "sts:AssumeRoleWithWebIdentity",
              Effect: "Allow",
              Condition: {
                StringEquals: {
                  "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                  "token.actions.githubusercontent.com:sub":
                    "repo:demo-org/demo-repo:ref:refs/heads/main",
                },
              },
            }),
          ],
        },
      });
    });

    it("REGRESSION: the default sub uses no wildcards and does not cover the whole org", () => {
      const roles = template.findResources("AWS::IAM::Role");
      const ci = Object.values(roles).find(
        (r: any) => r.Properties?.RoleName === "ugp-ci-deploy-role",
      ) as any;
      const doc = JSON.stringify(ci.Properties.AssumeRolePolicyDocument);
      expect(doc).not.toContain("StringLike");
      expect(doc).not.toContain("repo:demo-org/*");
    });

    it("REPOSITORY scope uses StringLike bounded to ONE repository", () => {
      const t = synth({
        githubOrg: "demo-org",
        githubRepo: "demo-repo",
        ciSubjectScope: GithubOidcSubjectScope.REPOSITORY,
      });
      const roles = t.findResources("AWS::IAM::Role");
      const ci = Object.values(roles).find(
        (r: any) => r.Properties?.RoleName === "ugp-ci-deploy-role",
      ) as any;
      const cond = ci.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
      expect(cond.StringLike["token.actions.githubusercontent.com:sub"]).toBe(
        "repo:demo-org/demo-repo:*",
      );
      expect(cond.StringEquals["token.actions.githubusercontent.com:aud"]).toBe(
        "sts.amazonaws.com",
      );
    });

    it("ecs:RunTask scoped to the task definition family AND the cluster", () => {
      const stmt = statementBySid(template, "RunSelfHealingCrewTaskOnly");
      expect(stmt.Action).toBe("ecs:RunTask");
      expect(flat(stmt.Resource)).toContain("task-definition/ugp-self-healing-crew:*");
      expectArnOf(stmt.Condition.ArnEquals["ecs:cluster"], /CrewCluster/);
    });

    it("iam:PassRole scoped to the 2 crew roles with PassedToService=ecs-tasks", () => {
      const stmt = statementBySid(template, "PassCrewRolesToEcsTasksOnly");
      expect(stmt.Action).toBe("iam:PassRole");
      expect(stmt.Resource).toHaveLength(2);
      expect(stmt.Condition.StringEquals["iam:PassedToService"]).toBe("ecs-tasks.amazonaws.com");
    });

    it("logs scoped to the crew log group, not to log-group:*", () => {
      const stmt = statementBySid(template, "ReadCrewLogsOnly");
      expect(stmt.Action).toEqual(["logs:GetLogEvents", "logs:DescribeLogStreams"]);
      expectArnOf(stmt.Resource, /CrewLogGroup/);
    });

    it("The CI role cannot read the secret, invoke Bedrock nor touch DynamoDB", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const ciPolicy = Object.values(policies).find((p: any) =>
        (p.Properties.PolicyDocument.Statement as any[]).some(
          (s) => s.Sid === "RunSelfHealingCrewTaskOnly",
        ),
      ) as any;
      const body = flat(ciPolicy.Properties.PolicyDocument);
      expect(body).not.toContain("secretsmanager:");
      expect(body).not.toContain("bedrock:");
      expect(body).not.toContain("dynamodb:");
    });
  });

  describe("OIDC — ugp-bedrock-ci-role (Runner 1, crew inside Actions)", () => {
    /** The AWS::IAM::Role of the Runner 1 role. */
    function bedrockCiRole(t: Template = template): any {
      const role = Object.values(t.findResources("AWS::IAM::Role")).find(
        (r: any) => r.Properties?.RoleName === "ugp-bedrock-ci-role",
      ) as any;
      expect(role).toBeDefined();
      return role;
    }

    /** The single inline policy document attached to the Runner 1 role. */
    function bedrockCiPolicy(t: Template = template): any {
      const policies = Object.values(t.findResources("AWS::IAM::Policy")).filter((p: any) =>
        (p.Properties.PolicyDocument.Statement as any[]).some(
          (s) => s.Sid === "InvokeClaudeSonnetFromActionsRunner",
        ),
      ) as any[];
      expect(policies).toHaveLength(1);
      return policies[0].Properties.PolicyDocument;
    }

    it("The role exists with a 1 hour max session duration", () => {
      expect(bedrockCiRole().Properties.MaxSessionDuration).toBe(3600);
    });

    it("Trust policy: web identity against the IMPORTED provider, exact aud and sub", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        RoleName: "ugp-bedrock-ci-role",
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: "sts:AssumeRoleWithWebIdentity",
              Effect: "Allow",
              Condition: {
                StringEquals: {
                  "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                  "token.actions.githubusercontent.com:sub":
                    "repo:demo-org/demo-repo:ref:refs/heads/main",
                },
              },
            }),
          ],
        },
      });
      // The Federated principal is the oidc-provider ARN built from the stack account,
      // never a provider resource created by this stack.
      const principal = flat(
        bedrockCiRole().Properties.AssumeRolePolicyDocument.Statement[0].Principal,
      );
      expect(principal).toContain("oidc-provider/token.actions.githubusercontent.com");
      template.resourceCountIs("AWS::IAM::OIDCProvider", 0);
      template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    });

    it("REGRESSION: no StringLike and no org-wide subject in the trust policy", () => {
      const doc = flat(bedrockCiRole().Properties.AssumeRolePolicyDocument);
      expect(doc).not.toContain("StringLike");
      expect(doc).not.toContain("repo:demo-org/*");
      expect(doc).not.toContain("repo:demo-org/demo-repo:*");
    });

    it("REGRESSION: ciSubjectScope=REPOSITORY does NOT widen this role (only the deploy role)", () => {
      // Runner 1 triggers on `workflow_run`, always evaluated on the default branch: the role
      // must stay pinned to `ref:refs/heads/main` even when the deploy role is widened.
      const t = synth({
        githubOrg: "demo-org",
        githubRepo: "demo-repo",
        ciSubjectScope: GithubOidcSubjectScope.REPOSITORY,
      });
      const cond = bedrockCiRole(t).Properties.AssumeRolePolicyDocument.Statement[0].Condition;
      expect(cond.StringLike).toBeUndefined();
      expect(cond.StringEquals["token.actions.githubusercontent.com:sub"]).toBe(
        "repo:demo-org/demo-repo:ref:refs/heads/main",
      );
    });

    it("Bedrock: the same 4 ARNs as the task role and nothing else", () => {
      const stmt = statementBySid(template, "InvokeClaudeSonnetFromActionsRunner");
      expect(stmt.Effect).toBe("Allow");
      expect(stmt.Action).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
      expect(stmt.Resource).toHaveLength(4);

      const resources = flat(stmt.Resource);
      expect(resources).toContain(`:inference-profile/${PROFILE_ID}`);
      ["us-east-1", "us-east-2", "us-west-2"].forEach((region) => {
        expect(resources).toContain(`:bedrock:${region}::foundation-model/${MODEL_ID}`);
      });
    });

    it("CONTRACT: the Bedrock resources CANNOT drift from the task role's", () => {
      // Both statements are built from the same `bedrockModelArns` array. Asserting deep
      // equality is what makes a future divergence fail here instead of in production.
      expect(statementBySid(template, "InvokeClaudeSonnetFromActionsRunner").Resource).toEqual(
        statementBySid(template, "InvokeClaudeSonnetViaInferenceProfile").Resource,
      );

      const otherProfile = "us.anthropic.claude-3-5-haiku-20241022-v1:0";
      const t = synth({
        githubOrg: "demo-org",
        githubRepo: "demo-repo",
        bedrockInferenceProfileId: otherProfile,
      });
      expect(statementBySid(t, "InvokeClaudeSonnetFromActionsRunner").Resource).toEqual(
        statementBySid(t, "InvokeClaudeSonnetViaInferenceProfile").Resource,
      );
    });

    it("REGRESSION: never bedrock:* nor a foundation-model/* wildcard", () => {
      const stmt = statementBySid(template, "InvokeClaudeSonnetFromActionsRunner");
      const body = flat(stmt);
      expect(body).not.toContain("bedrock:*");
      expect(body).not.toContain("foundation-model/*");
      expect(body).not.toContain("inference-profile/*");
      expect(stmt.Resource).not.toContain("*");
    });

    it("DynamoDB: only GetItem/UpdateItem on the circuit breaker table", () => {
      const stmt = statementBySid(template, "CircuitBreakerStateFromActionsRunner");
      expect(stmt.Action).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
      expectArnOf(stmt.Resource, /CircuitBreakerTable/);
    });

    it("REGRESSION: no PutItem/Scan/Delete and no table wildcard", () => {
      const body = flat(statementBySid(template, "CircuitBreakerStateFromActionsRunner"));
      [
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Scan",
        "dynamodb:Query",
        "dynamodb:*",
        "table/*",
        "/index/",
      ].forEach((needle) => expect(body).not.toContain(needle));
    });

    it("CRITICAL: NO secretsmanager (Runner 1 uses the native GITHUB_TOKEN)", () => {
      // UGP_ALLOW_ENV_TOKEN=true in self-heal-gha.yml: the crew never signs the GitHub App JWT
      // there, so it must not be able to read the PEM. This is THE difference vs the task role.
      expect(flat(bedrockCiPolicy())).not.toContain("secretsmanager");
    });

    it("The policy grants exactly 2 statements: Bedrock and the circuit breaker", () => {
      const sids = (bedrockCiPolicy().Statement as any[]).map((s) => s.Sid);
      expect(sids).toEqual([
        "InvokeClaudeSonnetFromActionsRunner",
        "CircuitBreakerStateFromActionsRunner",
      ]);
    });

    it("REGRESSION: no ecs/logs/iam:PassRole/ecr/sts surface", () => {
      const body = flat(bedrockCiPolicy());
      ["ecs:", "logs:", "iam:PassRole", "ecr:", "sts:AssumeRole", "s3:", "kms:"].forEach(
        (needle) => expect(body).not.toContain(needle),
      );
    });

    it("REGRESSION: no statement uses Resource '*'", () => {
      (bedrockCiPolicy().Statement as any[]).forEach((s) => {
        expect(s.Resource).not.toBe("*");
        expect(flat(s.Resource)).not.toBe('["*"]');
      });
    });

    it("Does not attach any managed policy (inline, auditable least-privilege)", () => {
      expect(bedrockCiRole().Properties.ManagedPolicyArns).toBeUndefined();
    });
  });

  describe("Outputs and warnings", () => {
    it("Emits the runner wiring outputs", () => {
      [
        "CrewEcrRepositoryUri",
        "CrewClusterName",
        "CrewTaskDefinitionArn",
        "CrewTaskRoleArn",
        "CrewExecutionRoleArn",
        "CircuitBreakerTableName",
        "GithubAppSecretArn",
        "CiDeployRoleArn",
        "CiDeployRoleTrustedSubject",
        "BedrockCiRoleArn",
        "BedrockCiRoleTrustedSubject",
        "CrewLogGroupName",
        "CrewSubnetIds",
        "CrewSecurityGroupId",
        "BedrockInferenceProfileArn",
      ].forEach((key) => template.hasOutput(key, {}));
    });

    it("BedrockCiRoleArn documents the workflow variable it maps to", () => {
      template.hasOutput("BedrockCiRoleArn", {
        Description: Match.stringLikeRegexp("BEDROCK_CI_ROLE_ARN"),
      });
    });

    it("FAIL-CLOSED: without githubOrg/githubRepo and without the opt-in, synth THROWS", () => {
      // The placeholder trust policy would let whoever registers CHANGE-ME-ORG/CHANGE-ME-REPO
      // on GitHub assume both OIDC roles: it must not be synthesizable by accident.
      expect(() => {
        const app = new cdk.App();
        const stack = new SelfHealingStack(app, "PlaceholderStack", { env: TEST_ENV });
        Template.fromStack(stack);
      }).toThrow(/githubOrg|placeholder|allowPlaceholderRepo/);
    });

    it("ESCAPE HATCH: -c ugp:allowPlaceholderRepo=true synthesizes and warns instead", () => {
      const app = new cdk.App({ context: { "ugp:allowPlaceholderRepo": "true" } });
      const stack = new SelfHealingStack(app, "PlaceholderOptInStack", { env: TEST_ENV });

      // It synthesizes (no throw) and both OIDC roles keep the placeholder subject.
      const t = Template.fromStack(stack);
      ["ugp-ci-deploy-role", "ugp-bedrock-ci-role"].forEach((roleName) => {
        t.hasResourceProperties("AWS::IAM::Role", {
          RoleName: roleName,
          AssumeRolePolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Condition: Match.objectLike({
                  StringEquals: Match.objectLike({
                    "token.actions.githubusercontent.com:sub":
                      "repo:CHANGE-ME-ORG/CHANGE-ME-REPO:ref:refs/heads/main",
                  }),
                }),
              }),
            ]),
          }),
        });
      });

      const warnings = Annotations.fromStack(stack).findWarning(
        "*",
        Match.stringLikeRegexp("placeholder"),
      );
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe("Sandbox — removalPolicy", () => {
    it("ECR, DynamoDB, Secret and LogGroup are deleted with the stack", () => {
      ["AWS::ECR::Repository", "AWS::DynamoDB::Table", "AWS::SecretsManager::Secret", "AWS::Logs::LogGroup"].forEach(
        (type) => {
          Object.values(template.findResources(type)).forEach((r: any) => {
            expect(r.DeletionPolicy).toBe("Delete");
          });
        },
      );
    });
  });
});
