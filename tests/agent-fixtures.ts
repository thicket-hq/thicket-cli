// Shared fixtures for the named-agent tests: a private config dir, a stored
// agent credential, and a fake transport that answers as Thicket would for
// the agent (and, by bearer, for a person's own profile).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeToken } from "../src/lib/keyring.js";
import type { AgentCredential } from "../src/lib/oauth.js";

export const host = "http://localhost:9999";
export const AGENT = "aaaaaaaa-0000-4000-8000-000000000001";
export const JASON = "aaaaaaaa-0000-4000-8000-0000000000a1";
export const JANE = "aaaaaaaa-0000-4000-8000-0000000000a2";
export const SAM = "aaaaaaaa-0000-4000-8000-0000000000a3";
export const CLIENT = "aaaaaaaa-0000-4000-8000-0000000000c1";
export const OTHER_AGENT = "aaaaaaaa-0000-4000-8000-0000000000b1";
export const STRANGER = "aaaaaaaa-0000-4000-8000-0000000000ff";
export const P1 = "bbbbbbbb-0000-4000-8000-000000000001";
export const P2 = "bbbbbbbb-0000-4000-8000-000000000002";
export const P3 = "bbbbbbbb-0000-4000-8000-000000000003";

export const agentToken = { access_token: "thicket_agt_test_access", token_type: "bearer", expires_in: 900, scope: "thicket.read thicket.write" };
export const agentCredential = (expiresAt = Date.now() + 900_000, scope = agentToken.scope): AgentCredential => ({
  kind: "agent", token: agentToken.access_token, clientId: "thicket_agent_test_client", clientSecret: "private-client-secret",
  expiresAt, baseUrl: host, scope,
});
export const agentAuth = (scope: "full" | "read" = "full") => ({
  identity: { id: "agent-user" }, scope, expires_at: null,
  organizations: [{ id: "org", slug: "acme", name: "Acme", href: `${host}/api/v1/acme`, membership_id: AGENT, membership_kind: "agent", role: "member" }],
});
export const personAuth = (membership: string) => ({
  identity: { id: `user-${membership}` }, scope: "full", expires_at: null,
  organizations: [{ id: "org", slug: "acme", name: "Acme", href: `${host}/api/v1/acme`, membership_id: membership, membership_kind: "person", role: "member" }],
});

export const PEOPLE: Record<string, Record<string, unknown>> = {
  [JASON]: { membership_id: JASON, name: "Jason Hanschell", role: "owner", kind: "person" },
  [JANE]: { membership_id: JANE, name: "Jane Doe", role: "member", kind: "person" },
  [SAM]: { membership_id: SAM, name: "Sam Lee", role: "member", kind: "person" },
  [CLIENT]: { membership_id: CLIENT, name: "Clara Client", role: "client", kind: "person" },
  [OTHER_AGENT]: { membership_id: OTHER_AGENT, name: "Scout", role: "member", kind: "agent", boss: null },
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const apiError = (status: number, code: string, message = code) => json({ error: { code, message } }, status);

const dirs: string[] = [];
export function cleanup() { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); }

export function environment(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "thicket-agent-")); dirs.push(dir);
  return { THICKET_CONFIG_DIR: dir, THICKET_TOKEN_STORE: "file", THICKET_BASE_URL: host };
}

export async function connectedAgent(env: NodeJS.ProcessEnv, profile = "helper", scope?: string) {
  await storeToken(profile, JSON.stringify(agentCredential(undefined, scope)), env);
}

export type Call = { method: string; path: string; search: string; body: Record<string, unknown>; bearer: string | null };
export type Route = (call: Call) => Response | Promise<Response> | undefined;

/** The agent's view of Thicket: its own person (personal, with a boss, or shared), the people it shares projects with, its projects. */
export function agentThicket(options: { boss?: { membership_id: string; name: string } | null; projects?: { id: string; name: string }[]; scope?: "full" | "read"; routes?: Route[] } = {}) {
  const calls: Call[] = [];
  const projects = options.projects ?? [{ id: P1, name: "Website" }, { id: P2, name: "Mobile" }];
  const boss = options.boss === undefined ? { membership_id: JASON, name: "Jason Hanschell" } : options.boss;
  const transport = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const bearer = new Headers(init?.headers).get("authorization");
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : {}, bearer };
    calls.push(call);
    for (const route of options.routes ?? []) {
      const answer = await route(call);
      if (answer) return answer;
    }
    if (call.path === "/api/oauth/token") return json(agentToken);
    if (call.path === "/api/v1/authorization") {
      if (bearer === `Bearer ${agentToken.access_token}`) return json(agentAuth(options.scope));
      const member = bearer?.replace("Bearer thicket_pat_", "");
      if (member && PEOPLE[member]) return json(personAuth(member));
      return apiError(401, "unauthorized");
    }
    if (call.path === `/api/v1/acme/people/${AGENT}`) return json({ membership_id: AGENT, name: "Helper", role: "member", kind: "agent", boss });
    const person = call.path.match(/^\/api\/v1\/acme\/people\/([0-9a-f-]+)$/);
    if (person) return PEOPLE[person[1]] ? json(PEOPLE[person[1]]) : apiError(404, "not_found", "Not found");
    if (call.path === "/api/v1/acme/projects") return json(projects);
    if (call.path === "/api/v1/acme/my/agent/session") return json({});
    return apiError(404, "not_found", `no route ${call.method} ${call.path}`);
  }) as typeof fetch;
  return { transport, calls };
}

export function capture() {
  const out: string[] = []; const err: string[] = [];
  return { out, err, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s),
    envelope: () => JSON.parse(out.join("\n")), error: () => JSON.parse(err.join("\n")) };
}
