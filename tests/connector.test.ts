// The connector and inbox against an in-memory API: SSE consumption with a
// reconnect and cursor resume, polling fallback, trust verdicts,
// corroboration, acks, dedupe, and the emitted line shape.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Deduper, runWatch, trustVerdict, type ConnectorEvent } from "../src/lib/connector.js";
import { CliContext } from "../src/lib/context.js";
import { inboxEvents, type NotificationRow } from "../src/lib/inbox.js";

const AGENT = "1e6b3cbb-0000-4000-8000-00000000a9e7";
const OPERATOR = "1e6b3cbb-0000-4000-8000-0000000000aa";
const STRANGER = "1e6b3cbb-0000-4000-8000-0000000000bb";
const CLIENT = "1e6b3cbb-0000-4000-8000-0000000000cc";
const PROJECT = "1e6b3cbb-0000-4000-8000-000000000001";
const OTHER_PROJECT = "1e6b3cbb-0000-4000-8000-000000000002";
const CARD = "1e6b3cbb-0000-4000-8000-00000000ca4d";
const TODO = "1e6b3cbb-0000-4000-8000-00000000f0d0";
const MSG = "1e6b3cbb-0000-4000-8000-00000000c0de";
const COMMENT = "1e6b3cbb-0000-4000-8000-00000000c033";

const AUTH_DOC = {
  identity: { id: "agent-user" },
  organizations: [
    { id: "org-1", name: "Acme", slug: "acme", href: "", membership_id: AGENT, role: "member", membership_kind: "agent" },
  ],
  scope: "full",
  expires_at: null,
};

const mention = (id: string) => `<span data-mention-id="${id}">@Clawdito</span>`;

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function fakeFetch(handlers: Record<string, Handler>, calls: string[] = []): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push(`${key}${url.search}`);
    const handler = handlers[key];
    if (!handler) return json({ error: { code: "not_found", message: `no route ${key}` } }, 404);
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

function ctxWith(fetch: typeof globalThis.fetch): CliContext {
  return new CliContext(
    {},
    {
      THICKET_CONFIG_DIR: mkdtempSync(join(tmpdir(), "thicket-cli-connector-")),
      THICKET_TOKEN: "thicket_pat_agent",
      THICKET_BASE_URL: "http://localhost:9999",
    },
    fetch,
  );
}

function row(partial: Partial<NotificationRow> & { id: string; action: string }): NotificationRow {
  return {
    title: "Someone",
    body: null,
    recording_id: CARD,
    recording_type: "card",
    recording_parent_id: null,
    project_id: PROJECT,
    actor_name: "Operator",
    actor_membership_id: OPERATOR,
    actor_role: "owner",
    actor_kind: "person",
    from_operator: true,
    directive: true,
    read_at: null,
    created_at: "2026-09-01T10:00:00.000Z",
    ...partial,
  };
}

describe("trustVerdict", () => {
  const base = row({ id: "n", action: "mentioned" });
  it("operator mode trusts the server's verdicts only", () => {
    expect(trustVerdict(base, "mentioned", { mode: "operator", allow: [] }, AGENT).allowed).toBe(true);
    expect(trustVerdict({ ...base, directive: false }, "mentioned", { mode: "operator", allow: [] }, AGENT).allowed).toBe(false);
    expect(trustVerdict({ ...base, from_operator: false }, "commented", { mode: "operator", allow: [] }, AGENT).allowed).toBe(false);
    expect(trustVerdict({ ...base, from_operator: true }, "cheered", { mode: "operator", allow: [] }, AGENT).allowed).toBe(true);
  });
  it("allowlist adds listed actors; members admits any non-client", () => {
    const stranger = { ...base, actor_membership_id: STRANGER, directive: false, from_operator: false, actor_role: "member" };
    expect(trustVerdict(stranger, "mentioned", { mode: "allowlist", allow: [STRANGER] }, AGENT).allowed).toBe(true);
    expect(trustVerdict(stranger, "mentioned", { mode: "allowlist", allow: [OPERATOR] }, AGENT).allowed).toBe(false);
    expect(trustVerdict(stranger, "commented", { mode: "members", allow: [] }, AGENT).allowed).toBe(true);
  });
  it("never trusts clients, the agent itself, or actor-less rows", () => {
    expect(trustVerdict({ ...base, actor_role: "client" }, "mentioned", { mode: "members", allow: [] }, AGENT).allowed).toBe(false);
    expect(trustVerdict({ ...base, actor_membership_id: AGENT }, "mentioned", { mode: "members", allow: [] }, AGENT).allowed).toBe(false);
    expect(trustVerdict({ ...base, actor_membership_id: null }, "mentioned", { mode: "members", allow: [] }, AGENT).allowed).toBe(false);
  });
  it("dedupes with a bounded window", () => {
    const d = new Deduper(2);
    expect(d.first("a")).toBe(true);
    expect(d.first("a")).toBe(false);
    d.first("b");
    d.first("c");
    expect(d.first("a")).toBe(true); // evicted
  });
});

describe("inboxEvents", () => {
  it("consumes the stream, resumes from the reconnect cursor, then polls when the stream vanishes", async () => {
    const calls: string[] = [];
    let streamCalls = 0;
    const controller = new AbortController();
    const fetch = fakeFetch(
      {
        "GET /api/v1/authorization": () => json(AUTH_DOC),
        "GET /api/v1/acme/my/notifications/stream": (url) => {
          streamCalls += 1;
          if (streamCalls === 1) {
            return sse(
              "retry: 3000\nevent: ready\ndata: {\"cursor\":{\"since\":\"2026-09-01T09:00:00.000Z\",\"after\":null}}\n\n" +
                ": ping\n\n" +
                `id: n1\nevent: notification\ndata: ${JSON.stringify(row({ id: "n1", action: "mentioned" }))}\n\n` +
                "event: reconnect\ndata: {\"cursor\":{\"since\":\"2026-09-01T10:00:00.000Z\",\"after\":\"n1\"},\"reason\":\"max_lifetime\"}\n\n",
            );
          }
          if (streamCalls === 2) {
            expect(url.searchParams.get("since")).toBe("2026-09-01T10:00:00.000Z");
            expect(url.searchParams.get("after")).toBe("n1");
            return json({ error: { code: "not_found", message: "gone" } }, 404);
          }
          throw new Error("stream should not be retried once unavailable");
        },
        "GET /api/v1/acme/my/notifications": (url) => {
          expect(url.searchParams.get("presence")).toBe("true");
          expect(url.searchParams.get("since")).toBe("2026-09-01T10:00:00.000Z");
          expect(url.searchParams.get("after")).toBe("n1");
          return json({
            unread_count: 1,
            notifications: [row({ id: "n2", action: "assigned", created_at: "2026-09-01T10:01:00.000Z" })],
            next_cursor: { since: "2026-09-01T10:01:00.000Z", after: "n2" },
          });
        },
      },
      calls,
    );
    const ctx = ctxWith(fetch);
    const seen: string[] = [];
    const logs: string[] = [];
    for await (const event of inboxEvents({
      ctx,
      cursor: { since: null, after: null },
      pollSeconds: 0.01,
      signal: controller.signal,
      log: (l) => logs.push(l),
    })) {
      seen.push(event.type === "row" ? `row:${event.row.id}:${event.source}` : `${event.type}:${event.cursor.since}`);
      if (event.type === "row" && event.row.id === "n2") controller.abort();
    }
    expect(seen).toEqual([
      "ready:2026-09-01T09:00:00.000Z",
      "row:n1:sse",
      "reconnect:2026-09-01T10:00:00.000Z",
      "row:n2:poll",
    ]);
    expect(logs.some((l) => l.includes("polling instead"))).toBe(true);
    expect(streamCalls).toBe(2);
  });

  it("fails fast on a refused token", async () => {
    const controller = new AbortController();
    const fetch = fakeFetch({
      "GET /api/v1/authorization": () => json(AUTH_DOC),
      "GET /api/v1/acme/my/notifications/stream": () => json({ error: { code: "auth_required" } }, 401),
    });
    const it_ = inboxEvents({ ctx: ctxWith(fetch), cursor: { since: null, after: null }, pollSeconds: 0.01, signal: controller.signal, log: () => {} });
    await expect(it_.next()).rejects.toMatchObject({ code: "auth" });
  });
});

describe("runWatch", () => {
  function recordings(): Record<string, Handler> {
    return {
      [`GET /api/v1/acme/recordings/${CARD}`]: () =>
        json({
          id: CARD, type: "card", title: "Fix the date picker", content: `<p>${mention(AGENT)} please fix</p>`,
          project_id: PROJECT, parent_id: "1e6b3cbb-0000-4000-8000-0000000000c0", creator_id: OPERATOR, creator_name: "Operator",
          created_at: "2026-09-01T09:59:00.000Z", status: "active", assignee_ids: [AGENT], mentioned_membership_ids: [AGENT], content_attachments: [],
        }),
      [`GET /api/v1/acme/recordings/${MSG}`]: () =>
        json({
          id: MSG, type: "message", title: "Release plan", content: "<p>Plan</p>", project_id: PROJECT, parent_id: null,
          creator_id: STRANGER, created_at: "2026-08-30T09:00:00.000Z", status: "active", assignee_ids: [], mentioned_membership_ids: [], content_attachments: [],
        }),
      [`GET /api/v1/acme/recordings/${MSG}/comments`]: () =>
        json([
          { id: "old", type: "comment", content: "<p>earlier</p>", creator_id: OPERATOR, created_at: "2026-09-01T09:00:00.000Z" },
          { id: COMMENT, type: "comment", content: `<p>${mention(AGENT)} ship it</p>`, creator_id: OPERATOR, created_at: "2026-09-01T10:00:00.000Z" },
        ]),
      [`GET /api/v1/acme/recordings/${TODO}`]: () =>
        json({
          id: TODO, type: "todo", title: "Write tests", content: null, project_id: PROJECT, parent_id: null, creator_id: STRANGER,
          created_at: "2026-09-01T09:00:00.000Z", status: "active", assignee_ids: [STRANGER], mentioned_membership_ids: [], content_attachments: [],
        }),
      [`GET /api/v1/acme/agents/${AGENT}`]: () =>
        json({ membership_id: AGENT, name: "Clawdito", directable_by: "operators", operators: [{ membership_id: OPERATOR, name: "Operator" }] }),
      "GET /api/v1/acme/people": () => json([{ membership_id: OPERATOR, name: "Operator", role: "owner", kind: "person" }]),
    };
  }

  async function collect(rows: NotificationRow[], extra: Record<string, Handler> = {}, options: Partial<Parameters<typeof runWatch>[0]> = {}) {
    const controller = new AbortController();
    const calls: string[] = [];
    const cheers: unknown[] = [];
    let polls = 0;
    const fetch = fakeFetch(
      {
        "GET /api/v1/authorization": () => json(AUTH_DOC),
        "GET /api/v1/acme/my/notifications": () => {
          polls += 1;
          if (polls === 1) return json({ unread_count: rows.length, notifications: rows });
          // Nothing new; end the run once the first page is drained.
          setTimeout(() => controller.abort(), 20);
          return json({ unread_count: 0, notifications: [] });
        },
        [`POST /api/v1/acme/recordings/${CARD}/cheers`]: (_u, init) => {
          cheers.push({ on: CARD, ...JSON.parse(String(init?.body)) });
          return json({ id: "cheer-1", content: "On it!" }, 201);
        },
        [`POST /api/v1/acme/recordings/${COMMENT}/cheers`]: (_u, init) => {
          cheers.push({ on: COMMENT, ...JSON.parse(String(init?.body)) });
          return json({ id: "cheer-2", content: "On it!" }, 201);
        },
        ...recordings(),
        ...extra,
      },
      calls,
    );
    const ctx = ctxWith(fetch);
    const events: ConnectorEvent[] = [];
    const logs: string[] = [];
    await runWatch({
      ctx,
      baseUrl: "http://localhost:9999",
      org: "acme",
      agent: { membership_id: AGENT, name: "Clawdito" },
      projects: [],
      trust: { mode: "operator", allow: [] },
      cursor: { since: "2026-09-01T09:00:00.000Z", after: null },
      pollSeconds: 0.01,
      cheers: false,
      cheerPollSeconds: 60,
      ack: "On it!",
      pollOnly: true,
      signal: controller.signal,
      log: (l) => logs.push(l),
      emit: (e) => events.push(e),
      ...options,
    });
    return { events, logs, cheers, calls };
  }

  it("emits corroborated directives with acks, web urls, and mention-comment detail", async () => {
    const { events, cheers, logs } = await collect([
      row({ id: "n1", action: "mentioned", recording_id: CARD, recording_type: "card" }),
      row({ id: "n2", action: "mentioned", recording_id: MSG, recording_type: "message", created_at: "2026-09-01T10:00:05.000Z" }),
      row({ id: "n1", action: "mentioned", recording_id: CARD }), // duplicate id
      row({ id: "n3", action: "assigned", recording_id: TODO, recording_type: "todo" }), // not actually assigned
      row({ id: "n4", action: "mentioned", recording_id: CARD, actor_membership_id: STRANGER, actor_name: "Stranger", directive: false, from_operator: false }),
      row({ id: "n5", action: "reminder", actor_membership_id: null }),
    ]);
    expect(events.map((e) => e.event_id)).toEqual(["n1", "n2"]);
    const card = events[0];
    expect(card.kind).toBe("mentioned");
    expect(card.actor).toEqual({ membership_id: OPERATOR, name: "Operator", role: "owner", kind: "person" });
    expect(card.recording).toMatchObject({ id: CARD, type: "card", title: "Fix the date picker", project_id: PROJECT });
    expect(card.recording.web_url).toBe(`http://localhost:9999/o/acme/projects/${PROJECT}/cards/${CARD}`);
    expect(card.recording.text).toBe("@Clawdito please fix");
    expect(card.instruction).toBe("@Clawdito please fix");
    expect(card.comment).toBeNull();
    expect(card.trigger).toEqual({ directive: true, from_operator: true, mentioned: true, assigned: true, subscribed: false });
    expect(card.ack).toEqual({ ok: true, cheer_id: "cheer-1", error: null });
    expect(card.cursor).toEqual({ since: "2026-09-01T10:00:00.000Z", after: "n1" });
    const msg = events[1];
    expect(msg.comment).toMatchObject({ id: COMMENT, text: "@Clawdito ship it" });
    expect(msg.comment?.web_url).toBe(`http://localhost:9999/o/acme/projects/${PROJECT}/message-board/${MSG}#comment-${COMMENT}`);
    expect(msg.instruction).toBe("@Clawdito ship it");
    expect(msg.ack?.cheer_id).toBe("cheer-2");
    expect(cheers).toEqual([{ on: CARD, content: "On it!" }, { on: COMMENT, content: "On it!" }]);
    expect(logs.some((l) => l.includes("n3") && l.includes("uncorroborated"))).toBe(true);
    expect(logs.some((l) => l.includes("n4") && l.includes("not a directive"))).toBe(true);
    expect(logs.some((l) => l.includes("n5") && l.includes("not a trigger"))).toBe(true);
  });

  it("respects the project filter, --no-ack, and allowlist trust", async () => {
    const { events, cheers } = await collect(
      [
        row({ id: "n1", action: "mentioned", recording_id: CARD, project_id: OTHER_PROJECT }),
        row({ id: "n2", action: "mentioned", recording_id: CARD, actor_membership_id: OPERATOR, directive: false, from_operator: false }),
      ],
      {},
      { projects: [{ id: PROJECT, name: "Website" }], ack: false, trust: { mode: "allowlist", allow: [OPERATOR] } },
    );
    expect(events.map((e) => e.event_id)).toEqual(["n2"]);
    expect(events[0].ack).toBeNull();
    expect(cheers).toEqual([]);
  });

  it("corroborates followed-thread comments through the subscription and never acks them", async () => {
    const { events, cheers } = await collect(
      [row({ id: "n1", action: "commented", recording_id: MSG, recording_type: "message", from_operator: true, directive: false })],
      {
        [`GET /api/v1/acme/recordings/${MSG}/subscription`]: () => json({ subscribed: true, subscribers: [{ membership_id: AGENT, name: "Clawdito" }] }),
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("commented");
    expect(events[0].trigger).toMatchObject({ directive: false, subscribed: true });
    expect(events[0].comment?.id).toBe(COMMENT);
    expect(events[0].ack).toBeNull();
    expect(cheers).toEqual([]);
  });

  it("turns received cheers into cheered events from the polled feed", async () => {
    const controller = new AbortController();
    let cheerPolls = 0;
    const fetch = fakeFetch({
      "GET /api/v1/authorization": () => json(AUTH_DOC),
      "GET /api/v1/acme/my/notifications": () => json({ unread_count: 0, notifications: [] }),
      "GET /api/v1/acme/my/cheers": (url) => {
        cheerPolls += 1;
        const since = url.searchParams.get("since")!;
        // The baseline call carries the start instant; the cheer lands after it.
        const cheer = {
          id: "ch1", content: "redo", created_at: new Date(Date.parse(since) + 1000).toISOString(),
          cheerer_name: "Operator", cheerer_membership_id: OPERATOR, recording_id: CARD, recording_type: "card",
          recording_title: "Fix the date picker", recording_parent_id: null, project_id: PROJECT, project_name: "Website",
        };
        if (cheerPolls >= 2) setTimeout(() => controller.abort(), 20);
        return json({ received: [cheer], given: [] });
      },
      ...recordings(),
    });
    const events: ConnectorEvent[] = [];
    await runWatch({
      ctx: ctxWith(fetch),
      baseUrl: "http://localhost:9999",
      org: "acme",
      agent: { membership_id: AGENT, name: "Clawdito" },
      projects: [],
      trust: { mode: "operator", allow: [] },
      cursor: { since: null, after: null },
      pollSeconds: 0.05,
      cheers: true,
      cheerPollSeconds: 0.01,
      ack: "On it!",
      pollOnly: true,
      signal: controller.signal,
      log: () => {},
      emit: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "cheered",
      event_id: "cheer:ch1",
      cheer: { id: "ch1", content: "redo" },
      instruction: "redo",
      actor: { membership_id: OPERATOR, role: "owner" },
      trigger: { directive: false, from_operator: true },
      ack: null,
    });
  });
});
