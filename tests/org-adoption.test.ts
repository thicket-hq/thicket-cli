// Every command that takes a link reads it before it scopes the org
// (docs/org-key-plan-2026-10-21.md D9): a pasted link's workspace is the one
// the command acts in, whatever the saved default, and a link that --org
// contradicts is refused before any request reaches either workspace.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { EXIT_CODES } from "../src/lib/output.js";

const HOST = "http://localhost:9999";
const ME = "1e6b3cbb-0000-4000-8000-0000000000aa";
const org = (id: string, name: string, slug: string, key: string) => ({
  id, name, slug, key, href: `${HOST}/api/v1/${slug}`, membership_id: ME, role: "owner", membership_kind: "person",
});
const AUTH_DOC = {
  identity: { id: "user-1" },
  organizations: [org("org-1", "Acme", "acme-ab12cd34", "ab12cd34"), org("org-2", "Beta", "beta-Xy9Qz", "qwerty12")],
  scope: "full",
  expires_at: null,
};

const PROJECT = "1e6b3cbb-0000-4000-8000-000000000001";
const ID = "1e6b3cbb-0000-4000-8000-0000000000c9";
const LINK = `https://www.thickethq.com/o/beta-Xy9Qz/projects/${PROJECT}/cards/1e6b3cbb-0000-4000-8000-0000000000e1`;
const PROJECT_LINK = `https://www.thickethq.com/o/beta-Xy9Qz/projects/${PROJECT}`;

const COMMANDS: string[][] = [
  ["show", LINK],
  ["comments", LINK],
  ["comments", "thread", LINK],
  ["comment", LINK, "Looks good"],
  ["subscriptions", "add", LINK],
  ["cheer", LINK, "👍"],
  ["cheers", "on", LINK],
  ["trash", LINK],
  ["archive", LINK],
  ["restore", LINK],
  ["url", "of", LINK],
  ["assign", LINK, "me"],
  ["done", LINK],
  ["reopen", LINK],
  ["todos", "show", LINK],
  ["todos", "update", LINK, "--title", "Renamed"],
  ["messages", "show", LINK],
  ["messages", "update", LINK, "--title", "Renamed"],
  ["messages", "pin", LINK],
  ["docs", "show", LINK],
  ["docs", "update", LINK, "--title", "Renamed"],
  ["cards", "show", LINK],
  ["cards", "move", LINK, "--to", ID],
  ["chat", "line", LINK],
  ["timesheet", "log", LINK, "--hours", "1"],
  ["projects", "show", PROJECT_LINK],
  ["projects", "archive", PROJECT_LINK],
  ["todos", "--in", PROJECT_LINK],
  ["todos", "--in", PROJECT_LINK, "--list", ID],
  ["todo", "Ship it", "--in", PROJECT_LINK],
  ["todo", "Ship it", "--in", PROJECT_LINK, "--list", ID],
  ["todolists", "--in", PROJECT_LINK],
  ["todolists", "create", "Launch", "--in", PROJECT_LINK],
  ["messages", "--in", PROJECT_LINK],
  ["message", "Plan", "--in", PROJECT_LINK],
  ["files", "--in", PROJECT_LINK],
  ["docs", "--in", PROJECT_LINK],
  ["docs", "create", "Notes", "--in", PROJECT_LINK],
  ["cards", "--in", PROJECT_LINK],
  ["cards", "--in", PROJECT_LINK, "--column", ID],
  ["cards", "columns", "--in", PROJECT_LINK],
  ["card", "Bug", "--in", PROJECT_LINK, "--column", ID],
  ["chat", "post", "Hello", "--in", PROJECT_LINK],
  ["chat", "history", "--in", PROJECT_LINK],
  ["search", "plan", "--project", PROJECT_LINK],
  ["activity", "--project", PROJECT_LINK],
  ["timesheet", "report", "--project", PROJECT_LINK],
  ["timesheet", "log", "--project", PROJECT_LINK, "--hours", "1"],
];
const cases = COMMANDS.map((argv) => [
  argv.map((a) => (a === LINK ? "<link>" : a === PROJECT_LINK ? "<project link>" : a)).join(" "),
  argv,
] as const);

/** Runs the CLI against a transport that knows only /authorization, recording every path it is asked for. */
async function exec(argv: string[], envExtra: NodeJS.ProcessEnv = {}) {
  const paths: string[] = [];
  const err: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    paths.push(pathname);
    const [status, body] = pathname === "/api/v1/authorization"
      ? [200, AUTH_DOC]
      : [404, { error: { code: "not_found", message: `no route ${pathname}` } }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const code = await run(argv, {
    env: {
      THICKET_CONFIG_DIR: mkdtempSync(join(tmpdir(), "thicket-cli-adopt-")),
      THICKET_TOKEN_STORE: "file",
      THICKET_TOKEN: "thicket_pat_test",
      THICKET_BASE_URL: HOST,
      ...envExtra,
    },
    fetch: fetchImpl,
    isTty: false,
    write: () => {},
    writeErr: (line) => err.push(line),
  });
  return { code, paths, err };
}

describe("a pasted link names the workspace the command acts in", () => {
  it.each(cases)("%s", async (_, argv) => {
    const { paths } = await exec([...argv], { THICKET_ORG: "acme-ab12cd34" });
    expect(paths.some((p) => p.startsWith("/api/v1/beta-Xy9Qz/"))).toBe(true);
    expect(paths.filter((p) => p.startsWith("/api/v1/acme-ab12cd34/"))).toEqual([]);
  });
});

describe("--org naming another workspace refuses the link before any request to either", () => {
  it.each(cases)("%s", async (_, argv) => {
    const { code, err, paths } = await exec([...argv, "--org", "acme-ab12cd34"]);
    expect(code).toBe(EXIT_CODES.usage);
    expect(JSON.parse(err.join("\n")).error).toBe('That URL belongs to "beta-Xy9Qz" but --org says "acme-ab12cd34"');
    expect(paths.filter((p) => p !== "/api/v1/authorization")).toEqual([]);
  });
});
