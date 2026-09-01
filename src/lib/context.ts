// The per-invocation context every command receives: resolved settings,
// the SDK client (lazy — commands that never touch the API work without a
// token), and org resolution with a single-org auto-pick.
import { createRequire } from "node:module";
import { Thicket, ThicketError, type OrgScope } from "thicket-sdk";
import { resolveSettings, type ResolvedSettings } from "./config.js";
import { getStoredToken, type TokenStore } from "./keyring.js";
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
  slug: string;
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
  private env: NodeJS.ProcessEnv;
  private fetchImpl?: typeof globalThis.fetch;
  private sdkInstance: Thicket | null = null;
  private tokenInfo: { token: string; store: TokenStore } | null | undefined;
  private authDoc: AuthorizationDoc | null = null;
  private orgOverride: string | null = null;
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
    if (this.tokenInfo !== undefined) return this.tokenInfo;
    const envToken = this.env.THICKET_TOKEN?.trim();
    this.tokenInfo = envToken
      ? { token: envToken, store: "env" }
      : await getStoredToken(this.settings.profile);
    return this.tokenInfo;
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
      token: creds.token,
      userAgent: userAgent(),
      baseUrl: this.settings.baseUrl,
      fetch: this.fetchImpl,
    });
    return this.sdkInstance;
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
   * was passed explicitly and disagrees (then the flag is the user's word).
   */
  adoptOrg(slug: string): void {
    if (this.settings.sources.org === "flag" && this.settings.org !== slug) {
      throw new CliError(
        "usage",
        `That URL belongs to "${slug}" but --org says "${this.settings.org}"`,
        "Drop --org, or pass the matching one",
      );
    }
    this.orgOverride = slug;
  }

  /** The org slug this invocation acts in; auto-picks a sole org. */
  async orgSlug(): Promise<string> {
    if (this.orgOverride) return this.orgOverride;
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

  async org(): Promise<OrgScope> {
    const sdk = await this.sdk();
    return sdk.org(await this.orgSlug());
  }

  /** The caller's row for the acting org: membership id, role, kind. */
  async whoami(): Promise<AuthorizationOrg> {
    const slug = await this.orgSlug();
    const doc = await this.authorization();
    const org = doc.organizations.find((o) => o.slug === slug);
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
