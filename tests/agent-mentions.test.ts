// Mentions written by a named agent: it can't read the org's people, so a
// bare @name resolves among the people of the project the comment, message
// or chat line is in, and an agent's chat line never carries a mention.
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { EXIT_CODES } from "../src/lib/output.js";
import { AGENT, JANE, JASON, P1, agentThicket, apiError, capture, cleanup, connectedAgent, environment, json, type Call } from "./agent-fixtures.js";

afterEach(() => cleanup());

const CARD = "dddddddd-0000-4000-8000-0000000000ca";
const NOTE = "dddddddd-0000-4000-8000-0000000000e0";
const MESSAGE = "dddddddd-0000-4000-8000-0000000000aa";
const CHAT = "dddddddd-0000-4000-8000-0000000000c4";
const JAKE = "aaaaaaaa-0000-4000-8000-0000000000a9";
const PROJECT_PEOPLE = [
  { membership_id: JASON, name: "Jason Hanschell", role: "owner" },
  { membership_id: JANE, name: "Jane Doe", role: "member" },
  { membership_id: JAKE, name: "Jake Smith", role: "member" },
  { membership_id: AGENT, name: "Helper", role: "member" },
];

function thicket(options: { projectPeople?: () => Response } = {}) {
  return agentThicket({
    routes: [
      (call: Call) => {
        if (call.path === "/api/v1/acme/people") return apiError(403, "agent_forbidden", "Agents can't list people");
        if (call.path === `/api/v1/acme/projects/${P1}/people`) return options.projectPeople?.() ?? json(PROJECT_PEOPLE);
        if (call.path === `/api/v1/acme/recordings/${CARD}` && call.method === "GET") return json({ id: CARD, type: "card", title: "Card", project_id: P1 });
        if (call.path === `/api/v1/acme/recordings/${NOTE}` && call.method === "GET") return json({ id: NOTE, type: "dm", title: null, project_id: null });
        if (call.path === `/api/v1/acme/projects/${P1}/tools`) return json([{ tool: "chat", enabled: true, container_id: CHAT }]);
        if (call.method === "POST" && /\/recordings\/[^/]+\/(comments|children)$/.test(call.path)) return json({ id: "posted" }, 201);
        if (call.method === "PATCH") return json({ id: MESSAGE, title: "Plan" });
        return undefined;
      },
    ],
  });
}

async function asAgent(argv: string[], t = thicket()) {
  const env = environment(); await connectedAgent(env);
  const io = capture();
  const code = await run([...argv, "--profile", "helper", "--json"], { env, fetch: t.transport, isTty: false, write: io.write, writeErr: io.writeErr });
  const posted = t.calls.filter((c) => c.method === "POST" && /\/(comments|children)$/.test(c.path));
  return { code, ...io, calls: t.calls, posted };
}

const asked = (calls: Call[], path: string) => calls.some((c) => c.path === path);

describe("an agent's comments and messages", () => {
  it("resolves a bare @name among the project's people, never reading the org's people", async () => {
    const result = await asAgent(["comment", CARD, "Done, @Jane. Thanks @Jason.Hanschell"]);
    expect(result.code).toBe(0);
    const html = String(result.posted[0].body.content_html);
    expect(html).toContain(`<span data-mention-id="${JANE}">@Jane Doe</span>`);
    expect(html).toContain(`<span data-mention-id="${JASON}">@Jason Hanschell</span>`);
    expect(asked(result.calls, `/api/v1/acme/projects/${P1}/people`)).toBe(true);
    expect(asked(result.calls, "/api/v1/acme/people")).toBe(false);
  });

  it("takes the project from a pasted link without reading the recording", async () => {
    const result = await asAgent(["comment", `https://www.thickethq.com/o/acme/projects/${P1}/cards/${CARD}`, "@Jane look"]);
    expect(result.code).toBe(0);
    expect(String(result.posted[0].body.content_html)).toContain(`data-mention-id="${JANE}"`);
    expect(result.calls.some((c) => c.method === "GET" && c.path === `/api/v1/acme/recordings/${CARD}`)).toBe(false);
  });

  it("keeps the ambiguous and no-match rules: ambiguity is an error, a miss stays plain text", async () => {
    const ambiguous = await asAgent(["comment", CARD, "@Ja look"]);
    expect(ambiguous.code).toBe(EXIT_CODES.ambiguous);
    expect(ambiguous.error().error).toContain("Jane Doe");
    expect(ambiguous.error().error).toContain("Jake Smith");
    expect(ambiguous.posted).toEqual([]);
    const miss = await asAgent(["comment", CARD, "@Nobody look"]);
    expect(miss.code).toBe(0);
    expect(String(miss.posted[0].body.content_html)).toBe("<p>@Nobody look</p>");
  });

  it("leaves bare names as plain text with no project, or when the project's people can't be read", async () => {
    const noProject = await asAgent(["comment", NOTE, "@Jane look"]);
    expect(noProject.code).toBe(0);
    expect(String(noProject.posted[0].body.content_html)).toBe("<p>@Jane look</p>");
    expect(noProject.calls.some((c) => c.path.endsWith("/people"))).toBe(false);
    const refused = await asAgent(["comment", CARD, "@Jane look"], thicket({ projectPeople: () => apiError(403, "agent_forbidden") }));
    expect(refused.code).toBe(0);
    expect(String(refused.posted[0].body.content_html)).toBe("<p>@Jane look</p>");
  });

  it("a pinned [@Name](member:<id>) token is sent as it always was", async () => {
    const result = await asAgent(["comment", NOTE, `Failed, [@Jane Doe](member:${JANE})`]);
    expect(result.code).toBe(0);
    expect(String(result.posted[0].body.content_html)).toContain(`<span data-mention-id="${JANE}">@Jane Doe</span>`);
  });

  it("a message edit resolves in the message's project", async () => {
    const t = thicket();
    const result = await asAgent(["messages", "update", CARD, "--content", "Over to @Jane"], t);
    expect(result.code).toBe(0);
    const patch = result.calls.find((c) => c.method === "PATCH")!;
    expect(String(patch.body.content_html)).toContain(`data-mention-id="${JANE}"`);
  });
});

describe("an agent's chat lines", () => {
  it("refuse any mention before sending, pinned or resolved, Markdown or HTML", async () => {
    for (const text of [`hi [@Jane Doe](member:${JANE})`, "hi @Jane"]) {
      const result = await asAgent(["chat", "post", text, "--in", P1]);
      expect(result.code).toBe(EXIT_CODES.usage);
      expect(result.error().error).toContain("can't mention anyone");
      expect(result.posted).toEqual([]);
    }
    const html = await asAgent(["chat", "post", `<p><span data-mention-id="${JANE}">@Jane Doe</span></p>`, "--html", "--in", P1]);
    expect(html.code).toBe(EXIT_CODES.usage);
    expect(html.posted).toEqual([]);
  });

  it("post a line whose @ is no one, a quoted token, or plain text", async () => {
    const miss = await asAgent(["chat", "post", "ping @Nobody", "--in", P1]);
    expect(miss.code).toBe(0);
    expect(miss.posted[0].body).toMatchObject({ type: "chat_message", content_html: "<p>ping @Nobody</p>" });
    const quoted = await asAgent(["chat", "post", `the token is \`[@Jane Doe](member:${JANE})\``, "--in", P1]);
    expect(quoted.code).toBe(0);
    const plain = await asAgent(["chat", "post", "thanks Jane", "--plain", "--in", P1]);
    expect(plain.code).toBe(0);
    expect(plain.posted[0].body).toMatchObject({ type: "chat_message", content: "thanks Jane" });
  });

  it("the raw API refuses an agent's chat line that carries a mention, and passes a person's through", async () => {
    const line = JSON.stringify({ type: "chat_message", content_html: `<p><span data-mention-id="${JANE}">@Jane Doe</span> hi</p>` });
    const agent = await asAgent(["api", "POST", `recordings/${CHAT}/children`, "--body", line]);
    expect(agent.code).toBe(EXIT_CODES.usage);
    expect(agent.posted).toEqual([]);
    const fine = await asAgent(["api", "POST", `recordings/${CHAT}/children`, "--body", JSON.stringify({ type: "chat_message", content: "hi Jane" })]);
    expect(fine.code).toBe(0);

    const t = thicket();
    const io = capture();
    const code = await run(["api", "POST", `recordings/${CHAT}/children`, "--body", line, "--json"], {
      env: { ...environment(), THICKET_TOKEN: `thicket_pat_${JASON}` }, fetch: t.transport, isTty: false, write: io.write, writeErr: io.writeErr,
    });
    expect(code).toBe(0);
    expect(t.calls.some((c) => c.method === "POST" && c.path.endsWith("/children"))).toBe(true);
  });
});

describe("a person's mentions", () => {
  it("still resolve against the org's people, in chat too", async () => {
    const t = agentThicket({ routes: [(call) => {
      if (call.path === "/api/v1/acme/people") return json([{ membership_id: JANE, name: "Jane Doe", email: "jane@acme.test", role: "member" }]);
      if (call.path === `/api/v1/acme/projects/${P1}/tools`) return json([{ tool: "chat", enabled: true, container_id: CHAT }]);
      if (call.method === "POST") return json({ id: "posted" }, 201);
      return undefined;
    }] });
    const io = capture();
    const code = await run(["chat", "post", "hi @Jane", "--in", P1, "--json"], {
      env: { ...environment(), THICKET_TOKEN: `thicket_pat_${JASON}` }, fetch: t.transport, isTty: false, write: io.write, writeErr: io.writeErr,
    });
    expect(code).toBe(0);
    const post = t.calls.find((c) => c.method === "POST")!;
    expect(String(post.body.content_html)).toContain(`data-mention-id="${JANE}"`);
    expect(t.calls.some((c) => c.path.endsWith(`/projects/${P1}/people`))).toBe(false);
  });
});
