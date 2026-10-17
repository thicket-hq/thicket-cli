// What thicket connect admits from the agent's inbox, decided on this
// computer: every trust rule, the agent caps, the dismiss reasons, several
// requests at once, the request line's shape, and the run's lifecycle.
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAgent } from "../src/commands/connect.js";
import {
  AGENT_CAPS, WakeLedger, admit, statePath, writeConnectSettings, type ConnectSettings, type InboxItem,
} from "../src/lib/agent-trust.js";
import { CliContext } from "../src/lib/context.js";
import {
  AGENT, CLIENT, JANE, JASON, OTHER_AGENT, P1, P2, P3, SAM, STRANGER, agentThicket, apiError, cleanup, connectedAgent, environment, host, json,
  type Call, type Route,
} from "./agent-fixtures.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CARD = "dddddddd-0000-4000-8000-0000000000ca";
const TODO = "dddddddd-0000-4000-8000-0000000000d0";
const LIST = "dddddddd-0000-4000-8000-0000000000d1";
const COMMENT = "dddddddd-0000-4000-8000-0000000000c0";
const CHAT = "dddddddd-0000-4000-8000-0000000000c4";
const DM = "dddddddd-0000-4000-8000-0000000000e0";
const DM_LINE = "dddddddd-0000-4000-8000-0000000000e1";

function settings(patch: Partial<ConnectSettings> = {}): ConnectSettings {
  return {
    version: 1, profile: "helper", base_url: host, organization: "acme", agent_membership_id: AGENT, agent_name: "Helper",
    agent_type: "personal", operator_id: JASON, operator_name: "Jason Hanschell", operator_from: "owner", owner_id: JASON,
    trust: "operator", allow: [], allow_assignments_from_authorized: false, allow_agents: [],
    agent_caps: { ...AGENT_CAPS }, serve: [{ id: P1, name: "Website" }, { id: P2, name: "Mobile" }], watch_completions: [],
    saved_at: "2026-10-17T00:00:00.000Z", ...patch,
  };
}

let seq = 0;
function item(patch: { reason?: string; from?: string; kind?: string; client?: boolean; project?: string | null; creator?: string; subject?: string; id?: string } = {}): InboxItem {
  const from = patch.from ?? JASON;
  const project = patch.project === undefined ? P1 : patch.project;
  return {
    id: patch.id ?? `eeeeeeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    reason: patch.reason ?? "mentioned",
    status: "pending",
    requester: { membership_id: from, name: from === JASON ? "Jason Hanschell" : "Someone", kind: patch.kind ?? "person", client: patch.client ?? false },
    requester_membership_id: from,
    source: { id: COMMENT, type: "comment", project_id: project, parent_id: patch.subject ?? CARD, title: null, content: "<p>please look</p>", creator_membership_id: patch.creator ?? from, updated_at: "2026-10-17T10:00:00.000Z" },
    subject: { id: patch.subject ?? CARD, type: "card", title: "Fix the date picker" },
    project: project ? { id: project, name: project === P1 ? "Website" : "Mobile" } : null,
    reply_to: { kind: "comment", recording_id: patch.subject ?? CARD },
    runtime_id: null, result: null, created_at: "2026-10-17T10:00:00.000Z",
  };
}

const ledger = (env = environment()) => WakeLedger.load(env, "helper", Date.now());

describe("admission", () => {
  it("the operator: role operator, acknowledged, owner only in their own words for a mention, assignment or direct message", () => {
    const l = ledger();
    expect(admit(item(), settings(), l, Date.now())).toEqual({ admit: true, role: "operator", owner: true, acknowledge: true });
    expect(admit(item({ reason: "assigned", creator: JANE }), settings(), l, Date.now())).toMatchObject({ admit: true, owner: false, acknowledge: true });
    expect(admit(item({ reason: "assigned" }), settings(), l, Date.now())).toMatchObject({ admit: true, owner: true });
    expect(admit(item({ reason: "pinged", project: null }), settings(), l, Date.now())).toMatchObject({ admit: true, role: "operator", owner: true, acknowledge: true });
    for (const reason of ["subscribed", "watched", "cheered"]) {
      expect(admit(item({ reason }), settings(), l, Date.now())).toEqual({ admit: true, role: "operator", owner: false, acknowledge: false });
    }
  });

  it("operator trust drops everyone else, and ignores an allowlist left in the file", () => {
    const l = ledger();
    expect(admit(item({ from: JANE }), settings(), l, Date.now())).toEqual({ admit: false, reason: "not_trusted" });
    expect(admit(item({ from: JANE }), settings({ allow: [{ membership_id: JANE, name: "Jane" }] }), l, Date.now())).toEqual({ admit: false, reason: "not_trusted" });
  });

  it("allowlist: named people are operators but never the owner; assignments only with the opt-in", () => {
    const l = ledger();
    const s = settings({ trust: "allowlist", allow: [{ membership_id: JANE, name: "Jane" }] });
    expect(admit(item({ from: JANE }), s, l, Date.now())).toEqual({ admit: true, role: "operator", owner: false, acknowledge: true });
    expect(admit(item({ from: SAM }), s, l, Date.now())).toEqual({ admit: false, reason: "not_trusted" });
    expect(admit(item({ from: JANE, reason: "assigned" }), s, l, Date.now())).toEqual({ admit: false, reason: "not_trusted" });
    expect(admit(item({ from: JANE, reason: "assigned" }), { ...s, allow_assignments_from_authorized: true }, l, Date.now())).toMatchObject({ admit: true, role: "operator", owner: false });
  });

  it("project trust: anyone plainly not a client is a participant, never by assignment; clients never", () => {
    const l = ledger();
    const s = settings({ trust: "project" });
    expect(admit(item({ from: SAM }), s, l, Date.now())).toEqual({ admit: true, role: "participant", owner: false, acknowledge: true });
    expect(admit(item({ from: SAM, reason: "subscribed" }), s, l, Date.now())).toMatchObject({ admit: true, role: "participant", acknowledge: false });
    expect(admit(item({ from: SAM, reason: "assigned" }), s, l, Date.now())).toEqual({ admit: false, reason: "not_trusted" });
    expect(admit(item({ from: CLIENT, client: true }), s, l, Date.now())).toEqual({ admit: false, reason: "client" });
    const unknown = item({ from: SAM }); delete unknown.requester!.client;
    expect(admit(unknown, s, l, Date.now())).toEqual({ admit: false, reason: "not_trusted" });
    expect(admit(item({ from: SAM, reason: "pinged", project: null }), s, l, Date.now())).toMatchObject({ admit: true, role: "participant" });
  });

  it("clients are dropped as clients in every mode, the operator's id included", () => {
    expect(admit(item({ client: true }), settings(), ledger(), Date.now())).toEqual({ admit: false, reason: "client" });
  });

  it("project-bound requests outside the served projects are dropped; direct messages are judged by trust alone", () => {
    const l = ledger();
    expect(admit(item({ project: P3 }), settings(), l, Date.now())).toEqual({ admit: false, reason: "not_served" });
    expect(admit(item({ project: null, reason: "pinged" }), settings({ serve: [] }), l, Date.now())).toMatchObject({ admit: true });
    expect(admit(item({ project: null, reason: "pinged", from: STRANGER }), settings({ serve: [] }), l, Date.now())).toEqual({ admit: false, reason: "not_trusted" });
  });

  it("completions only from watched projects, as context", () => {
    const l = ledger();
    expect(admit(item({ reason: "completed" }), settings(), l, Date.now())).toEqual({ admit: false, reason: "completions_off" });
    expect(admit(item({ reason: "completed", project: P3 }), settings(), l, Date.now())).toEqual({ admit: false, reason: "not_served" });
    expect(admit(item({ reason: "completed" }), settings({ watch_completions: [{ id: P1, name: "Website" }] }), l, Date.now()))
      .toEqual({ admit: true, role: "operator", owner: false, acknowledge: false });
  });

  it("another agent: only an allowed one, only by mention, as a participant, within the caps", () => {
    const env = environment();
    const l = ledger(env);
    const s = settings({ allow_agents: [{ membership_id: OTHER_AGENT, name: "Scout" }] });
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(admit(item({ from: OTHER_AGENT, kind: "agent" }), settings(), l, now)).toEqual({ admit: false, reason: "not_trusted" });
    expect(admit(item({ from: OTHER_AGENT, kind: "agent", reason: "assigned" }), s, l, now)).toEqual({ admit: false, reason: "not_trusted" });
    expect(admit(item({ from: OTHER_AGENT, kind: "agent", reason: "subscribed" }), s, l, now)).toEqual({ admit: false, reason: "not_trusted" });
    const ok = admit(item({ from: OTHER_AGENT, kind: "agent" }), s, l, now);
    expect(ok).toEqual({ admit: true, role: "participant", owner: false, acknowledge: true, wake: { agent_id: OTHER_AGENT, thread_id: CARD } });
    // Even an agent that is somehow the operator's id never gets owner.
    expect(admit(item({ from: OTHER_AGENT, kind: "agent" }), { ...s, operator_id: OTHER_AGENT, owner_id: OTHER_AGENT }, l, now)).toMatchObject({ owner: false });
  });

  it("caps other agents at 3 wakes per thread and 20 per agent in 24 hours, kept across runs", () => {
    const env = environment();
    const s = settings({ allow_agents: [{ membership_id: OTHER_AGENT, name: "Scout" }, { membership_id: SAM, name: "Sam" }] });
    const start = Date.parse("2026-10-17T12:00:00Z");
    let l = WakeLedger.load(env, "helper", start);
    for (let i = 0; i < 3; i++) {
      expect(admit(item({ from: OTHER_AGENT, kind: "agent" }), s, l, start + i)).toMatchObject({ admit: true });
      l.record(OTHER_AGENT, CARD, start + i);
    }
    expect(admit(item({ from: OTHER_AGENT, kind: "agent" }), s, l, start + 10)).toEqual({ admit: false, reason: "cap_reached" });
    // The thread cap counts every agent in the thread.
    expect(admit(item({ from: SAM, kind: "agent" }), s, l, start + 10)).toEqual({ admit: false, reason: "cap_reached" });
    expect(existsSync(statePath(env, "helper"))).toBe(true);
    // A restart reads the same ledger.
    l = WakeLedger.load(env, "helper", start + 20);
    expect(admit(item({ from: OTHER_AGENT, kind: "agent" }), s, l, start + 20)).toEqual({ admit: false, reason: "cap_reached" });
    for (let i = 3; i < 20; i++) {
      const thread = `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`;
      expect(admit(item({ from: OTHER_AGENT, kind: "agent", subject: thread }), s, l, start + 100 + i)).toMatchObject({ admit: true });
      l.record(OTHER_AGENT, thread, start + 100 + i);
    }
    expect(admit(item({ from: OTHER_AGENT, kind: "agent", subject: TODO }), s, l, start + 200)).toEqual({ admit: false, reason: "cap_reached" });
    expect(admit(item({ from: SAM, kind: "agent", subject: TODO }), s, l, start + 200)).toMatchObject({ admit: true });
    // A rolling day later, the caps have room again.
    const later = start + 24 * 60 * 60 * 1000 + 1000;
    expect(admit(item({ from: OTHER_AGENT, kind: "agent" }), s, WakeLedger.load(env, "helper", later), later)).toMatchObject({ admit: true });
  });
});

// --- The connector run -------------------------------------------------------

type Pending = () => InboxItem[];
function connectorThicket(pending: Pending, extra: Route[] = []) {
  const claims: string[] = []; const dismissals: { id: string; result: unknown }[] = [];
  const thicket = agentThicket({
    routes: [
      ...extra,
      (call: Call) => {
        if (call.path === "/api/v1/acme/my/agent/inbox" && call.method === "GET")
          return json({ items: call.search.includes("status=") && !call.search.includes("status=pending") ? [] : pending() });
        const m = call.path.match(/^\/api\/v1\/acme\/my\/agent\/inbox\/(.+)$/);
        if (m && call.body.status === "claim") {
          claims.push(m[1]);
          const found = pending().find((i) => i.id === m[1]);
          return json({ ...found, status: "running", runtime_id: call.body.runtime_id });
        }
        if (m && call.body.status === "dismissed") { dismissals.push({ id: m[1], result: call.body.result }); return json({ id: m[1], status: "dismissed" }); }
        return undefined;
      },
    ],
  });
  return { ...thicket, claims, dismissals };
}

async function listen(env: NodeJS.ProcessEnv, transport: typeof fetch, ticks = 1, now: () => number = Date.now) {
  const lines: Record<string, unknown>[] = [];
  const abort = new AbortController();
  let n = 0;
  await listenAgent(new CliContext({ profile: "helper" }, env, transport), abort.signal, async (row) => { lines.push(row); },
    async () => { if (++n >= ticks) abort.abort(); }, now);
  return lines;
}

describe("the connector", () => {
  it("refuses to start before setup, or with settings written for another agent", async () => {
    const env = environment(); await connectedAgent(env);
    const { transport, calls } = connectorThicket(() => []);
    await expect(listen(env, transport)).rejects.toThrow("isn't set up");
    writeConnectSettings(env, "helper", settings({ agent_membership_id: OTHER_AGENT }));
    await expect(listen(env, transport)).rejects.toThrow("another agent");
    expect(calls.some((c) => c.path.endsWith("/my/agent/session"))).toBe(false);
  });

  it("refuses a read-only connection", async () => {
    const env = environment(); await connectedAgent(env); writeConnectSettings(env, "helper", settings());
    const thicket = agentThicket({ scope: "read" });
    await expect(listen(env, thicket.transport)).rejects.toThrow("Read-only");
  });

  it("admits several requests at once, dismisses the rest with their reasons, and never emits one twice", async () => {
    const env = environment(); await connectedAgent(env);
    writeConnectSettings(env, "helper", settings({ allow_agents: [{ membership_id: OTHER_AGENT, name: "Scout" }] }));
    const items = [
      item({ id: "eeeeeeee-0000-4000-8000-0000000000a1" }),
      item({ id: "eeeeeeee-0000-4000-8000-0000000000a2", from: STRANGER }),
      item({ id: "eeeeeeee-0000-4000-8000-0000000000a3", project: P3 }),
      item({ id: "eeeeeeee-0000-4000-8000-0000000000a4", from: CLIENT, client: true }),
      item({ id: "eeeeeeee-0000-4000-8000-0000000000a5", reason: "completed" }),
      item({ id: "eeeeeeee-0000-4000-8000-0000000000a6", from: OTHER_AGENT, kind: "agent" }),
      item({ id: "eeeeeeee-0000-4000-8000-0000000000a7", reason: "pinged", project: null }),
    ];
    const thicket = connectorThicket(() => items);
    const lines = await listen(env, thicket.transport, 3);
    expect(lines.map((l) => `${l.type}:${l.id ?? ""}`)).toEqual([
      "connected:",
      "request:eeeeeeee-0000-4000-8000-0000000000a1",
      "dismissed:eeeeeeee-0000-4000-8000-0000000000a2",
      "dismissed:eeeeeeee-0000-4000-8000-0000000000a3",
      "dismissed:eeeeeeee-0000-4000-8000-0000000000a4",
      "dismissed:eeeeeeee-0000-4000-8000-0000000000a5",
      "request:eeeeeeee-0000-4000-8000-0000000000a6",
      "request:eeeeeeee-0000-4000-8000-0000000000a7",
    ]);
    expect(thicket.claims).toEqual(["eeeeeeee-0000-4000-8000-0000000000a1", "eeeeeeee-0000-4000-8000-0000000000a6", "eeeeeeee-0000-4000-8000-0000000000a7"]);
    expect(thicket.dismissals).toEqual([
      { id: "eeeeeeee-0000-4000-8000-0000000000a2", result: "not_trusted" },
      { id: "eeeeeeee-0000-4000-8000-0000000000a3", result: "not_served" },
      { id: "eeeeeeee-0000-4000-8000-0000000000a4", result: "client" },
      { id: "eeeeeeee-0000-4000-8000-0000000000a5", result: "completions_off" },
    ]);
    expect(lines.filter((l) => l.type === "dismissed").map((l) => l.reason)).toEqual(["not_trusted", "not_served", "client", "completions_off"]);
    expect(lines[6]).toMatchObject({ role: "participant", owner: false, requester_kind: "agent" });
    expect(existsSync(statePath(env, "helper"))).toBe(true);
    // The run holds the session with one runtime and releases it on the way out.
    const sessions = thicket.calls.filter((c) => c.path.endsWith("/my/agent/session"));
    expect(new Set(sessions.map((c) => c.body.runtime_id)).size).toBe(1);
    expect(sessions.at(-1)?.body.stop).toBe(true);
  });

  it("emits the request line in its documented shape, with an exact link only where one can be built", async () => {
    const env = environment(); await connectedAgent(env); writeConnectSettings(env, "helper", settings());
    const onCard = item({ id: "eeeeeeee-0000-4000-8000-0000000000b1" });
    const onTodo: InboxItem = { ...item({ id: "eeeeeeee-0000-4000-8000-0000000000b2", subject: TODO }), subject: { id: TODO, type: "todo", title: "Ship it" } };
    const assignedTodo: InboxItem = { ...item({ id: "eeeeeeee-0000-4000-8000-0000000000b3", reason: "assigned" }),
      source: { id: TODO, type: "todo", project_id: P1, parent_id: LIST, title: "Ship it", content: "<p>notes</p>", creator_membership_id: JASON, updated_at: "2026-10-17T10:00:00.000Z" },
      subject: { id: TODO, type: "todo", title: "Ship it" }, reply_to: { kind: "comment", recording_id: TODO } };
    const chatLine: InboxItem = { ...item({ id: "eeeeeeee-0000-4000-8000-0000000000b4" }),
      source: { id: "dddddddd-0000-4000-8000-0000000000f1", type: "chat_message", project_id: P1, parent_id: CHAT, title: null, content: "<p>hi</p>", creator_membership_id: JASON, updated_at: "2026-10-17T10:00:00.000Z" },
      subject: { id: CHAT, type: "chat", title: "Chat" }, reply_to: { kind: "chat_message", recording_id: CHAT } };
    const dmLine: InboxItem = { ...item({ id: "eeeeeeee-0000-4000-8000-0000000000b5", reason: "pinged", project: null }),
      source: { id: DM_LINE, type: "chat_message", project_id: null, parent_id: DM, title: null, content: "<p>ping</p>", creator_membership_id: JASON, updated_at: "2026-10-17T10:00:00.000Z" },
      subject: { id: DM, type: "dm", title: null }, reply_to: { kind: "chat_message", recording_id: DM } };
    const thicket = connectorThicket(() => [onCard, onTodo, assignedTodo, chatLine, dmLine]);
    const lines = (await listen(env, thicket.transport)).filter((l) => l.type === "request");
    const runtime = lines[0].runtime_id;
    expect(Object.keys(lines[0]).sort()).toEqual(["acknowledge", "content", "id", "organization", "owner", "profile", "recording", "reply_to",
      "requester_id", "requester_kind", "requester_name", "role", "runtime_id", "source", "trigger", "type"]);
    expect(lines[0]).toEqual({
      type: "request", id: onCard.id, runtime_id: runtime, trigger: "mentioned", role: "operator", owner: true, acknowledge: true,
      requester_id: JASON, requester_name: "Jason Hanschell", requester_kind: "person",
      recording: { id: COMMENT, type: "comment", title: "Fix the date picker", project_id: P1, project_name: "Website",
        url: `${host}/o/acme/projects/${P1}/cards/${CARD}#comment-${COMMENT}` },
      reply_to: { kind: "comment", recording_id: CARD }, content: "<p>please look</p>", source: onCard.source,
      profile: "helper", organization: "acme",
    });
    expect(lines[1].recording).not.toHaveProperty("url");
    expect(lines[2]).toMatchObject({ trigger: "assigned", owner: true, recording: { id: TODO, title: "Ship it", url: `${host}/o/acme/projects/${P1}/todos/${LIST}/${TODO}` } });
    expect(lines[3]).toMatchObject({ reply_to: { kind: "chat_message", recording_id: CHAT }, recording: { url: `${host}/o/acme/projects/${P1}/chat` } });
    expect(lines[4]).toMatchObject({ trigger: "pinged", owner: true, recording: { project_id: null, project_name: null, url: `${host}/o/acme/chats/${DM}` } });
  });

  it("skips a request Thicket refuses to hand over, without retrying it or stopping", async () => {
    const env = environment(); await connectedAgent(env); writeConnectSettings(env, "helper", settings());
    const taken = item({ id: "eeeeeeee-0000-4000-8000-0000000000c1" });
    const fine = item({ id: "eeeeeeee-0000-4000-8000-0000000000c2" });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let refusals = 0;
    const thicket = connectorThicket(() => [taken, fine], [
      (call) => call.path.endsWith(`/inbox/${taken.id}`) ? (refusals++, apiError(403, "agent_request_claimed", "This request has already been claimed")) : undefined,
    ]);
    const lines = await listen(env, thicket.transport, 3);
    expect(lines.filter((l) => l.type === "request").map((l) => l.id)).toEqual([fine.id]);
    expect(refusals).toBe(1);
  });

  it("rides out a failed renewal, and ends the run when the session has expired", async () => {
    const env = environment(); await connectedAgent(env); writeConnectSettings(env, "helper", settings());
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let clock = 0; let renewals = 0;
    const thicket = connectorThicket(() => [], [
      (call) => {
        if (!call.path.endsWith("/my/agent/session") || call.body.stop || clock === 0) return undefined;
        renewals++;
        return renewals === 1 ? apiError(503, "unavailable") : apiError(403, "agent_session_expired", "The listening session has expired");
      },
    ]);
    const abort = new AbortController();
    const run = listenAgent(new CliContext({ profile: "helper" }, env, thicket.transport), abort.signal, async () => {},
      async () => { clock += 11_000; }, () => clock);
    await expect(run).rejects.toThrow("expired");
    expect(renewals).toBe(2);
    expect(stderr.mock.calls.some(([s]) => String(s).includes("trying again"))).toBe(true);
    expect(thicket.calls.filter((c) => c.path.endsWith("/my/agent/session")).at(-1)?.body.stop).toBe(true);
  });
});

describe("connect status", () => {
  it("shows the agent, its settings and its requests by state; without settings, how to write them", async () => {
    const { run } = await import("../src/cli.js");
    const env = environment(); await connectedAgent(env);
    const counts: Record<string, number> = { pending: 2, running: 1, completed: 5, failed: 0, interrupted: 1, dismissed: 3 };
    const thicket = agentThicket({ routes: [(call) => {
      if (call.path !== "/api/v1/acme/my/agent/inbox") return undefined;
      const status = new URLSearchParams(call.search).get("status") ?? "pending";
      return json({ items: Array.from({ length: counts[status] }, (_, i) => ({ id: `${status}-${i}`, status })) });
    }] });
    const out: string[] = [];
    const exec = () => run(["connect", "status", "--profile", "helper", "--json"], { env, fetch: thicket.transport, isTty: false, write: (s) => out.push(s), writeErr: () => {} });
    expect(await exec()).toBe(0);
    let envelope = JSON.parse(out.splice(0).join("\n"));
    expect(envelope.data).toMatchObject({ settings: null, counts, agent: { membership_id: AGENT, name: "Helper", agent_type: "personal", boss: { membership_id: JASON } } });
    expect(envelope.summary).toContain("not set up");
    expect(envelope.breadcrumbs[0].cmd).toBe("thicket connect setup --profile helper");
    writeConnectSettings(env, "helper", settings());
    expect(await exec()).toBe(0);
    envelope = JSON.parse(out.splice(0).join("\n"));
    expect(envelope.data.settings).toMatchObject({ trust: "operator", operator_id: JASON });
    expect(envelope.summary).toContain("2 pending, 1 running, 5 completed, 0 failed, 1 interrupted, 3 dismissed");
    expect(envelope.data.counts).toEqual(counts);
  });
});
