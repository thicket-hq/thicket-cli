import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { getStoredToken, storeToken } from "../src/lib/keyring.js";
import { connectionCredentials, parseConnectionCredential, type AgentCredential } from "../src/lib/oauth.js";

vi.mock("../src/lib/browser.js", () => ({ openBrowser: async () => true }));
const dirs: string[] = [];
const host = "http://localhost:9999";
const requestId = "20000000-0000-4000-8000-000000000001";
const auth = { identity: { id: "agent-user" }, scope: "full", organizations: [{ id: "org", slug: "acme", name: "Acme", membership_id: "agent-member", membership_kind: "agent", role: "member" }] };
const token = { access_token: "thicket_agt_test_access", token_type: "bearer", expires_in: 900, scope: "thicket.read thicket.write" };
const credential = (expiresAt = Date.now() + 900_000): AgentCredential => ({ kind: "agent", token: token.access_token, clientId: "thicket_agent_test_client", clientSecret: "private-client-secret", expiresAt, baseUrl: host, scope: token.scope });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function environment() {
  const dir = mkdtempSync(join(tmpdir(), "thicket-agent-")); dirs.push(dir);
  return { THICKET_CONFIG_DIR: dir, THICKET_TOKEN_STORE: "file", THICKET_BASE_URL: host };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** The pairing exchange: start, then collection of the approved client, then its tokens. */
function pairing(scope = token.scope, revoke: () => Response = () => new Response(null, { status: 200 })) {
  return (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/oauth/agent-connections") {
      const b = JSON.parse(String(init?.body));
      return json(b.device_name ? { device_code: "device-secret", user_code: "CHECK-CODE", verification_uri_complete: `${host}/oauth/agent?code=CHECK-CODE`, expires_in: 600 } : { client_id: credential().clientId, client_secret: credential().clientSecret });
    }
    if (path === "/api/oauth/token") {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("client_credentials");
      expect(form.get("client_secret")).toBe(credential().clientSecret);
      expect(init?.redirect).toBe("error"); return json({ ...token, scope });
    }
    if (path === "/api/oauth/revoke") {
      expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe(credential().clientSecret);
      return revoke();
    }
    if (path === "/api/v1/authorization") return json({ ...auth, scope: scope.includes("thicket.write") ? "full" : "read" });
    if (path === "/api/v1/acme/people/agent-member") return json({ membership_id: "agent-member", name: "Helper", kind: "agent", role: "member", boss: { membership_id: "jason-member", name: "Jason Hanschell" } });
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch;
}

describe("named agent connections", () => {
  it("pairs through the registered command, verifies identity, stores secrets privately, points at setup, and disconnects", async () => {
    const env = environment(); const out: string[] = []; const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const options = { env, fetch: pairing(), isTty: false, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) };
    expect(await run(["auth", "agent", "connect", "--profile", "helper", "--no-browser", "--json"], options)).toBe(0);
    const envelope = JSON.parse(out.splice(0).join("\n"));
    expect(envelope.data).toMatchObject({ profile: "helper", authentication: "agent", scope: "thicket.read thicket.write", access: "full", organization: { slug: "acme" } });
    expect(envelope.summary).toContain("thicket connect setup --profile helper");
    expect(envelope.breadcrumbs.map((b: { cmd: string }) => b.cmd)).toContain("thicket connect setup --profile helper");
    const stored = parseConnectionCredential((await getStoredToken("helper", env))!.token);
    expect(stored).toMatchObject({ kind: "agent", scope: "thicket.read thicket.write" });
    expect(JSON.stringify(envelope)).not.toContain(credential().clientSecret);
    expect(await run(["auth", "login", "--profile", "helper"], options)).not.toBe(0);
    expect(parseConnectionCredential((await getStoredToken("helper", env))!.token)?.kind).toBe("agent");
    // Connecting again never overwrites the profile: the server would replace the connection.
    expect(await run(["auth", "agent", "connect", "--profile", "helper"], options)).not.toBe(0);
    expect(await run(["auth", "logout", "--profile", "helper"], options)).toBe(0);
    expect(await getStoredToken("helper", env)).toBeNull();
  });

  it("keeps a read-only connection's scope and says the connector needs Full access", async () => {
    const env = environment(); const out: string[] = [];
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await run(["auth", "agent", "connect", "--profile", "reader", "--no-browser", "--json"], { env, fetch: pairing("thicket.read"), isTty: false, write: (s) => out.push(s), writeErr: () => {} })).toBe(0);
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope.data).toMatchObject({ scope: "thicket.read", access: "read" });
    expect(envelope.summary).toContain("Read-only");
    expect(parseConnectionCredential((await getStoredToken("reader", env))!.token)).toMatchObject({ scope: "thicket.read" });
  });

  it("names the agent and its owner in thicket me", async () => {
    const env = environment(); await storeToken("helper", JSON.stringify(credential()), env);
    const out: string[] = [];
    expect(await run(["me", "--profile", "helper", "--json"], { env, fetch: pairing(), isTty: false, write: (s) => out.push(s), writeErr: () => {} })).toBe(0);
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope.data.agent).toEqual({ membership_id: "agent-member", name: "Helper", organization: "acme", agent_type: "personal", boss: { membership_id: "jason-member", name: "Jason Hanschell" } });
    expect(envelope.summary).toContain("Helper, a personal agent of Jason Hanschell");
  });

  it("logs out a connection Thicket already replaced, removing it from this computer", async () => {
    const env = environment(); await storeToken("helper", JSON.stringify(credential()), env);
    const out: string[] = [];
    const replaced = pairing(token.scope, () => json({ error: "invalid_client" }, 401));
    expect(await run(["auth", "logout", "--profile", "helper", "--json"], { env, fetch: replaced, isTty: false, write: (s) => out.push(s), writeErr: () => {} })).toBe(0);
    expect(JSON.parse(out.join("\n")).notice).toContain("already ended");
    expect(await getStoredToken("helper", env)).toBeNull();
  });

  it("renews client credentials once across processes and refuses a changed host", async () => {
    const env = environment(); await storeToken("helper", JSON.stringify(credential(0)), env);
    const transport = vi.fn(async () => { await new Promise(r => setTimeout(r, 10)); return json(token); }) as unknown as typeof fetch;
    const refresh = () => connectionCredentials("helper", host, env, "test", transport);
    await Promise.all([refresh(), refresh(), refresh()]);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(connectionCredentials("helper", "https://other.example", env, "test", transport)).rejects.toThrow("different Thicket host");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("never accepts a personal or environment token, or the default profile", async () => {
    const env = environment(); await storeToken("helper", JSON.stringify(credential()), env);
    const transport = vi.fn(async () => json(auth));
    const options = { env: { ...env, THICKET_TOKEN: "personal-token" }, fetch: transport, isTty: false, write: () => {}, writeErr: () => {} };
    for (const args of [["connect", "status", "--profile", "helper"], ["connect", "--profile", "helper"], ["connect", "setup", "--profile", "helper"]])
      expect(await run(args, options)).not.toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(await run(["auth", "agent", "connect"], { ...options, env })).not.toBe(0);
    expect(await run(["connect"], { ...options, env })).not.toBe(0);
    const person = environment(); await storeToken("helper", "thicket_pat_person", person);
    expect(await run(["connect", "--profile", "helper"], { ...options, env: person })).not.toBe(0);
  });

  it("settles through the registry with the same runtime and profile", async () => {
    const env = environment(); await storeToken("helper", JSON.stringify(credential()), env);
    const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/authorization")) return json(auth);
      expect(JSON.parse(String(init?.body))).toEqual({ runtime_id: requestId, status: "completed", result: "Replied" });
      return json({ id: requestId, status: "completed" });
    });
    expect(await run(["connect", "settle", requestId, "--profile", "helper", "--runtime", requestId, "--status", "completed", "--result", "Replied"], { env, fetch: transport, write: () => {}, writeErr: () => {} })).toBe(0);
  });
});
