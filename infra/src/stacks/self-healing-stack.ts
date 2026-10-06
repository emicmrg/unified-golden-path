import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

import { GithubOidcRole, GithubOidcSubjectScope } from "../constructs/github-oidc-role";

/** Defaults of the self-healing runner. */
const DEFAULTS = {
  ecrRepositoryName: "ugp-self-healing-crew",
  taskFamily: "ugp-self-healing-crew",
  containerName: "crew",
  clusterName: "ugp-self-healing",
  logGroupName: "/aws/ecs/ugp-self-healing-crew",
  circuitBreakerTableName: "ugp-self-healing-circuit-breaker",
  ciRoleName: "ugp-ci-deploy-role",
  /** Role assumed by Runner 1 (`self-heal-gha.yml`), which runs the crew inside Actions. */
  bedrockCiRoleName: "ugp-bedrock-ci-role",
  /** Cross-region inference profile (`us.` prefix). Claude Sonnet 4.5 has NO on-demand. */
  bedrockInferenceProfileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  /**
   * Regions the `us.*` inference profile can route inference to.
   * They determine the foundation-model ARNs that must be allowed (see rationale below).
   */
  bedrockRoutedRegions: ["us-east-1", "us-east-2", "us-west-2"],
  /** 1 vCPU / 2 GB: the crew is I/O-bound against Bedrock and the GitHub API, not CPU-bound. */
  taskCpu: 1024,
  taskMemoryMiB: 2048,
  /** Obvious placeholders: the git repo does not exist yet. */
  placeholderOrg: "CHANGE-ME-ORG",
  placeholderRepo: "CHANGE-ME-REPO",
  /**
   * Context key that opts IN to synthesizing with the placeholder org/repo.
   * Without it the stack fails closed (see the guard in the constructor).
   */
  allowPlaceholderRepoContextKey: "ugp:allowPlaceholderRepo",
  /** Branch the OIDC `sub` of the CI role is scoped to (not crew config). */
  ciBranch: "main",
  /** Circuit breaker attempt cap. Must fit the 1..10 range of config.py. */
  maxAttempts: 2,
} as const;

/** Props of {@link SelfHealingStack}. */
export interface SelfHealingStackProps extends cdk.StackProps {
  /** GitHub organization/owner authorized to assume the CI role. */
  readonly githubOrg?: string;

  /** GitHub repository authorized to assume the CI role. */
  readonly githubRepo?: string;

  /**
   * ARN of an ALREADY existing secret holding the GitHub App private key.
   * If omitted, the stack creates a CDK-managed placeholder secret.
   */
  readonly githubAppSecretArn?: string;

  /** Numeric GitHub App App ID (not a secret). */
  readonly githubAppId?: string;

  /** GitHub App Installation ID in the org/repo (not a secret). */
  readonly githubInstallationId?: string;

  /** Circuit breaker attempt cap. @default 2 (valid range in the crew: 1..10) */
  readonly maxAttempts?: number;

  /** Bedrock inference profile id. @default us.anthropic.claude-sonnet-4-5-20250929-v1:0 */
  readonly bedrockInferenceProfileId?: string;

  /** Regions the inference profile may route to. @default us-east-1, us-east-2, us-west-2 */
  readonly bedrockRoutedRegions?: readonly string[];

  /** Scope of the OIDC `sub`. @default GithubOidcSubjectScope.BRANCH (`refs/heads/main`) */
  readonly ciSubjectScope?: GithubOidcSubjectScope;
}

/**
 * SelfHealingStack — execution plane of the self-healing agent (`self-healing-crew`).
 *
 * The crew is an **on-demand job**, not a service: CI launches it with `ecs:RunTask` when a
 * workflow fails, the container analyzes logs with Bedrock, proposes a fix, opens a PR and dies.
 * Hence the design decisions:
 *
 *  - Fargate with `awsvpc`, **without** a Service or Load Balancer and **without** inbound ports.
 *  - VPC with public subnets and **zero NAT Gateways**: egress goes through the IGW with a
 *    public IP assigned at `RunTask`. A NAT would cost ~32 USD/month per AZ for a job that runs
 *    for minutes. The Security Group allows no ingress, so the public IP exposes nothing.
 *  - All state lives in a DynamoDB table (circuit breaker) and the only secret is read at
 *    runtime from Secrets Manager using the **task role**.
 *
 * Role separation (deliberate, it is the teaching point of the golden path):
 *  - `executionRole`: used by the **ECS agent** to `docker pull` from ECR and create the log
 *    streams. It cannot call Bedrock nor read the secret.
 *  - `taskRole`: used by the **crew code**. Bedrock scoped to one model, one secret, one table
 *    and two DynamoDB actions (GetItem/UpdateItem). Nothing else.
 *  - `ugp-ci-deploy-role`: assumed by GitHub Actions via OIDC. It can launch THIS task and read
 *    ITS logs; it cannot read the secret, nor invoke Bedrock, nor touch the table.
 *  - `ugp-bedrock-ci-role`: assumed by GitHub Actions via OIDC by **Runner 1**
 *    (`self-heal-gha.yml`), which runs the crew *inside* the Actions runner instead of
 *    dispatching it to Fargate. It gets exactly what the crew code needs there — Bedrock and
 *    the circuit breaker table — and NOTHING of the ECS surface. See section 7b.
 *
 * The two OIDC roles are mutually exclusive at runtime (`vars.SELF_HEAL_MODE` selects one
 * runner), but both are declared so switching modes is a repository-variable change, not a
 * deploy.
 *
 * Nothing hardcoded about `account`/`region`: every ARN is built with `cdk.Arn.format` over
 * `this.account` / `this.region` / `this.partition`.
 */
export class SelfHealingStack extends cdk.Stack {
  /** ECR repository holding the crew image. */
  public readonly repository: ecr.Repository;

  /** ECS cluster where the job runs. */
  public readonly cluster: ecs.Cluster;

  /** Fargate task definition of the crew. */
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  /** Circuit breaker DynamoDB table. */
  public readonly circuitBreakerTable: dynamodb.Table;

  /** Secret with the GitHub App private key (created or imported). */
  public readonly githubAppSecret: secretsmanager.ISecret;

  /** Dedicated log group of the crew. */
  public readonly logGroup: logs.LogGroup;

  /** Role GitHub Actions assumes via OIDC. */
  public readonly ciDeployRole: iam.Role;

  /** Role Runner 1 (`self-heal-gha.yml`) assumes via OIDC: Bedrock + circuit breaker only. */
  public readonly bedrockCiRole: iam.Role;

  constructor(scope: Construct, id: string, props: SelfHealingStackProps = {}) {
    super(scope, id, props);

    const githubOrg = props.githubOrg ?? DEFAULTS.placeholderOrg;
    const githubRepo = props.githubRepo ?? DEFAULTS.placeholderRepo;
    const usingPlaceholders =
      githubOrg === DEFAULTS.placeholderOrg || githubRepo === DEFAULTS.placeholderRepo;

    // FAIL-CLOSED on the OIDC trust policy.
    // With the placeholders, BOTH OIDC roles (`ugp-ci-deploy-role`, `ugp-bedrock-ci-role`) trust
    // `repo:CHANGE-ME-ORG/CHANGE-ME-REPO:ref:refs/heads/main`. That is not merely useless: the
    // org/repo does not exist, so ANYONE who registers that name on GitHub can mint a token with
    // that exact `sub` and assume both roles. An advisory warning is not enough for a template
    // that can be deployed, so synth fails unless the placeholders are opted into EXPLICITLY
    // (local synth / talk demo), in which case only the warning below is emitted.
    const allowPlaceholderRepoContext = this.node.tryGetContext(
      DEFAULTS.allowPlaceholderRepoContextKey,
    );
    const allowPlaceholderRepo =
      allowPlaceholderRepoContext === true || allowPlaceholderRepoContext === "true";
    if (usingPlaceholders && !allowPlaceholderRepo) {
      throw new Error(
        `${id}: githubOrg/githubRepo are missing or still placeholders ` +
          `('${githubOrg}/${githubRepo}'), so the trust policy of both OIDC roles ` +
          `(${DEFAULTS.ciRoleName}, ${DEFAULTS.bedrockCiRoleName}) would trust a repository ` +
          "that anyone could register on GitHub and then assume the roles. " +
          "Pass the real values: -c ugp:githubOrg=<org> -c ugp:githubRepo=<repo>. " +
          `For a local synth/demo opt in explicitly: -c ${DEFAULTS.allowPlaceholderRepoContextKey}=true ` +
          "(NEVER deploy a template synthesized that way).",
      );
    }

    const profileId = props.bedrockInferenceProfileId ?? DEFAULTS.bedrockInferenceProfileId;
    const routedRegions = props.bedrockRoutedRegions ?? DEFAULTS.bedrockRoutedRegions;

    // config.py declares `max_attempts` with ge=1/le=10: outside that range the container
    // blows up at startup. Better to fail in `cdk synth` than on the first RunTask.
    const maxAttempts = props.maxAttempts ?? DEFAULTS.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new Error(
        `maxAttempts must be an integer between 1 and 10 (config.py contract), received: ${maxAttempts}`,
      );
    }

    // Component tag specific to this stack (high priority to win over the global App tag).
    cdk.Tags.of(this).add("Component", "self-healing", { priority: 300 });

    // ── 1. Crew image registry ───────────────────────────────────────────────
    this.repository = new ecr.Repository(this, "CrewRepository", {
      repositoryName: DEFAULTS.ecrRepositoryName,
      imageTagMutability: ecr.TagMutability.MUTABLE, // CI publishes `latest` + the commit sha.
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      // Sandbox: the stack is brought up and torn down in the demo. `emptyOnDelete` requires
      // DESTROY.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          // UNTAGGED rules are evaluated first; the TagStatus.ANY rule must come last
          // (ECR requires the "any tag" rule to have the highest rulePriority).
          rulePriority: 1,
          description: "Delete untagged images older than 1 day",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(1),
        },
        {
          rulePriority: 2,
          description: "Keep only the 10 most recent images",
          maxImageCount: 10,
        },
      ],
    });

    // ── 2. Circuit breaker (DynamoDB) ────────────────────────────────────────
    // Counts self-healing attempts per repo+workflow and opens the circuit after N failures,
    // so the agent does not loop generating PRs over the same failure.
    this.circuitBreakerTable = new dynamodb.Table(this, "CircuitBreakerTable", {
      tableName: DEFAULTS.circuitBreakerTableName,
      // CONTRACT with `self-healing-crew/crew/circuit_breaker.py` (source of truth):
      //   PK (S) = `REPO#<org/repo>#RUN#<run_key>`  (e.g. `REPO#org/repo#RUN#18234`)
      //   SK (S) = `ATTEMPT_COUNTER`                (constant `_SK`; leaves room for other SKs)
      // Non-key attributes: attempt_count (N), created_at (S), last_updated (S),
      // escalated (BOOL), expiresAt (N, TTL).
      // The names are UPPERCASE because the crew calls the low-level API with
      // Key={"PK": ..., "SK": ...}: DynamoDB is case-sensitive and "pk" does NOT match "PK".
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // sporadic job: on-demand is cheaper.
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // TTL itself cleans up old counters: the circuit "re-arms" on its own.
      // CONTRACT: the crew writes the attribute with this EXACT NAME (`expiresAt`, epoch in
      // seconds). If it is renamed here, DynamoDB silently stops expiring the items.
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false }, // sandbox, ephemeral state.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 3. GitHub App private key secret ─────────────────────────────────────
    // The crew uses the private key ONLY to sign a JWT and exchange it for an *installation
    // access token* of ~60 min (ephemeral token). A long-lived PAT is never persisted.
    if (props.githubAppSecretArn) {
      this.githubAppSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "GithubAppSecret",
        props.githubAppSecretArn,
      );
    } else {
      this.githubAppSecret = new secretsmanager.Secret(this, "GithubAppSecret", {
        description:
          "PLACEHOLDER - PEM private key of the self-healing crew GitHub App. The value is NOT " +
          "managed by CDK: upload it with `aws secretsmanager put-secret-value`.",
        // CDK requires an initial value; we generate a random, throwaway one instead of putting
        // the real PEM in the template (a CloudFormation template is NOT a place for secrets).
        generateSecretString: {
          passwordLength: 32,
          excludePunctuation: true,
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    // ── 4. Network: VPC with no NAT, egress only ─────────────────────────────
    const vpc = new ec2.Vpc(this, "CrewVpc", {
      maxAzs: 2,
      natGateways: 0,
      ipAddresses: ec2.IpAddresses.cidr("10.60.0.0/16"),
      subnetConfiguration: [
        { name: "public-egress", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true, // closes the VPC default SG (CIS / cdk-nag).
    });

    const taskSecurityGroup = new ec2.SecurityGroup(this, "CrewSecurityGroup", {
      vpc,
      description: "Self-healing crew task: egress only (Bedrock, ECR, GitHub API)",
      allowAllOutbound: true,
    });
    // No ingress rules: the job listens to nothing. We make it explicit for the reader.
    cdk.Tags.of(taskSecurityGroup).add("Ingress", "none");

    // ── 5. Observability: dedicated log group ────────────────────────────────
    this.logGroup = new logs.LogGroup(this, "CrewLogGroup", {
      logGroupName: DEFAULTS.logGroupName,
      retention: logs.RetentionDays.ONE_WEEK, // the agent's reasoning is not legal evidence.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 6. Cluster + Fargate task definition ─────────────────────────────────
    this.cluster = new ecs.Cluster(this, "CrewCluster", {
      clusterName: DEFAULTS.clusterName,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED, // minutes-long job: not worth the cost.
    });

    const executionRole = new iam.Role(this, "CrewExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description:
        "ECS agent execution role: pull the image from ECR + write logs",
    });
    // Pull permissions scoped to THIS repository. `grantPull` already includes
    // `ecr:GetAuthorizationToken` on `*` (that action does not accept resource-level
    // permissions), which is why the AmazonECSTaskExecutionRolePolicy managed policy is NOT
    // used: it would allow `ecr:BatchGetImage` on any repository in the account.
    this.repository.grantPull(executionRole);
    this.logGroup.grantWrite(executionRole);

    const taskRole = new iam.Role(this, "CrewTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Self-healing crew task role: Bedrock (1 model) + 1 secret + 1 table",
    });

    // ── 6a. Bedrock: the real minimum for an inference profile ───────────────
    //
    // RATIONALE (why the inference profile ARN is not enough):
    // When invoking a cross-region inference profile (`us.*`), Bedrock authorizes the call
    // TWICE:
    //   1. Against the requested resource: the `inference-profile/...` of THIS account and region.
    //   2. Against the specific `foundation-model/...` the profile routes the request to, in the
    //      destination region picked by the router (us-east-1, us-east-2 or us-west-2).
    // If only (1) is allowed, the call works intermittently or always fails with
    // `AccessDeniedException`, because step (2) is evaluated against a non-allowed ARN. That is
    // why the three regional foundation-model ARNs of the profile are listed — and NOTHING
    // ELSE: no `bedrock:*`, no `foundation-model/*`, no other regions.
    // Foundation model ARNs are owned by the service: their account field is EMPTY.
    const modelId = profileId.replace(/^[a-z]{2,3}\./, ""); // `us.anthropic...` → `anthropic...`
    const inferenceProfileArn = cdk.Arn.format(
      { service: "bedrock", resource: "inference-profile", resourceName: profileId },
      this,
    );
    const foundationModelArns = routedRegions.map((region) =>
      cdk.Arn.format(
        {
          service: "bedrock",
          region,
          account: "", // foundation models do not belong to an account.
          resource: "foundation-model",
          resourceName: modelId,
        },
        this,
      ),
    );

    // SINGLE SOURCE OF TRUTH for the Bedrock resources: both the crew task role (Fargate,
    // Runner 2) and `ugp-bedrock-ci-role` (Actions, Runner 1) point at this same array, so the
    // two execution modes can never authorize different models.
    const bedrockModelArns: readonly string[] = [inferenceProfileArn, ...foundationModelArns];

    /** Actions the crew needs on Bedrock: invoke, buffered or streamed. Nothing else. */
    const bedrockInvokeActions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ] as const;

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeClaudeSonnetViaInferenceProfile",
        actions: [...bedrockInvokeActions],
        resources: [...bedrockModelArns],
      }),
    );

    // ── 6b. Secret: only GetSecretValue, only that secret ───────────────────
    // It is read with the SDK from the code (task role) instead of injecting it as `secrets:`
    // in the task definition (which would resolve it with the EXECUTION role). That way the
    // secret stays under the application role and does not show up on the ECS API surface.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadGithubAppPrivateKey",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [this.githubAppSecret.secretArn],
      }),
    );

    // ── 6c. Circuit breaker: 2 actions, 1 table, no indexes ─────────────────
    // `circuit_breaker.py` only calls `update_item` (atomic increment with ConditionExpression
    // + `mark_escalated`) and `get_item` (read of the counter and of the `escalated` flag).
    // It does NOT use `put_item`: a PutItem would overwrite the whole item and destroy the
    // counter, which is exactly what the circuit breaker must preserve.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CircuitBreakerState",
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [this.circuitBreakerTable.tableArn],
      }),
    );

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "CrewTaskDefinition", {
      family: DEFAULTS.taskFamily,
      cpu: DEFAULTS.taskCpu,
      memoryLimitMiB: DEFAULTS.taskMemoryMiB,
      executionRole,
      taskRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    this.taskDefinition.addContainer(DEFAULTS.containerName, {
      containerName: DEFAULTS.containerName,
      image: ecs.ContainerImage.fromEcrRepository(this.repository, "latest"),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "crew",
        logGroup: this.logGroup,
      }),
      // None of these variables is a secret: they are identifiers and parameters.
      //
      // CONTRACT with `self-healing-crew/crew/config.py` (pydantic-settings, `extra="ignore"`):
      // the `alias`es of that model are the SOURCE OF TRUTH for these names. The model silently
      // ignores any variable it does not recognize, so a misnamed variable does not fail at
      // startup: it blows up later (or stays at the default). If an alias is renamed in
      // config.py, it must be renamed here in the same change.
      environment: {
        AWS_REGION: this.region,
        // DELIBERATE COUPLING: the container env and the ARN allowed in IAM both derive from
        // `profileId`. `BEDROCK_MODEL_ID` carries the `bedrock/` prefix LiteLLM requires, and
        // the policy in 6a authorizes the `inference-profile/<profileId>` + its foundation
        // models. Changing the model through `bedrockInferenceProfileId` moves BOTH THINGS at
        // once; there is no way for the container to request a model the task role does not allow.
        BEDROCK_MODEL_ID: `bedrock/${profileId}`,
        DDB_TABLE_NAME: this.circuitBreakerTable.tableName,
        GITHUB_APP_ID: props.githubAppId ?? "",
        GITHUB_INSTALLATION_ID: props.githubInstallationId ?? "",
        // A single `org/repo` string: config.py validates that exact format.
        GITHUB_REPO: `${githubOrg}/${githubRepo}`,
        GITHUB_TOKEN_SECRET_ARN: this.githubAppSecret.secretArn,
        // Circuit breaker attempt cap (config.py parses it to int, 1..10).
        MAX_ATTEMPTS: String(maxAttempts),
      },
      // No `portMappings` declared: it is a job, it exposes nothing.
    });

    // ── 7. CI role (OIDC) — the "done right" counterexample ─────────────────
    const oidc = new GithubOidcRole(this, "CiDeployRole", {
      githubOrg,
      githubRepo,
      branch: DEFAULTS.ciBranch,
      subjectScope: props.ciSubjectScope ?? GithubOidcSubjectScope.BRANCH,
      roleName: DEFAULTS.ciRoleName,
      description:
        "GitHub Actions (OIDC): launches the self-healing crew and reads its logs. No access " +
        "to the secret, nor to Bedrock, nor to DynamoDB.",
    });
    this.ciDeployRole = oidc.role;

    // Any revision of the family (CI does not know the revision number after each deploy),
    // but ONLY this task definition family.
    const taskDefinitionFamilyArn = cdk.Arn.format(
      { service: "ecs", resource: "task-definition", resourceName: `${DEFAULTS.taskFamily}:*` },
      this,
    );

    this.ciDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RunSelfHealingCrewTaskOnly",
        actions: ["ecs:RunTask"],
        resources: [taskDefinitionFamilyArn],
        // Double lock: the right task definition AND the right cluster.
        conditions: { ArnEquals: { "ecs:cluster": this.cluster.clusterArn } },
      }),
    );

    this.ciDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DescribeOwnTasks",
        actions: ["ecs:DescribeTasks"],
        resources: [
          cdk.Arn.format(
            { service: "ecs", resource: "task", resourceName: `${this.cluster.clusterName}/*` },
            this,
          ),
        ],
        conditions: { ArnEquals: { "ecs:cluster": this.cluster.clusterArn } },
      }),
    );

    // `RunTask` implies handing two roles to ECS. Without the `PassedToService` condition, this
    // permission would allow lending those roles to any service that accepts a role.
    this.ciDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassCrewRolesToEcsTasksOnly",
        actions: ["iam:PassRole"],
        resources: [taskRole.roleArn, executionRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );

    // Log reading scoped to the crew log group (not the account's `log-group:*`).
    // `logGroup.logGroupArn` already ends in `:*`, which covers all of its log streams —
    // appending `:log-stream:*` would produce `...:*:log-stream:*`, an ARN that matches nothing.
    this.ciDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadCrewLogsOnly",
        actions: ["logs:GetLogEvents", "logs:DescribeLogStreams"],
        resources: [this.logGroup.logGroupArn],
      }),
    );

    // ── 7b. Bedrock CI role (OIDC) — Runner 1 runs the crew inside Actions ──
    //
    // `.github/workflows/self-heal-gha.yml` assumes THIS role (repository variable
    // `BEDROCK_CI_ROLE_ARN`) and then runs `ugp-selfheal` on the GitHub-hosted runner. So the
    // role is not a "deploy" role: it carries the permissions of the crew CODE, and only the
    // subset of them that mode needs.
    //
    // Trust is pinned to the BRANCH scope on purpose and does NOT follow `props.ciSubjectScope`:
    // the workflow triggers on `workflow_run`, an event GitHub always evaluates on the default
    // branch, so the token `sub` is exactly `repo:<org>/<repo>:ref:refs/heads/main`. Widening it
    // to `StringLike repo:<org>/<repo>:*` would let a pull-request workflow — whose content any
    // fork contributor can propose — obtain Bedrock credentials. There is no reason to pay that.
    const bedrockOidc = new GithubOidcRole(this, "BedrockCiRole", {
      githubOrg,
      githubRepo,
      branch: DEFAULTS.ciBranch,
      subjectScope: GithubOidcSubjectScope.BRANCH,
      roleName: DEFAULTS.bedrockCiRoleName,
      description:
        "GitHub Actions (OIDC) Runner 1: runs the self-healing crew inside the Actions runner. " +
        "Bedrock (1 model) + circuit breaker table only. No secret, no ECS, no logs.",
    });
    this.bedrockCiRole = bedrockOidc.role;

    // Same model surface as the task role: the shared `bedrockModelArns` array guarantees the
    // Actions runner and the Fargate task cannot diverge. The Sid is suffixed so the two
    // documents stay distinguishable in the console and in the tests.
    this.bedrockCiRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeClaudeSonnetFromActionsRunner",
        actions: [...bedrockInvokeActions],
        resources: [...bedrockModelArns],
      }),
    );

    // Same two DynamoDB actions as the task role: `circuit_breaker.py` only calls `update_item`
    // (atomic increment / `mark_escalated`) and `get_item`. No PutItem (it would clobber the
    // counter), no Scan, no index, no table wildcard.
    this.bedrockCiRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CircuitBreakerStateFromActionsRunner",
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [this.circuitBreakerTable.tableArn],
      }),
    );

    // DELIBERATELY ABSENT — `secretsmanager:GetSecretValue`.
    // This is the key difference against the Fargate task role. Runner 1 sets
    // `UGP_ALLOW_ENV_TOKEN=true` and hands the crew the workflow's native `GITHUB_TOKEN`
    // (`contents:write` + `pull-requests:write`, scoped to this repo and expiring with the job),
    // so it never signs a GitHub App JWT and never reads the PEM. Granting the secret here would
    // hand an Actions runner a credential good for the whole App installation — strictly more
    // power than the job needs. Nothing else is granted either: no `ecs:*` (Runner 1 launches no
    // task) and no `logs:*` (it reads the CI log through the GitHub API, not CloudWatch).

    // ── 8. Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "CrewEcrRepositoryUri", {
      value: this.repository.repositoryUri,
      description: "ECR repository URI (target of the CI docker push)",
    });

    new cdk.CfnOutput(this, "CrewClusterName", {
      value: this.cluster.clusterName,
      description: "ECS cluster where the crew job is launched",
    });

    new cdk.CfnOutput(this, "CrewTaskDefinitionArn", {
      value: this.taskDefinition.taskDefinitionArn,
      description: "ARN (with revision) of the crew task definition",
    });

    new cdk.CfnOutput(this, "CrewTaskRoleArn", {
      value: taskRole.roleArn,
      description: "Crew task role: Bedrock 1 model + 1 secret + 1 DynamoDB table",
    });

    new cdk.CfnOutput(this, "CrewExecutionRoleArn", {
      value: executionRole.roleArn,
      description: "ECS agent execution role (ECR pull + logs)",
    });

    new cdk.CfnOutput(this, "CircuitBreakerTableName", {
      value: this.circuitBreakerTable.tableName,
      description:
        "Circuit breaker DynamoDB table. PK='REPO#<org/repo>#RUN#<run_key>', " +
        "SK='ATTEMPT_COUNTER', counter in attempt_count, TTL in expiresAt",
    });

    new cdk.CfnOutput(this, "GithubAppSecretArn", {
      value: this.githubAppSecret.secretArn,
      description: props.githubAppSecretArn
        ? "Imported secret with the GitHub App private key"
        : "PLACEHOLDER secret: upload the private key with `aws secretsmanager put-secret-value`",
    });

    new cdk.CfnOutput(this, "CiDeployRoleArn", {
      value: this.ciDeployRole.roleArn,
      description: "Role to use in aws-actions/configure-aws-credentials (role-to-assume)",
    });

    new cdk.CfnOutput(this, "CiDeployRoleTrustedSubject", {
      value: oidc.subjectClaim,
      description: "`sub` claim required in the CI role trust policy",
    });

    new cdk.CfnOutput(this, "BedrockCiRoleArn", {
      value: this.bedrockCiRole.roleArn,
      description:
        "Runner 1 role (Bedrock + circuit breaker). Set it as the repository variable " +
        "BEDROCK_CI_ROLE_ARN consumed by .github/workflows/self-heal-gha.yml " +
        "(role-to-assume of aws-actions/configure-aws-credentials)",
    });

    new cdk.CfnOutput(this, "BedrockCiRoleTrustedSubject", {
      value: bedrockOidc.subjectClaim,
      description: "`sub` claim required in the Runner 1 role trust policy",
    });

    new cdk.CfnOutput(this, "CrewLogGroupName", {
      value: this.logGroup.logGroupName,
      description: "Dedicated crew log group (1 week retention)",
    });

    new cdk.CfnOutput(this, "CrewSubnetIds", {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(","),
      description: "Subnets for the ecs:RunTask networkConfiguration (assignPublicIp=ENABLED)",
    });

    new cdk.CfnOutput(this, "CrewSecurityGroupId", {
      value: taskSecurityGroup.securityGroupId,
      description: "Task security group (egress only)",
    });

    new cdk.CfnOutput(this, "BedrockInferenceProfileArn", {
      value: inferenceProfileArn,
      description: "Inference profile allowed to the task role (only authorized model)",
    });

    // ── 9. Synth warnings ───────────────────────────────────────────────────
    // Reached only on the explicit opt-in path (`-c ugp:allowPlaceholderRepo=true`); without it
    // the fail-closed guard at the top of the constructor already aborted the synth.
    if (usingPlaceholders) {
      cdk.Annotations.of(this).addWarningV2(
        "ugp:self-healing:github-placeholders",
        "githubOrg/githubRepo are still placeholders: the trust policy of both OIDC roles " +
          `(${DEFAULTS.ciRoleName}, ${DEFAULTS.bedrockCiRoleName}) points at ` +
          `'repo:${githubOrg}/${githubRepo}:...'. This template is for LOCAL SYNTH ONLY ` +
          `(${DEFAULTS.allowPlaceholderRepoContextKey}=true): do NOT deploy it, anyone who ` +
          "registers that org/repo on GitHub could assume both roles. " +
          "Before deploying for real: cdk deploy SelfHealingStack " +
          "-c ugp:githubOrg=<org> -c ugp:githubRepo=<repo>",
      );
    }

    if (!props.githubAppId || !props.githubInstallationId) {
      cdk.Annotations.of(this).addWarningV2(
        "ugp:self-healing:github-app-identifiers",
        "githubAppId/githubInstallationId are empty in the task definition. config.py requires " +
          "them to sign the JWT and exchange the installation token: the crew would start and " +
          "fail to authenticate against GitHub. Pass them via context: " +
          "-c ugp:githubAppId=<id> -c ugp:githubInstallationId=<id>",
      );
    }

    if (!props.githubAppSecretArn) {
      cdk.Annotations.of(this).addInfo(
        "The GitHub App secret is created with a random, throwaway value. After the deploy, " +
          "replace it with the real PEM private key (put-secret-value); CDK does not overwrite it.",
      );
    }
  }
}
