import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliContext } from "../src/lib/context.js";
import { storeToken, getStoredToken } from "../src/lib/keyring.js";
import { credentialsPath } from "../src/lib/config.js";
import { connectionCredentials, oauthBaseUrl, parseOAuthCredential, type OAuthCredential } from "../src/lib/oauth.js";
import { run } from "../src/cli.js";

const browser = vi.hoisted(() => ({ urls: [] as string[], closes: 0 }));
vi.mock("../src/lib/browser.js", () => ({ openBrowser: async (url: string) => { browser.urls.push(url); return true; } }));
vi.mock("../src/lib/loopback.js", () => ({ startLoopback: async () => ({ port: 49152, result: Promise.resolve({ code: "test-code" }), close: () => { browser.closes++; } }) }));

const dirs: string[] = [];
function environment() {
  const dir = mkdtempSync(join(tmpdir(), "thicket-oauth-")); dirs.push(dir);
  return { THICKET_CONFIG_DIR: dir, THICKET_TOKEN_STORE: "file", THICKET_BASE_URL: "http://localhost:9999" };
}
const credential = (expiresAt = Date.now() + 3600_000): OAuthCredential => ({
  kind: "oauth", token: "thicket_aat_test_access", refreshToken: "thicket_art_test_refresh", expiresAt,
  baseUrl: "http://localhost:9999", clientId: "thicket-cli", scope: "thicket.read thicket.write offline_access",
});
const tokenBody = { access_token: "thicket_aat_refreshed", refresh_token: "thicket_art_rotated", expires_in: 3600, token_type: "bearer", scope: "thicket.read thicket.write offline_access" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); browser.urls.length = 0; browser.closes = 0; vi.restoreAllMocks(); });

describe("OAuth credential lifecycle", () => {
  it("refreshes only once for concurrent contexts and persists the rotated pair privately", async () => {
    const env = environment();
    await storeToken("default", JSON.stringify(credential(0)), env);
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("resource")).toBe("http://localhost:9999/api/v1");
      expect(init?.redirect).toBe("error");
      await new Promise(resolve => setTimeout(resolve, 20));
      return json(tokenBody);
    }) as unknown as typeof fetch;
    const contexts = Array.from({ length: 5 }, () => new CliContext({}, env, transport));
    const results = await Promise.all(contexts.map(c => c.credentials()));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(results.every(c => c?.token === tokenBody.access_token)).toBe(true);
    const saved = parseOAuthCredential((await getStoredToken("default", env))!.token);
    expect(saved?.refreshToken).toBe(tokenBody.refresh_token);
    expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
    expect(readFileSync(credentialsPath(env), "utf8")).not.toContain("test_refresh");
  });

  it("refreshes during a long-running context and passes a fresh token to the SDK", async () => {
    const env = environment();
    await storeToken("default", JSON.stringify(credential()), env);
    const seen: string[] = [];
    const transport = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/oauth/token")) return json(tokenBody);
      seen.push(new Headers(init?.headers).get("authorization")!); return json([]);
    }) as unknown as typeof fetch;
    const ctx = new CliContext({}, env, transport);
    const sdk = await ctx.sdk();
    await sdk.client.request("GET", "/api/v1/orgs");
    await storeToken("default", JSON.stringify(credential(0)), env);
    await sdk.client.request("GET", "/api/v1/orgs");
    expect(seen).toEqual(["Bearer thicket_aat_test_access", "Bearer thicket_aat_refreshed"]);
  });

  it("never sends saved OAuth credentials to another host, and preserves personal tokens", async () => {
    const env = environment(); const transport = vi.fn();
    await storeToken("default", JSON.stringify(credential(0)), env);
    await expect(connectionCredentials("default", "https://different.example", env, "test", transport)).rejects.toThrow("different Thicket host");
    expect(transport).not.toHaveBeenCalled();
    await storeToken("default", "thicket_pat_legacy", env);
    expect(await new CliContext({}, env, transport).credentials()).toEqual({ token: "thicket_pat_legacy", store: "file" });
    expect(oauthBaseUrl("http://127.0.0.1:3003")).toBe("http://127.0.0.1:3003");
    expect(() => oauthBaseUrl("http://public.example")).toThrow();
  });

  it("keeps credentials on a failed refresh and never falls back to a PAT flow", async () => {
    const env = environment(); const original = JSON.stringify(credential(0));
    await storeToken("default", original, env);
    const transport = vi.fn(async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch;
    await expect(new CliContext({}, env, transport).credentials()).rejects.toThrow("HTTP 400");
    expect((await getStoredToken("default", env))?.token).toBe(original);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("connects via PKCE browser approval and disconnects the grant on logout", async () => {
    const env = environment(); const calls: string[] = [];
    const transport = (async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname; calls.push(path);
      if (path === "/api/oauth/token") {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("code_verifier")?.length).toBe(43);
        expect(form.get("redirect_uri")).toBe("http://127.0.0.1:49152/callback");
        return json(tokenBody);
      }
      if (path === "/api/oauth/revoke") return new Response(null, { status: 200 });
      return json({ scope: "full", organizations: [{ slug: "acme", name: "Acme" }] });
    }) as typeof fetch;
    const out: string[] = []; const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const options = { env, fetch: transport, isTty: false, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) };
    expect(await run(["auth", "login"], options)).toBe(0);
    const url = new URL(browser.urls[0]);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("thicket-cli");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("thicket.write");
    expect(browser.closes).toBe(1);
    expect(out.join("\n")).not.toContain(tokenBody.refresh_token);
    expect(await run(["auth", "logout"], options)).toBe(0);
    expect(calls).toEqual(["/api/oauth/token", "/api/v1/authorization", "/api/oauth/revoke"]);
    expect(await getStoredToken("default", env)).toBeNull();
  });
});
