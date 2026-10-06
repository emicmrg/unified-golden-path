import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** URL (without scheme) of the GitHub Actions OIDC issuer. */
export const GITHUB_OIDC_ISSUER = "token.actions.githubusercontent.com";

/** Audience requested by `aws-actions/configure-aws-credentials` by default. */
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";

/** Scope of the OIDC token `sub` allowed to assume the role. */
export enum GithubOidcSubjectScope {
  /**
   * ONLY workflows running on a commit of the given branch.
   * Produces `StringEquals` on `sub` = `repo:<org>/<repo>:ref:refs/heads/<branch>`.
   *
   * This is the right mode for an event-driven runner that deploys: the `sub` is an exact
   * value, it accepts no wildcards and therefore cannot be widened by accident.
   */
  BRANCH = "BRANCH",

  /**
   * Any repository context (branches, tags, PRs, environments).
   * Produces `StringLike` on `sub` = `repo:<org>/<repo>:*`.
   *
   * Use it only if you really need to assume the role from pull requests. It is still scoped
   * to ONE specific repository; never use `repo:<org>/*`, because that lets ANY repo in the
   * organization (including one just created by whoever has permission to create repos) assume
   * the role: that is a privilege escalation hole, not a convenience.
   */
  REPOSITORY = "REPOSITORY",
}

/** Props of {@link GithubOidcRole}. */
export interface GithubOidcRoleProps {
  /** GitHub organization/owner (e.g. `slalom-gdl`). */
  readonly githubOrg: string;

  /** GitHub repository name (e.g. `unified-golden-path`). */
  readonly githubRepo: string;

  /** Scope of the `sub`. @default GithubOidcSubjectScope.BRANCH */
  readonly subjectScope?: GithubOidcSubjectScope;

  /** Branch required when `subjectScope` is BRANCH. @default 'main' */
  readonly branch?: string;

  /** Physical role name. Useful to reference it from the workflow. */
  readonly roleName?: string;

  /** Role description. */
  readonly description?: string;

  /** Maximum session duration. @default cdk.Duration.hours(1) */
  readonly maxSessionDuration?: cdk.Duration;
}

/**
 * GithubOidcRole — role assumable by GitHub Actions via OpenID Connect (web identity),
 * without long-lived access keys.
 *
 * IMPORTANT — the OIDC provider is IMPORTED, never created:
 * IAM only allows ONE `OpenIDConnectProvider` per URL per account. If the provider for
 * `token.actions.githubusercontent.com` already exists (which is the case in this account),
 * declaring it in CloudFormation fails at deploy time with `EntityAlreadyExists` and, worse, a
 * later `cdk destroy` could delete the provider shared by every other pipeline in the account.
 * That is why it is referenced with `iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn`.
 *
 * The trust policy ALWAYS requires both conditions:
 *  - `aud` = `sts.amazonaws.com` (prevents confused-deputy with tokens issued for another
 *    audience).
 *  - `sub` scoped to the specific repository (see {@link GithubOidcSubjectScope}).
 *
 * Without the `sub` condition, ANY GitHub repository in the world could assume the role.
 */
export class GithubOidcRole extends Construct {
  /** The created role. Add permissions with `addToPolicy` / `attachInlinePolicy`. */
  public readonly role: iam.Role;

  /** Exact value or pattern of the `sub` required in the trust policy (for outputs/tests). */
  public readonly subjectClaim: string;

  /** ARN of the imported OIDC provider. */
  public readonly providerArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcRoleProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const scopeKind = props.subjectScope ?? GithubOidcSubjectScope.BRANCH;
    const branch = props.branch ?? "main";
    const repoRef = `repo:${props.githubOrg}/${props.githubRepo}`;

    // ARN of the existing provider, derived from the stack account/partition (nothing hardcoded).
    this.providerArn = cdk.Arn.format(
      {
        service: "iam",
        region: "", // IAM is global: the region field is left empty.
        resource: "oidc-provider",
        resourceName: GITHUB_OIDC_ISSUER,
      },
      stack,
    );

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GithubOidcProvider",
      this.providerArn,
    );

    this.subjectClaim =
      scopeKind === GithubOidcSubjectScope.BRANCH ? `${repoRef}:ref:refs/heads/${branch}` : `${repoRef}:*`;

    // Exact `sub` → StringEquals. `sub` with a wildcard → StringLike (StringEquals does not
    // interpret `*`).
    const subjectCondition: Record<string, Record<string, string>> =
      scopeKind === GithubOidcSubjectScope.BRANCH
        ? { StringEquals: { [`${GITHUB_OIDC_ISSUER}:sub`]: this.subjectClaim } }
        : { StringLike: { [`${GITHUB_OIDC_ISSUER}:sub`]: this.subjectClaim } };

    const conditions: Record<string, Record<string, string>> = {
      StringEquals: {
        [`${GITHUB_OIDC_ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE,
        ...(subjectCondition.StringEquals ?? {}),
      },
      ...(subjectCondition.StringLike ? { StringLike: subjectCondition.StringLike } : {}),
    };

    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName,
      description: props.description,
      maxSessionDuration: props.maxSessionDuration ?? cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, conditions),
    });
  }
}
