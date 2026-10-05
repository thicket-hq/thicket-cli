import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { configDir } from "./config.js";
import { getStoredToken, storeToken, type TokenStore } from "./keyring.js";
import { CliError } from "./output.js";

export const CLI_CLIENT_ID = "thicket-cli";
const REFRESH_EARLY_MS = 60_000;

export type OAuthCredential = {
  kind: "oauth";
  token: string;
  refreshToken: string;
  expiresAt: number;
  baseUrl: string;
  clientId: string;
  scope: string;
};

/** Secrets only travel to the issuer approved by the user. */
export function oauthBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new CliError("usage", "Use an HTTPS Thicket host, or HTTP on loopback for local development");
  }
  return url.origin;
}

export function parseOAuthCredential(value: string): OAuthCredential | null {
  if (!value.startsWith("{")) return null; // Earlier CLI releases stored a PAT string.
  let c: Partial<OAuthCredential>;
  try { c = JSON.parse(value); } catch { throw new CliError("auth", "Stored connection is unreadable", "Run: thicket auth login"); }
  if (c?.kind !== "oauth" || typeof c.token !== "string" || !c.token ||
      typeof c.refreshToken !== "string" || !c.refreshToken ||
      typeof c.expiresAt !== "number" || !Number.isFinite(c.expiresAt) ||
      typeof c.baseUrl !== "string" || c.clientId !== CLI_CLIENT_ID || typeof c.scope !== "string") {
    throw new CliError("auth", "Stored connection is incomplete", "Run: thicket auth login");
  }
  return c as OAuthCredential;
}

export async function requestOAuthTokens(
  baseUrl: string,
  fields: Record<string, string>,
  userAgent: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OAuthCredential> {
  const origin = oauthBaseUrl(baseUrl);
  const response = await fetchImpl(`${origin}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent },
    body: new URLSearchParams({ ...fields, client_id: CLI_CLIENT_ID, resource: `${origin}/api/v1` }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    // Do not print an arbitrary server response: it could contain credentials.
    throw new CliError(response.status >= 500 || response.status === 429 ? "network" : "auth",
      `Thicket connection failed (HTTP ${response.status})`,
      body?.error === "invalid_grant" ? "Run: thicket auth login" : "Try again; if the connection was disconnected, run: thicket auth login");
  }
  if (typeof body?.access_token !== "string" || !body.access_token.startsWith("thicket_aat_") ||
      typeof body.refresh_token !== "string" || !body.refresh_token.startsWith("thicket_art_") ||
      typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0 ||
      typeof body.scope !== "string" || String(body.token_type).toLowerCase() !== "bearer") {
    throw new CliError("auth", "Thicket returned an invalid OAuth response", "Update the CLI and try signing in again");
  }
  return { kind: "oauth", token: body.access_token, refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000, baseUrl: origin, clientId: CLI_CLIENT_ID, scope: body.scope };
}

/** Serialize credential changes across processes, including the shared fallback file. */
export async function withCredentialLock<T>(env: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(dir, {
      lockfilePath: join(dir, "credentials.lock"),
      stale: 120_000,
      update: 5_000,
      retries: { retries: 100, minTimeout: 100, maxTimeout: 500 },
    });
  } catch {
    throw new CliError("auth", "Could not lock the credential store", "Wait for other Thicket commands to finish, then try again");
  }
  try { return await work(); } finally { await release(); }
}

export async function connectionCredentials(
  profile: string,
  baseUrl: string,
  env: NodeJS.ProcessEnv,
  userAgent: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ token: string; store: TokenStore } | null> {
  const stored = await getStoredToken(profile, env);
  if (!stored) return null;
  const connection = parseOAuthCredential(stored.token);
  if (!connection) return stored;
  const origin = oauthBaseUrl(baseUrl);
  if (connection.baseUrl !== origin) throw new CliError("auth", "This profile is connected to a different Thicket host", "Use a separate --profile and run: thicket auth login");
  if (connection.expiresAt > Date.now() + REFRESH_EARLY_MS) return { token: connection.token, store: stored.store };
  return withCredentialLock(env, async () => {
    // A competing process may have refreshed (or signed out) while we waited.
    const latest = await getStoredToken(profile, env);
    if (!latest) return null;
    const current = parseOAuthCredential(latest.token);
    if (!current) return latest;
    if (current.baseUrl !== origin) throw new CliError("auth", "The profile changed hosts while connecting", "Run: thicket auth status");
    if (current.expiresAt > Date.now() + REFRESH_EARLY_MS) return { token: current.token, store: latest.store };
    const refreshed = await requestOAuthTokens(origin, { grant_type: "refresh_token", refresh_token: current.refreshToken }, userAgent, fetchImpl);
    const store = await storeToken(profile, JSON.stringify(refreshed), env, latest.store);
    return { token: refreshed.token, store };
  });
}

export async function revokeOAuthConnection(connection: OAuthCredential, userAgent: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  const response = await fetchImpl(`${oauthBaseUrl(connection.baseUrl)}/api/oauth/revoke`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent },
    body: new URLSearchParams({ client_id: connection.clientId, token: connection.refreshToken, token_type_hint: "refresh_token" }),
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!response.ok) throw new CliError("auth", `Could not disconnect from Thicket (HTTP ${response.status})`, "Try again, or disconnect from My settings, Connected apps");
}
