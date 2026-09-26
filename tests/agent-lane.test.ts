// The agent-lane commands end to end through run(): notifications, cheers,
// subscriptions, people and agents, URLs, threads, Markdown bodies, stdin,
// --jq, retryable errors, the raw api passthrough, and doctor --json.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { EXIT_CODES } from "../src/lib/output.js";

const ME = "1e6b3cbb-0000-4000-8000-0000000000aa";
const JANE = "1e6b3cbb-0000-4000-8000-0000000000bb";
const BOT = "1e6b3cbb-0000-4000-8000-00000000a9e7";
const PROJECT = "1e6b3cbb-0000-4000-8000-000000000001";
const REC = "1e6b3cbb-0000-4000-8000-00000000ca4d";
const LINE = "1e6b3cbb-0000-4000-8000-00000000c4a7";
const NOTE = "1e6b3cbb-0000-4000-8000-00000000000e";

const AUTH_DOC = {
  identity: { id: "user-1" },
  organizations: [
    { id: "org-1", name: "Acme", slug: "acme", href: "http://localhost:9999/api/v1/acme", membership_id: ME, role: "owner", membership_kind: "person" },
  ],
  scope: "full",
  expires_at: null,
};

const PEOPLE = [
  { membership_id: ME, name: "Jason Hanschell", email: "jason@acme.test", role: "owner", kind: "person", active: null },
  { membership_id: JANE, name: "Jane Doe", email: "jane@acme.test", role: "member", kind: "person", active: null },
  { membership_id: BOT, name: "Clawdito", email: "clawdito@agents.acme.test", role: "member", kind: "agent", active: true },
];

type Handler = (url: URL, init?: RequestInit) => unknown;
type Routes = Record<string, unknown | Handler>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = { key: string; body?: any };

function fakeFetch(routes: Routes, calls: Call[]): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push({ key: `${key}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (key in routes) {
      const value = routes[key];
      const result = typeof value === "function" ? (value as Handler)(url, init) : value;
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        status: (init?.method ?? "GET") === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: `no route ${key}` } }), { status: 404 });
  }) as typeof globalThis.fetch;
}

async function exec(argv: string[], routes: Routes = {}, envExtra: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const env: NodeJS.ProcessEnv = {
    THICKET_CONFIG_DIR: mkdtempSync(join(tmpdir(), "thicket-cli-lane-")),
    THICKET_TOKEN: "thicket_pat_test",
    THICKET_BASE_URL: "http://localhost:9999",
    ...envExtra,
  };
  const code = await run(argv, {
    env,
    fetch: fakeFetch({ "GET /api/v1/authorization": AUTH_DOC, "GET /api/v1/acme/people": PEOPLE, ...routes }, calls),
    isTty: false,
    write: (line) => out.push(line),
    writeErr: (line) => err.push(line),
  });
  const parse = (lines: string[]) => {
    try {
      return JSON.parse(lines.join("\n"));
    } catch {
      return null;
    }
  };
  return { code, out, err, calls, envelope: parse(out), error: parse(err), env };
}

describe("notifications", () => {
  it("passes cursor, action, unread, limit and presence through and carries next_cursor", async () => {
    const { code, envelope, calls } = await exec(
      ["inbox", "--since", "2026-09-01T10:00:00Z", "--after", NOTE, "--action", "mentioned,assigned", "--unread", "--limit", "5", "--presence"],
      {
        "GET /api/v1/acme/my/notifications": {
          unread_count: 1,
          notifications: [{ id: NOTE, action: "mentioned", title: "Jane", body: "hi", created_at: "2026-09-01T10:01:00.000Z", read_at: null, directive: true, actor_name: "Jane" }],
          next_cursor: { since: "2026-09-01T10:01:00.000Z", after: NOTE },
        },
      },
    );
    expect(code).toBe(0);
    expect(envelope.data.next_cursor.after).toBe(NOTE);
    const q = new URL(`http://x${calls.find((c) => c.key.includes("/my/notifications"))!.key.split(" ")[1]}`).searchParams;
    expect(q.get("since")).toBe("2026-09-01T10:00:00.000Z");
    expect(q.get("after")).toBe(NOTE);
    expect(q.get("action")).toBe("mentioned,assigned");
    expect(q.get("unread")).toBe("true");
    expect(q.get("limit")).toBe("5");
    expect(q.get("presence")).toBe("true");
    expect(envelope.breadcrumbs.some((b: { cmd: string }) => b.cmd.includes("--after"))).toBe(true);
  });

  it("marks one read and all read", async () => {
    const one = await exec(["notifications", "read", NOTE], { [`PATCH /api/v1/acme/my/notifications/${NOTE}`]: { ok: true } });
    expect(one.code).toBe(0);
    expect(one.calls.find((c) => c.key.startsWith("PATCH"))?.body).toEqual({ read: true });
    const all = await exec(["notifications", "read", "--all"], { "PUT /api/v1/acme/my/notifications": { ok: true } });
    expect(all.code).toBe(0);
    expect(all.calls.some((c) => c.key.startsWith("PUT /api/v1/acme/my/notifications"))).toBe(true);
  });
});

describe("cheers and subscriptions", () => {
  it("cheer posts content, by id, by URL, and on an event", async () => {
    const byId = await exec(["cheer", REC, "On it!"], { [`POST /api/v1/acme/recordings/${REC}/cheers`]: { id: "c1", content: "On it!" } });
    expect(byId.code).toBe(0);
    expect(byId.calls.find((c) => c.key.startsWith("POST"))?.body).toEqual({ content: "On it!" });
    const byUrl = await exec(["cheer", `https://www.thickethq.com/o/acme/projects/${PROJECT}/cards/${REC}`, "👍"], {
      [`POST /api/v1/acme/recordings/${REC}/cheers`]: { id: "c2", content: "👍" },
    });
    expect(byUrl.envelope.data.id).toBe("c2");
    const onEvent = await exec(["cheer", "--event", NOTE, "x", "nice"], { [`POST /api/v1/acme/events/${NOTE}/cheers`]: { already_cheered: false } });
    expect(onEvent.code).toBe(0);
    const tooLong = await exec(["cheer", REC, "this is far too long for a cheer"]);
    expect(tooLong.code).toBe(EXIT_CODES.validation);
  });

  it("cheers list passes since and filters by cheerer", async () => {
    const { code, envelope, calls } = await exec(["cheers", "--since", "2026-09-01T00:00:00Z", "--from", "Jane"], {
      "GET /api/v1/acme/my/cheers": {
        received: [
          { id: "a", content: "👍", created_at: "2026-09-01T01:00:00Z", cheerer_name: "Jane Doe", cheerer_membership_id: JANE, recording_id: REC, recording_type: "card", recording_title: "T", project_name: "P" },
          { id: "b", content: "🔥", created_at: "2026-09-01T01:00:00Z", cheerer_name: "Me", cheerer_membership_id: ME, recording_id: REC, recording_type: "card", recording_title: "T", project_name: "P" },
        ],
        given: [],
      },
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.key.includes("/my/cheers?since=2026-09-01T00%3A00%3A00.000Z"))).toBe(true);
    expect(envelope.data.received.map((r: { id: string }) => r.id)).toEqual(["a"]);
  });

  it("subscriptions show/add/remove hit the subscription route", async () => {
    const show = await exec(["subscriptions", "show", REC], { [`GET /api/v1/acme/recordings/${REC}/subscription`]: { subscribed: false, subscribers: [{ membership_id: JANE, name: "Jane Doe" }] } });
    expect(show.envelope.data.subscribed).toBe(false);
    expect(show.envelope.breadcrumbs[0].cmd).toContain("subscriptions add");
    const add = await exec(["subscriptions", "add", REC], { [`PUT /api/v1/acme/recordings/${REC}/subscription`]: { subscribed: true } });
    expect(add.envelope.data.subscribed).toBe(true);
    const remove = await exec(["subscriptions", "remove", `/o/acme/projects/${PROJECT}/cards/${REC}`], { [`DELETE /api/v1/acme/recordings/${REC}/subscription`]: { subscribed: false } });
    expect(remove.envelope.data.subscribed).toBe(false);
  });
});

describe("people and agents", () => {
  it("people lists membership ids with mention tokens; --agents filters", async () => {
    const all = await exec(["people"]);
    expect(all.envelope.data).toHaveLength(3);
    expect(all.envelope.data[1].mention).toBe(`[@Jane Doe](member:${JANE})`);
    const agents = await exec(["people", "--agents"]);
    expect(agents.envelope.data.map((p: { name: string }) => p.name)).toEqual(["Clawdito"]);
    const ids = await exec(["people", "--ids-only"]);
    expect(ids.out).toEqual([ME, JANE, BOT]);
  });

  it("agents create/operators/token/deactivate map to the agent routes", async () => {
    const agent = { membership_id: BOT, name: "Clawdito", role: "member", kind: "agent", directable_by: "operators", active: false, presence_at: null, operators: [{ membership_id: ME, name: "Jason Hanschell" }], token: null, removed_at: null, created_at: "2026-09-01T00:00:00Z" };
    const created = await exec(["agents", "create", "Clawdito", "--operator", "Jane"], { "POST /api/v1/acme/agents": agent });
    expect(created.code).toBe(0);
    expect(created.calls.find((c) => c.key.startsWith("POST /api/v1/acme/agents"))?.body).toEqual({ name: "Clawdito", operator_ids: [JANE] });

    const ops = await exec(["agents", "operators", "Clawdito", "Jane", "--add"], {
      "GET /api/v1/acme/agents": [agent],
      [`PUT /api/v1/acme/agents/${BOT}/operators`]: { operators: [{ membership_id: ME, name: "Jason Hanschell" }, { membership_id: JANE, name: "Jane Doe" }] },
    });
    expect(ops.code).toBe(0);
    expect(ops.calls.find((c) => c.key.startsWith("PUT"))?.body.operator_ids.sort()).toEqual([ME, JANE].sort());

    const token = await exec(["agents", "token", BOT], {
      [`GET /api/v1/acme/agents/${BOT}`]: agent,
      [`POST /api/v1/acme/agents/${BOT}/token`]: () =>
        new Response(JSON.stringify({ error: { code: "session_required", message: "Sign in to manage tokens" } }), { status: 403 }),
    });
    expect(token.code).toBe(0);
    expect(token.envelope.data.minted).toBe(false);
    expect(token.envelope.data.mint_url).toBe("http://localhost:9999/o/acme/admin/agents");
    expect(token.envelope.summary).toContain("Admin, AI agents");

    const minted = await exec(["agents", "token", BOT, "--scope", "read"], {
      [`GET /api/v1/acme/agents/${BOT}`]: agent,
      [`POST /api/v1/acme/agents/${BOT}/token`]: { token: "thicket_pat_new", id: "t1", token_prefix: "thicket_pat_ne", scope: "read", created_at: "2026-09-01T00:00:00Z" },
    });
    expect(minted.envelope.data.minted).toBe(true);
    expect(minted.envelope.data.token).toBe("thicket_pat_new");

    const off = await exec(["agents", "deactivate", BOT], { [`GET /api/v1/acme/agents/${BOT}`]: agent, [`DELETE /api/v1/acme/agents/${BOT}`]: { ok: true } });
    expect(off.envelope.data.active).toBe(false);
    const on = await exec(["agents", "reactivate", BOT], { [`GET /api/v1/acme/agents/${BOT}`]: agent, [`PATCH /api/v1/acme/agents/${BOT}`]: { ...agent, active: true } });
    expect(on.calls.find((c) => c.key.startsWith("PATCH"))?.body).toEqual({ active: true });
  });

  it("agent watch refuses a person token with a hint, and --status lists runs", async () => {
    const refused = await exec(["agent", "watch", "--agent", "Clawdito"]);
    expect(refused.code).toBe(EXIT_CODES.usage);
    expect(refused.error.error).toContain("person membership");
    expect(refused.error.hint).toContain("--with-token");
    const status = await exec(["agent", "watch", "--status"]);
    expect(status.code).toBe(0);
    expect(status.envelope.data).toEqual([]);
  });
});

describe("URLs, threads, and chat lines", () => {
  it("url parse explains a link; show accepts a URL and adopts its org", async () => {
    const parsed = await exec(["url", "parse", `https://www.thickethq.com/o/beta/projects/${PROJECT}/todos/${NOTE}/${REC}#comment-${LINE}`]);
    expect(parsed.envelope.data).toEqual({ org: "beta", project_id: PROJECT, recording_id: REC, type: "todo", parent_id: NOTE, comment_id: LINE, occurrence: null });
    const shown = await exec(["show", `https://www.thickethq.com/o/beta/projects/${PROJECT}/cards/${REC}`], {
      [`GET /api/v1/beta/recordings/${REC}`]: { id: REC, type: "card", title: "Card", project_id: PROJECT, parent_id: null },
    });
    expect(shown.code).toBe(0);
    expect(shown.envelope.data.web_url).toBe(`http://localhost:9999/o/beta/projects/${PROJECT}/cards/${REC}`);
    const conflict = await exec(["show", `/o/beta/projects/${PROJECT}/cards/${REC}`, "--org", "acme"]);
    expect(conflict.code).toBe(EXIT_CODES.usage);
    const page = await exec(["show", `/o/acme/projects/${PROJECT}/todos`]);
    expect(page.code).toBe(EXIT_CODES.usage);
  });

  it("comments thread returns the recording plus comments with mention tokens", async () => {
    const { code, envelope } = await exec(["comments", "thread", REC], {
      [`GET /api/v1/acme/recordings/${REC}`]: { id: REC, type: "message", title: "Plan", content: "<p>Body</p>", project_id: PROJECT, parent_id: null, creator_id: ME, creator_name: "Jason Hanschell", created_at: "2026-09-01T09:00:00Z" },
      [`GET /api/v1/acme/recordings/${REC}/comments`]: [
        { id: "c2", type: "comment", content: "<p>Second</p>", creator_id: JANE, creator_name: "Jane Doe", created_at: "2026-09-01T11:00:00Z" },
        { id: "c1", type: "comment", content: "<p>First <b>bold</b></p>", creator_id: ME, creator_name: "Jason Hanschell", created_at: "2026-09-01T10:00:00Z" },
      ],
    });
    expect(code).toBe(0);
    expect(envelope.data.entries.map((e: { id: string }) => e.id)).toEqual([REC, "c1", "c2"]);
    expect(envelope.data.entries[1].text).toBe("First bold");
    expect(envelope.data.entries[2].author.mention).toBe(`[@Jane Doe](member:${JANE})`);
    expect(envelope.data.entries[2].web_url).toContain(`#comment-c2`);
    expect(envelope.data.authors).toHaveLength(2);
    expect(envelope.data.reply_cmd).toContain(`thicket comment ${REC}`);
  });

  it("chat line reads one line and refuses non-lines", async () => {
    const ok = await exec(["chat", "line", LINE], {
      [`GET /api/v1/acme/recordings/${LINE}`]: { id: LINE, type: "chat_message", content: "<p>hi</p>", project_id: PROJECT, parent_id: REC, creator_name: "Jane Doe", created_at: "2026-09-01T10:00:00Z" },
    });
    expect(ok.code).toBe(0);
    expect(ok.envelope.data.text).toBe("hi");
    expect(ok.envelope.data.web_url).toBe(`http://localhost:9999/o/acme/projects/${PROJECT}/chat`);
    const no = await exec(["chat", "line", REC], { [`GET /api/v1/acme/recordings/${REC}`]: { id: REC, type: "todo" } });
    expect(no.code).toBe(EXIT_CODES.not_found);
  });
});

describe("rich text bodies", () => {
  it("comment converts Markdown and resolves mentions; --plain and --html opt out", async () => {
    const md = await exec(["comment", REC, "**Done** @Jane see [the PR](https://x.test/pr/1)"], { [`POST /api/v1/acme/recordings/${REC}/comments`]: { id: "c1" } });
    expect(md.code).toBe(0);
    const body = md.calls.find((c) => c.key.startsWith("POST"))!.body as { content_html: string; content?: string };
    expect(body.content).toBeUndefined();
    expect(body.content_html).toContain("<strong>Done</strong>");
    expect(body.content_html).toContain(`<span data-mention-id="${JANE}">@Jane Doe</span>`);
    expect(body.content_html).toContain('<a href="https://x.test/pr/1">the PR</a>');

    const plain = await exec(["comment", REC, "**not bold**", "--plain"], { [`POST /api/v1/acme/recordings/${REC}/comments`]: { id: "c2" } });
    expect(plain.calls.find((c) => c.key.startsWith("POST"))!.body).toEqual({ content: "**not bold**" });

    const html = await exec(["comment", REC, "<p>raw</p>", "--html"], { [`POST /api/v1/acme/recordings/${REC}/comments`]: { id: "c3" } });
    expect(html.calls.find((c) => c.key.startsWith("POST"))!.body).toEqual({ content_html: "<p>raw</p>" });

    const ambiguous = await exec(["comment", REC, "@Ja look"], {});
    expect(ambiguous.code).toBe(EXIT_CODES.ambiguous);
    expect(ambiguous.error.error).toContain("Jane Doe");
  });

  it("message, doc, card, chat, and to-do bodies all ship content_html", async () => {
    const tools = [
      { tool: "message_board", enabled: true, container_id: "1e6b3cbb-0000-4000-8000-0000000000b0" },
      { tool: "folder", enabled: true, container_id: "1e6b3cbb-0000-4000-8000-0000000000f0" },
      { tool: "chat", enabled: true, container_id: "1e6b3cbb-0000-4000-8000-0000000000c0" },
      { tool: "todos", enabled: true, container_id: "1e6b3cbb-0000-4000-8000-0000000000d0" },
    ];
    const routes: Routes = {
      "GET /api/v1/acme/projects": [{ id: PROJECT, name: "Website" }],
      [`GET /api/v1/acme/projects/${PROJECT}/tools`]: tools,
    };
    for (const t of tools) routes[`POST /api/v1/acme/recordings/${t.container_id}/children`] = { id: "new", title: "x" };
    const message = await exec(["message", "Status", "--content", "# All green\n\n- a", "--in", "Website"], routes);
    expect(message.calls.find((c) => c.key.startsWith("POST"))!.body.content_html).toContain("<h1>All green</h1>");
    const doc = await exec(["docs", "create", "Spec", "--content", "> quoted", "--in", "Website"], routes);
    expect(doc.calls.find((c) => c.key.startsWith("POST"))!.body.content_html).toContain("<blockquote>");
    const chat = await exec(["chat", "post", "hello *there*", "--in", "Website"], routes);
    expect(chat.calls.find((c) => c.key.startsWith("POST"))!.body.content_html).toContain("<em>there</em>");
    const todo = await exec(["todo", "Ship", "--in", "Website", "--notes", "`code`"], routes);
    expect(todo.calls.find((c) => c.key.startsWith("POST"))!.body.content_html).toContain("<code>code</code>");
  });
});

describe("envelope extras", () => {
  it("--jq filters the envelope and prints strings raw", async () => {
    const { code, out } = await exec(["projects", "--jq", ".data[].name"], { "GET /api/v1/acme/projects": [{ id: "a", name: "Website" }, { id: "b", name: "Mobile" }] });
    expect(code).toBe(0);
    expect(out).toEqual(["Website", "Mobile"]);
    const obj = await exec(["projects", "--jq", "{n: (.data | length)}"], { "GET /api/v1/acme/projects": [{ id: "a", name: "Website" }] });
    expect(obj.out).toEqual(['{"n":1}']);
    const bad = await exec(["projects", "--jq", ".data |"], { "GET /api/v1/acme/projects": [] });
    expect(bad.code).toBe(EXIT_CODES.usage);
    expect(bad.error.error).toContain("jq");
  });

  it("errors carry retryable: true for 429 and false for 404", async () => {
    const limited = await exec(["show", REC], {
      [`GET /api/v1/acme/recordings/${REC}`]: () =>
        new Response(JSON.stringify({ error: { code: "rate_limit", message: "slow down" } }), { status: 429, headers: { "retry-after": "0" } }),
    });
    expect(limited.code).toBe(EXIT_CODES.rate_limit);
    expect(limited.error.retryable).toBe(true);
    const missing = await exec(["show", REC]);
    expect(missing.code).toBe(EXIT_CODES.not_found);
    expect(missing.error.retryable).toBe(false);
  });

  it("api passes any route through, org-relative by default", async () => {
    const rel = await exec(["api", "GET", "my/cheers", "--query", "since=2026-09-01T00:00:00Z"], { "GET /api/v1/acme/my/cheers": { received: [], given: [] } });
    expect(rel.code).toBe(0);
    expect(rel.calls.some((c) => c.key === "GET /api/v1/acme/my/cheers?since=2026-09-01T00%3A00%3A00Z")).toBe(true);
    const abs = await exec(["api", "get", "/authorization"]);
    expect(abs.envelope.data.scope).toBe("full");
    const post = await exec(["api", "POST", `recordings/${REC}/cheers`, "--body", '{"content":"👍"}'], { [`POST /api/v1/acme/recordings/${REC}/cheers`]: { id: "c" } });
    expect(post.calls.find((c) => c.key.startsWith("POST"))?.body).toEqual({ content: "👍" });
  });

  it("doctor --json reports reachability and whoami with membership_kind", async () => {
    const { code, envelope } = await exec(["doctor", "--json"]);
    expect(code).toBe(0);
    const names = envelope.data.checks.map((c: { check: string }) => c.check);
    expect(names).toEqual(expect.arrayContaining(["node", "reach", "token", "api", "org", "whoami"]));
    expect(envelope.data.whoami.membership_kind).toBe("person");
    expect(envelope.data.whoami.membership_id).toBe(ME);
  });

  it("skill install drops both skills; setup claude reports the plugin manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thicket-skills-"));
    const installed = await exec(["skill", "install", "--dir", dir]);
    expect(installed.code).toBe(0);
    expect(readFileSync(join(dir, "thicket-cli", "SKILL.md"), "utf8")).toContain("name: thicket-cli");
    expect(readFileSync(join(dir, "thicket-connect", "SKILL.md"), "utf8")).toContain("name: thicket-connect");
    const setup = await exec(["setup", "claude", "--dir", dir]);
    expect(setup.code).toBe(0);
    expect(setup.envelope.data.plugin.present).toBe(true);
    expect(setup.envelope.data.claude.register_commands).toEqual([
      "claude plugin marketplace add thicket-hq/thicket-cli",
      "claude plugin install thicket@thicket-hq",
    ]);
  });
});
