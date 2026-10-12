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
   * Produces `StringEquals` on `sub` = `<repoRef>:ref:refs/heads/<branch>`.
   *
   * This is the right mode for an event-driven runner that deploys: the `sub` is an exact
   * value, it accepts no wildcards and therefore cannot be widened by accident.
   */
  BRANCH = "BRANCH",

  /**
   * Any repository context (branches, tags, PRs, environments).
   * Produces `StringLike` on `sub` = `<repoRef>:*`.
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

  /**
   * Numeric, IMMUTABLE GitHub owner id — `.owner.id` of `GET /repos/<org>/<repo>`.
   *
   * Must be passed TOGETHER with {@link githubRepoId}. When both are present the `sub` uses
   * GitHub's immutable-id format (see {@link GithubOidcRole}); when both are absent it falls
   * back to the classic `repo:<org>/<repo>` format.
   */
  readonly githubOwnerId?: string;

  /**
   * Numeric, IMMUTABLE GitHub repository id — `.id` of `GET /repos/<org>/<repo>`.
   * Must be passed TOGETHER with {@link githubOwnerId}.
   */
  readonly githubRepoId?: string;

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
 *
 * ## `sub` format — immutable ids vs. classic
 *
 * GitHub can issue the repository part of the `sub` claim in two shapes:
 *
 *  - CLASSIC:   `repo:<org>/<repo>:<context>`
 *  - IMMUTABLE: `repo:<org>@<ownerId>/<repo>@<repoId>:<context>`
 *
 * The immutable shape embeds the numeric owner/repository ids, which never change: renaming
 * the repository or the owner does not silently invalidate the trust policy (and, conversely,
 * whoever re-registers a freed-up `org/repo` name cannot inherit the trust). GitHub emits it
 * once the repository/organization opts into immutable unique ids in its OIDC claim settings —
 * and when it does, it emits ONLY that shape, so a trust policy pinned to the classic string
 * stops matching and `sts:AssumeRoleWithWebIdentity` is denied.
 *
 * That is exactly what happened in this project (2025-10-08, `AccessDenied` on every
 * self-healing dispatch), hence {@link GithubOidcRoleProps.githubOwnerId} /
 * {@link GithubOidcRoleProps.githubRepoId}: the format is a VERSIONED, explicit input instead
 * of a manual edit on the deployed role. Pass both to get the immutable `sub`; pass neither to
 * keep the classic one. Passing only one is a configuration error and throws at synth.
 */
export class GithubOidcRole extends Construct {
  /**
   * Builds the repository part of the `sub` claim and reports which format was used.
   *
   * `repo:<org>@<ownerId>/<repo>@<repoId>` when BOTH ids are given, `repo:<org>/<repo>`
   * when NEITHER is. Anything in between is a configuration error: a half-filled pair almost
   * always means a context key was typo'd, and silently falling back to the classic format is
   * how a working trust policy gets reverted by the next deploy.
   */
  private static buildRepoRef(
    id: string,
    props: GithubOidcRoleProps,
  ): { readonly value: string; readonly immutable: boolean } {
    const { githubOrg, githubRepo, githubOwnerId, githubRepoId } = props;

    if ((githubOwnerId === undefined) !== (githubRepoId === undefined)) {
      throw new Error(
        `${id}: githubOwnerId and githubRepoId must be provided together (received ` +
          `githubOwnerId=${JSON.stringify(githubOwnerId)}, ` +
          `githubRepoId=${JSON.stringify(githubRepoId)}). GitHub emits the immutable subject as ` +
          "'repo:<org>@<ownerId>/<repo>@<repoId>:...': half of the pair cannot build it.",
      );
    }

    if (githubOwnerId === undefined || githubRepoId === undefined) {
      return { value: `repo:${githubOrg}/${githubRepo}`, immutable: false };
    }

    // Numeric-only: the ids go verbatim into an IAM StringEquals condition. A value such as
    // `72321567 ` or `undefined` would produce a `sub` no token can ever match, and the failure
    // would only show up at `sts:AssumeRoleWithWebIdentity` time.
    Object.entries({ githubOwnerId, githubRepoId }).forEach(([key, value]) => {
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new Error(
          `${id}: ${key} must be a positive integer as a string (GitHub numeric id), ` +
            `received: ${JSON.stringify(value)}. Get both with: ` +
            "gh api /repos/<org>/<repo> --jq '{ownerId: .owner.id, repoId: .id}'",
        );
      }
    });

    return {
      value: `repo:${githubOrg}@${githubOwnerId}/${githubRepo}@${githubRepoId}`,
      immutable: true,
    };
  }

  /** The created role. Add permissions with `addToPolicy` / `attachInlinePolicy`. */
  public readonly role: iam.Role;

  /** Exact value or pattern of the `sub` required in the trust policy (for outputs/tests). */
  public readonly subjectClaim: string;

  /** `true` when the `sub` embeds the immutable owner/repository ids. */
  public readonly usesImmutableSubjectIds: boolean;

  /** ARN of the imported OIDC provider. */
  public readonly providerArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcRoleProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const scopeKind = props.subjectScope ?? GithubOidcSubjectScope.BRANCH;
    const branch = props.branch ?? "main";
    const repoRef = GithubOidcRole.buildRepoRef(id, props);
    this.usesImmutableSubjectIds = repoRef.immutable;

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
      scopeKind === GithubOidcSubjectScope.BRANCH
        ? `${repoRef.value}:ref:refs/heads/${branch}`
        : `${repoRef.value}:*`;

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
