// Auth & identity: the browser hand-off login (no password ever touches the
// CLI), token storage, status, and org selection.
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import pc from "picocolors";
import { openBrowser } from "../lib/browser.js";
import { updateProfile } from "../lib/config.js";
import { userAgent, VERSION, type CliContext } from "../lib/context.js";
import {
  deleteStoredToken,
  getStoredToken,
  storeToken,
} from "../lib/keyring.js";
import { startLoopback } from "../lib/loopback.js";
import { CliError, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";

const CATEGORY = "Auth & Config";

async function exchangeCode(
  baseUrl: string,
  code: string,
  verifier: string,
): Promise<{ token: string; scope: string; name: string }> {
  const response = await fetch(`${baseUrl}/api/v1/cli/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": userAgent(),
    },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  const body = (await response.json().catch(() => null)) as {
    token?: string;
    scope?: string;
    name?: string;
    error?: { message?: string };
  } | null;
  if (!response.ok || !body?.token) {
    throw new CliError(
      "auth",
      body?.error?.message ?? `Token exchange failed (HTTP ${response.status})`,
      "Run: thicket auth login again",
    );
  }
  return { token: body.token, scope: body.scope ?? "read", name: body.name ?? "" };
}

async function readTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(
      "usage",
      "--with-token reads the token from stdin",
      "Pipe it in: printf '%s' \"$TOKEN\" | thicket auth login --with-token",
    );
  }
  const lines: string[] = [];
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) lines.push(line);
  const token = lines.join("").trim();
  if (!token) throw new CliError("usage", "No token arrived on stdin");
  return token;
}

async function login(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const scope = options.scope === "full" ? "full" : "read";
  const { baseUrl, profile } = ctx.settings;

  let token: string;
  if (options.withToken) {
    token = await readTokenFromStdin();
  } else {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");
    const { port, result } = await startLoopback(state);
    const authorizeUrl =
      `${baseUrl}/cli/authorize?` +
      new URLSearchParams({
        challenge,
        port: String(port),
        state,
        scope,
        device: hostname(),
      }).toString();
    const opened = await openBrowser(authorizeUrl);
    process.stderr.write(
      (opened
        ? "Waiting for approval in your browser. If nothing opened, visit:\n"
        : "Open this URL in your browser to approve the sign-in:\n") +
        `  ${authorizeUrl}\n`,
    );
    const { code } = await result;
    const exchanged = await exchangeCode(baseUrl, code, verifier);
    token = exchanged.token;
  }

  // Validate before storing: a bad paste should fail loudly here, not later.
  const probe = await fetch(`${baseUrl}/api/v1/authorization`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": userAgent() },
  });
  if (!probe.ok) {
    throw new CliError(
      "auth",
      `The token did not authenticate (HTTP ${probe.status})`,
    );
  }
  const doc = (await probe.json()) as {
    organizations: { slug: string; name: string }[];
    scope: string;
  };

  const store = await storeToken(profile, token);
  if (ctx.settings.baseUrl !== "https://www.thickethq.com") {
    updateProfile(profile, { base_url: ctx.settings.baseUrl });
  }
  const orgs = doc.organizations;
  if (orgs.length === 1) {
    updateProfile(profile, { org: orgs[0].slug });
  }
  const storeLabel =
    store === "keychain"
      ? "the macOS Keychain"
      : store === "secret-service"
        ? "the system keyring"
        : "~/.config/thicket/credentials.json";
  return {
    data: {
      profile,
      scope: doc.scope,
      token_store: store,
      organizations: orgs,
    },
    summary: `Signed in (${doc.scope} scope). Token stored in ${storeLabel}.`,
    human: [
      `${pc.green("Signed in.")} Scope: ${doc.scope}. Token stored in ${storeLabel}.`,
      orgs.length === 1
        ? `Organization: ${orgs[0].name} (${orgs[0].slug})`
        : `You can reach ${orgs.length} organizations: ${orgs.map((o) => o.slug).join(", ")}`,
    ],
    breadcrumbs: [
      { action: "status", cmd: "thicket auth status", description: "Verify the sign-in" },
      { action: "projects", cmd: "thicket projects", description: "List your projects" },
      ...(orgs.length > 1
        ? [{ action: "org", cmd: "thicket orgs use <slug>", description: "Pick a default organization" }]
        : []),
    ],
  };
}

async function logout(ctx: CliContext): Promise<CommandResult> {
  const { profile, baseUrl } = ctx.settings;
  const had = await getStoredToken(profile);
  await deleteStoredToken(profile);
  return {
    data: { profile, removed: !!had },
    summary: had
      ? `Signed out: the stored token for profile "${profile}" was removed from this machine.`
      : `Nothing stored for profile "${profile}".`,
    notice: had
      ? `The token itself stays valid until revoked: ${baseUrl} → My settings → API tokens`
      : undefined,
    human: [
      had
        ? `${pc.green("Signed out.")} Removed the stored token for profile "${profile}".`
        : `Nothing stored for profile "${profile}".`,
    ],
  };
}

async function status(ctx: CliContext): Promise<CommandResult> {
  const creds = await ctx.credentials();
  const { profile, org, baseUrl, sources } = ctx.settings;
  if (!creds) {
    throw new CliError(
      "auth",
      `Not signed in (profile "${profile}")`,
      "Run: thicket auth login",
    );
  }
  const doc = await ctx.authorization();
  const data = {
    profile,
    token_store: creds.store,
    base_url: baseUrl,
    scope: doc.scope,
    expires_at: doc.expires_at,
    identity: doc.identity,
    org: org ?? null,
    org_source: sources.org ?? null,
    organizations: doc.organizations,
  };
  return {
    data,
    summary: `Signed in (${doc.scope} scope), ${doc.organizations.length} organization${doc.organizations.length === 1 ? "" : "s"}`,
    human: [
      `${pc.green("Signed in.")}`,
      `  Profile:  ${profile} (token from ${creds.store})`,
      `  Host:     ${baseUrl}`,
      `  Scope:    ${doc.scope}${doc.expires_at ? `, expires ${doc.expires_at}` : ""}`,
      `  Acting org: ${org ?? (doc.organizations.length === 1 ? doc.organizations[0].slug : pc.yellow("none set; pass --org or run: thicket orgs use <slug>"))}`,
      "",
      ...table(
        ["ORGANIZATION", "SLUG", "ROLE"],
        doc.organizations.map((o) => [o.name, o.slug, o.role]),
      ),
    ],
  };
}

async function printToken(ctx: CliContext): Promise<CommandResult> {
  const creds = await ctx.credentials();
  if (!creds) {
    throw new CliError("auth", "Not signed in", "Run: thicket auth login");
  }
  return {
    data: { token: creds.token },
    human: [creds.token],
    ids: [creds.token],
  };
}

async function orgsList(ctx: CliContext): Promise<CommandResult> {
  const doc = await ctx.authorization();
  const rows = doc.organizations;
  return {
    data: rows,
    summary: `${rows.length} organization${rows.length === 1 ? "" : "s"}`,
    human: table(
      ["NAME", "SLUG", "ROLE"],
      rows.map((o) => [o.name, o.slug, o.role]),
    ),
    ids: rows.map((o) => o.slug),
    breadcrumbs: [
      { action: "use", cmd: "thicket orgs use <slug>", description: "Set the default organization" },
      { action: "projects", cmd: "thicket projects --org <slug>", description: "List an organization's projects" },
    ],
  };
}

async function orgsUse(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const slug = args[0];
  const doc = await ctx.authorization();
  const org = doc.organizations.find((o) => o.slug === slug);
  if (!org) {
    throw new CliError(
      "not_found",
      `You do not belong to an organization with slug "${slug}"`,
      `Yours: ${doc.organizations.map((o) => o.slug).join(", ")}`,
    );
  }
  updateProfile(ctx.settings.profile, { org: slug });
  return {
    data: { profile: ctx.settings.profile, org: slug },
    summary: `Default organization for profile "${ctx.settings.profile}" is now ${org.name} (${slug}).`,
    human: [`${pc.green("Saved.")} Commands now act in ${org.name} (${slug}).`],
  };
}

async function me(ctx: CliContext): Promise<CommandResult> {
  const doc = await ctx.authorization();
  return {
    data: doc,
    summary: `Authenticated with ${doc.scope} scope; ${doc.organizations.length} organization${doc.organizations.length === 1 ? "" : "s"}`,
    human: [
      `Identity: ${doc.identity.id}`,
      `Scope: ${doc.scope}${doc.expires_at ? ` (expires ${doc.expires_at})` : ""}`,
      ...doc.organizations.map(
        (o) => `  ${o.name} (${o.slug}) as ${o.role}, membership ${o.membership_id}`,
      ),
    ],
    breadcrumbs: [
      { action: "assignments", cmd: "thicket assignments", description: "Your open work" },
    ],
  };
}

async function doctor(ctx: CliContext): Promise<CommandResult> {
  const checks: { check: string; ok: boolean; detail: string }[] = [];
  const push = (check: string, ok: boolean, detail: string) =>
    checks.push({ check, ok, detail });

  const [major] = process.versions.node.split(".").map(Number);
  push("node", major >= 18, `v${process.versions.node} (needs 18.17+)`);
  push("cli", true, `thicket-cli ${VERSION}`);
  push("host", true, ctx.settings.baseUrl);

  const creds = await ctx.credentials();
  push(
    "token",
    !!creds,
    creds ? `present (from ${creds.store})` : "missing; run: thicket auth login",
  );
  if (creds) {
    try {
      const doc = await ctx.authorization();
      push("api", true, `authenticated, scope ${doc.scope}`);
      const orgCount = doc.organizations.length;
      const acting =
        ctx.settings.org ??
        (orgCount === 1 ? doc.organizations[0].slug : null);
      push(
        "org",
        !!acting || orgCount === 0,
        acting
          ? `acting in ${acting}`
          : `no default among ${orgCount} orgs; run: thicket orgs use <slug>`,
      );
    } catch (err) {
      push("api", false, err instanceof Error ? err.message : String(err));
    }
  }
  const healthy = checks.every((c) => c.ok);
  return {
    data: { healthy, checks },
    summary: healthy ? "All checks passed" : "Some checks failed",
    human: checks.map(
      (c) => `${c.ok ? pc.green("ok ") : pc.red("FAIL")} ${c.check.padEnd(6)} ${c.detail}`,
    ),
  };
}

const loginSpec: Omit<CommandSpec, "path"> = {
  category: CATEGORY,
  summary: "Sign in through your browser (mints a personal access token)",
  description:
    "Opens the Thicket app to approve this device; no password ever touches the CLI. The minted token lands in the OS keyring (credentials file fallback). Use --with-token to paste an existing token from stdin instead.",
  flags: [
    { flag: "--scope <scope>", description: "Token scope: read (default) or full", default: "read" },
    { flag: "--with-token", description: "Read a personal access token from stdin instead of the browser flow" },
  ],
  notes: [
    "read scope can only GET; pass --scope full for a CLI that writes",
    "Revoke tokens any time from My settings, API tokens",
  ],
  handler: login,
};

export const authCommands: CommandSpec[] = [
  { path: ["auth", "login"], ...loginSpec },
  { path: ["login"], ...loginSpec, summary: "Alias of auth login" },
  {
    path: ["auth", "logout"],
    category: CATEGORY,
    summary: "Remove the stored token from this machine",
    notes: ["The token itself stays valid until revoked in My settings, API tokens"],
    handler: logout,
  },
  {
    path: ["logout"],
    category: CATEGORY,
    summary: "Alias of auth logout",
    handler: logout,
  },
  {
    path: ["auth", "status"],
    category: CATEGORY,
    summary: "Show who you are signed in as, and from where",
    handler: status,
  },
  {
    path: ["auth", "token"],
    category: CATEGORY,
    summary: "Print the stored token for scripts",
    notes: ["Prints the secret to stdout; pipe with care"],
    handler: printToken,
  },
  {
    path: ["orgs"],
    category: CATEGORY,
    summary: "List the organizations you can reach",
    handler: orgsList,
  },
  {
    path: ["orgs", "list"],
    category: CATEGORY,
    summary: "List the organizations you can reach",
    handler: orgsList,
  },
  {
    path: ["orgs", "use"],
    category: CATEGORY,
    summary: "Save a default organization for this profile",
    args: [{ name: "slug", description: "Organization slug", required: true }],
    handler: orgsUse,
  },
  {
    path: ["me"],
    category: CATEGORY,
    summary: "Introspect the credential: identity, orgs, scope",
    notes: ["membership_id per org is who you are inside it (assignees speak membership ids)"],
    handler: me,
  },
  {
    path: ["doctor"],
    category: CATEGORY,
    summary: "Check CLI health: node, token, API reachability, org",
    handler: doctor,
  },
];
