import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { CliContext } from "../src/lib/context.js";
import { getStoredToken, storeToken } from "../src/lib/keyring.js";
import { connectionCredentials, parseConnectionCredential, type AgentCredential } from "../src/lib/oauth.js";
import { listenAgent } from "../src/commands/connect.js";

vi.mock("../src/lib/browser.js", () => ({ openBrowser: async () => true }));
const dirs: string[] = [];
const host = "http://localhost:9999";
const requestId = "20000000-0000-4000-8000-000000000001";
const auth = { identity: { id: "agent-user" }, scope: "full", organizations: [{ id: "org", slug: "acme", name: "Acme", membership_id: "agent-member", membership_kind: "agent", role: "member" }] };
const token = { access_token: "thicket_agt_test_access", token_type: "bearer", expires_in: 900, scope: "thicket.read thicket.write" };
const credential = (expiresAt = Date.now() + 900_000): AgentCredential => ({ kind: "agent", token: token.access_token, clientId: "thicket_agent_test_client", clientSecret: "private-client-secret", expiresAt, baseUrl: host, scope: token.scope });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function environment() {
  const dir = mkdtempSync(join(tmpdir(), "thicket-agent-")); dirs.push(dir);
  return { THICKET_CONFIG_DIR: dir, THICKET_TOKEN_STORE: "file", THICKET_BASE_URL: host };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("named agent connections", () => {
  it("pairs through the registered command, verifies identity, stores secrets privately, and disconnects", async () => {
    const env = environment(); const out: string[] = []; const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const transport = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/oauth/agent-connections") {
        const b = JSON.parse(String(init?.body));
        return json(b.device_name ? { device_code: "device-secret", user_code: "CHECK-CODE", verification_uri_complete: `${host}/oauth/agent?code=CHECK-CODE`, expires_in: 600 } : { client_id: credential().clientId, client_secret: credential().clientSecret });
      }
      if (path === "/api/oauth/token") {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("client_credentials");
        expect(form.get("client_secret")).toBe(credential().clientSecret);
        expect(init?.redirect).toBe("error"); return json(token);
      }
      if (path === "/api/oauth/revoke") {
        expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe(credential().clientSecret);
        return new Response(null, { status: 200 });
      }
      if (path === "/api/v1/authorization") return json(auth);
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    const options = { env, fetch: transport, isTty: false, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) };
    expect(await run(["auth", "agent", "connect", "--profile", "helper", "--no-browser"], options)).toBe(0);
    expect(parseConnectionCredential((await getStoredToken("helper", env))!.token)?.kind).toBe("agent");
    expect(out.join("")).not.toContain(credential().clientSecret);
    expect(await run(["auth", "login", "--profile", "helper"], options)).not.toBe(0);
    expect(parseConnectionCredential((await getStoredToken("helper", env))!.token)?.kind).toBe("agent");
    expect(await run(["auth", "agent", "connect", "--profile", "helper"], options)).not.toBe(0);
    expect(await run(["auth", "logout", "--profile", "helper"], options)).toBe(0);
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

  it("claims one request, emits its exact reply target, and releases the lease on shutdown", async () => {
    const env = environment(); await storeToken("helper", JSON.stringify(credential()), env);
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const transport = (async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path: url.pathname + url.search, body });
      if (url.pathname.endsWith("/authorization")) return json(auth);
      if (url.pathname.endsWith("/session")) return json({});
      if (url.pathname.endsWith(`/inbox/${requestId}`)) return json({ id: requestId, runtime_id: body.runtime_id, source: { id: "comment" }, reply_to: { kind: "comment", recording_id: "todo" } });
      return json({ items: url.search ? [] : [{ id: requestId }] });
    }) as typeof fetch;
    const abort = new AbortController(); const output: Record<string, unknown>[] = [];
    await listenAgent(new CliContext({ profile: "helper" }, env, transport), abort.signal, async row => { output.push(row); }, async () => { abort.abort(); });
    expect(output.map(r => r.type)).toEqual(["connected", "request"]);
    expect(output[1]).toMatchObject({ id: requestId, profile: "helper", reply_to: { recording_id: "todo" } });
    expect(calls.at(-1)?.body.stop).toBe(true);
    expect(calls.filter(c => c.body.status === "claim")).toHaveLength(1);
  });

  it("does not claim more work while a request is running, and never accepts a personal or environment token", async () => {
    const env = environment(); await storeToken("helper", JSON.stringify(credential()), env);
    const transport = vi.fn(async (input: unknown) => String(input).endsWith("/authorization") ? json(auth) : String(input).includes("status=running") ? json({ items: [{ id: requestId }] }) : json({}));
    const abort = new AbortController();
    await listenAgent(new CliContext({ profile: "helper" }, env, transport), abort.signal, async () => {}, async () => { abort.abort(); });
    expect(transport.mock.calls.some(([u]) => String(u).endsWith("/inbox"))).toBe(false);
    const options = { env: { ...env, THICKET_TOKEN: "personal-token" }, fetch: transport, isTty: false, write: () => {}, writeErr: () => {} };
    expect(await run(["connect", "status", "--profile", "helper"], options)).not.toBe(0);
    expect(await run(["auth", "agent", "connect"], { ...options, env })).not.toBe(0);
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
