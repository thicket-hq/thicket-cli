// The per-invocation context every command receives: resolved settings,
// the SDK client (lazy — commands that never touch the API work without a
// token), and org resolution with a single-org auto-pick.
import { createRequire } from "node:module";
import { Thicket, ThicketError, type OrgScope } from "thicket-sdk";
import { resolveSettings, type ResolvedSettings } from "./config.js";
import { type TokenStore } from "./keyring.js";
import { connectionCredentials } from "./oauth.js";
import { findOrgByRef, orgRefKey } from "./org-ref.js";
import { CliError } from "./output.js";

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export const VERSION: string = pkg.version;

export function userAgent(): string {
  return `thicket-cli/${VERSION} (+https://www.thickethq.com/developers/api)`;
}

export type AuthorizationOrg = {
  id: string;
  name: string;
  /** For building paths only: a rename regenerates it. */
  slug: string;
  /** The workspace's permanent key; with id, its identity. */
  key: string;
  href: string;
  membership_id: string;
  role: string;
  /** "agent" when the credential belongs to an AI agent membership. */
  membership_kind?: "person" | "agent";
};

export type AuthorizationDoc = {
  identity: { id: string };
  organizations: AuthorizationOrg[];
  scope: "read" | "full";
  expires_at: string | null;
};

export type Person = {
  membership_id: string;
  name: string;
  email: string;
  role: string;
  kind?: "person" | "agent";
  active?: boolean | null;
  title?: string | null;
  company_name?: string | null;
  image?: string | null;
};

export class CliContext {
  readonly settings: ResolvedSettings;
  /** The environment this invocation resolves against (injected in tests). */
  readonly env: NodeJS.ProcessEnv;
  private fetchImpl?: typeof globalThis.fetch;
  private sdkInstance: Thicket | null = null;
  private authDoc: AuthorizationDoc | null = null;
  private orgOverride: string | null = null;
  private orgOverrideChecked: string | null = null;
  private orgHandedOut = false;
  private peopleCache: Person[] | null = null;

  constructor(
    flags: { org?: string; profile?: string; baseUrl?: string },
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl?: typeof globalThis.fetch,
  ) {
    this.settings = resolveSettings({ flags, env });
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  /** The token + where it came from, or null when signed out. */
  async credentials(): Promise<{ token: string; store: TokenStore } | null> {
    const envToken = this.env.THICKET_TOKEN?.trim();
    return envToken
      ? { token: envToken, store: "env" }
      : await connectionCredentials(this.settings.profile, this.settings.baseUrl, this.env, userAgent(), this.fetchImpl);
  }

  async sdk(): Promise<Thicket> {
    if (this.sdkInstance) return this.sdkInstance;
    const creds = await this.credentials();
    if (!creds) {
      throw new CliError(
        "auth",
        `Not signed in (profile "${this.settings.profile}")`,
        "Run: thicket auth login",
      );
    }
    this.sdkInstance = new Thicket({
      token: async () => {
        const current = await this.credentials();
        if (!current) throw new CliError("auth", "Not signed in", "Run: thicket auth login");
        return current.token;
      },
      userAgent: userAgent(),
      baseUrl: this.settings.baseUrl,
      fetch: this.fetchImpl,
    });
    return this.sdkInstance;
  }

  /** Transport injection also covers sign-in, refresh and disconnection. */
  fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    return (this.fetchImpl ?? globalThis.fetch)(input, init);
  }

  /** GET /authorization, cached for the invocation. */
  async authorization(): Promise<AuthorizationDoc> {
    if (this.authDoc) return this.authDoc;
    const sdk = await this.sdk();
    this.authDoc = await sdk.client.request<AuthorizationDoc>(
      "GET",
      "/api/v1/authorization",
    );
    return this.authDoc;
  }

  /**
   * A pasted URL names its org; adopt it for this invocation unless --org
   * was passed explicitly and names another workspace (then the flag is the
   * user's word). orgSlug() settles that before any request goes out; once a
   * path was built from --org, a URL that may name another workspace can no
   * longer be checked first, so a differing key is refused here.
   */
  adoptOrg(slug: string): void {
    if (this.orgHandedOut && this.flagKeyDiffers(slug)) throw this.otherOrg(slug);
    this.orgOverride = slug;
  }

  /**
   * Whether --org was passed and carries another key than a URL's reference.
   * Equal keys name one workspace (an old slug, the bare key, the current
   * slug): never whole strings.
   */
  private flagKeyDiffers(url: string): boolean {
    const flag = this.settings.org;
    return this.settings.sources.org === "flag" && !!flag && orgRefKey(url) !== orgRefKey(flag);
  }

  private otherOrg(url: string): CliError {
    return new CliError(
      "usage",
      `That URL belongs to "${url}" but --org says "${this.settings.org}"`,
      "Drop --org, or pass the matching one",
    );
  }

  /**
   * Keys that differ can still name one workspace: a pre-July workspace's
   * slug does not carry its key, so the two must resolve to the same
   * organization.
   */
  private async refuseOtherOrg(url: string): Promise<void> {
    if (!this.flagKeyDiffers(url)) return;
    const named = await this.membershipFor(url);
    const given = await this.membershipFor(this.settings.org!);
    if (named && given && named.id === given.id) return;
    throw this.otherOrg(url);
  }

  /** The org reference this invocation builds paths with; auto-picks a sole org. */
  async orgSlug(): Promise<string> {
    const ref = await this.actingRef();
    this.orgHandedOut = true;
    return ref;
  }

  private async actingRef(): Promise<string> {
    if (this.orgOverride) {
      if (this.orgOverrideChecked !== this.orgOverride) {
        await this.refuseOtherOrg(this.orgOverride);
        this.orgOverrideChecked = this.orgOverride;
      }
      return this.orgOverride;
    }
    if (this.settings.org) return this.settings.org;
    const doc = await this.authorization();
    if (doc.organizations.length === 1) return doc.organizations[0].slug;
    if (doc.organizations.length === 0) {
      throw new CliError(
        "not_found",
        "This account belongs to no organization",
        "Create one in the Thicket app first",
      );
    }
    throw new CliError(
      "ambiguous",
      `You belong to ${doc.organizations.length} organizations: ${doc.organizations
        .map((o) => o.slug)
        .join(", ")}`,
      "Pass --org <slug>, or set a default: thicket orgs use <slug>",
    );
  }

  /**
   * The caller's row for an org reference (a slug, an old slug, the bare
   * key): findOrgByRef over /authorization, then the server's own resolver,
   * which also knows a pre-July workspace's slug from before its rename.
   * Undefined when it names no workspace of the caller's.
   */
  async membershipFor(ref: string): Promise<AuthorizationOrg | undefined> {
    const doc = await this.authorization();
    const listed = findOrgByRef(doc.organizations, ref);
    if (listed) return listed;
    let account: { id: string };
    try {
      account = await (await this.sdk()).org(ref).request<{ id: string }>("GET", "/account");
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    return doc.organizations.find((o) => o.id === account.id);
  }

  async org(): Promise<OrgScope> {
    const sdk = await this.sdk();
    return sdk.org(await this.orgSlug());
  }

  /** The caller's row for the acting org: membership id, role, kind. */
  async whoami(): Promise<AuthorizationOrg> {
    const slug = await this.orgSlug();
    const org = await this.membershipFor(slug);
    if (!org?.membership_id) {
      throw new CliError("not_found", `You are not a member of "${slug}"`);
    }
    return org;
  }

  /** The caller's membership id inside the acting org (`me`). */
  async myMembershipId(): Promise<string> {
    return (await this.whoami()).membership_id;
  }

  /** GET /people for the acting org, cached for the invocation. */
  async people(): Promise<Person[]> {
    if (this.peopleCache) return this.peopleCache;
    const org = await this.org();
    this.peopleCache = await org.request<Person[]>("GET", "/people");
    return this.peopleCache;
  }

  /**
   * Raw authenticated fetch against the API host, for the few paths the
   * JSON transport doesn't fit (downloads, multipart uploads).
   */
  async rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const creds = await this.credentials();
    if (!creds) {
      throw new CliError("auth", "Not signed in", "Run: thicket auth login");
    }
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${creds.token}`);
    headers.set("user-agent", userAgent());
    const response = await doFetch(`${this.settings.baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "follow",
    });
    return response;
  }
}

/** Narrows unknown request errors for command-level handling. */
export function isNotFound(err: unknown): boolean {
  return err instanceof ThicketError && err.code === "not_found";
}
