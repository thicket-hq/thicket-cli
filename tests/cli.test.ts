// End-to-end through run() with an injected fetch: envelope shapes, output
// modes, exit codes, catalog parity, agent help. No network, no keyring —
// tokens ride THICKET_TOKEN and config rides THICKET_CONFIG_DIR.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allCommands, run } from "../src/cli.js";
import { EXIT_CODES } from "../src/lib/output.js";
import { catalogEntry } from "../src/lib/registry.js";

const AUTH_DOC = {
  identity: { id: "user-1" },
  organizations: [
    {
      id: "org-1",
      name: "Acme",
      slug: "acme",
      href: "http://localhost:9999/api/v1/acme",
      membership_id: "1e6b3cbb-0000-4000-8000-0000000000aa",
      role: "owner",
    },
  ],
  scope: "full",
  expires_at: null,
};

const PROJECTS = [
  { id: "1e6b3cbb-0000-4000-8000-000000000001", name: "Website", description: "d", starred: false },
  { id: "1e6b3cbb-0000-4000-8000-000000000002", name: "Mobile", description: "", starred: true },
];

function fakeFetch(
  routes: Record<string, unknown | ((init?: RequestInit) => unknown)>,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    if (key in routes) {
      const value = routes[key];
      const body = typeof value === "function" ? (value as (i?: RequestInit) => unknown)(init) : value;
      return new Response(JSON.stringify(body), {
        status: (init?.method ?? "GET") === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ error: { code: "not_found", message: `no route ${key}` } }),
      { status: 404 },
    );
  }) as typeof globalThis.fetch;
}

type Captured = { out: string[]; err: string[] };

async function exec(
  argv: string[],
  routes: Record<string, unknown> = {},
  envExtra: NodeJS.ProcessEnv = {},
): Promise<{ code: number } & Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const env: NodeJS.ProcessEnv = {
    THICKET_CONFIG_DIR: mkdtempSync(join(tmpdir(), "thicket-cli-run-")),
    THICKET_TOKEN: "thicket_pat_test",
    THICKET_BASE_URL: "http://localhost:9999",
    ...envExtra,
  };
  const code = await run(argv, {
    env,
    fetch: fakeFetch({
      "GET /api/v1/authorization": AUTH_DOC,
      ...routes,
    }),
    isTty: false,
    write: (line) => out.push(line),
    writeErr: (line) => err.push(line),
  });
  return { code, out, err };
}

describe("envelope and modes", () => {
  it("piped success is a JSON envelope with breadcrumbs", async () => {
    const { code, out } = await exec(["projects"], {
      "GET /api/v1/acme/projects": PROJECTS,
    });
    expect(code).toBe(0);
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toHaveLength(2);
    expect(envelope.summary).toBe("2 active projects");
    expect(envelope.breadcrumbs.length).toBeGreaterThan(0);
    expect(envelope.breadcrumbs[0].cmd).toContain("thicket");
  });

  it("--agent is data-only", async () => {
    const { code, out } = await exec(["projects", "--agent"], {
      "GET /api/v1/acme/projects": PROJECTS,
    });
    expect(code).toBe(0);
    const data = JSON.parse(out.join("\n"));
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
  });

  it("--ids-only and --count", async () => {
    const ids = await exec(["projects", "--ids-only"], {
      "GET /api/v1/acme/projects": PROJECTS,
    });
    expect(ids.out).toEqual(PROJECTS.map((p) => p.id));
    const count = await exec(["projects", "--count"], {
      "GET /api/v1/acme/projects": PROJECTS,
    });
    expect(count.out).toEqual(["2"]);
  });

  it("API errors map to structured envelopes and stable exit codes", async () => {
    const { code, err } = await exec(["show", "1e6b3cbb-0000-4000-8000-000000000009"]);
    expect(code).toBe(EXIT_CODES.not_found);
    const envelope = JSON.parse(err.join("\n"));
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("not_found");
  });

  it("missing token is an auth error with a login hint", async () => {
    const { code, err } = await exec(["projects"], {}, { THICKET_TOKEN: "" });
    expect(code).toBe(EXIT_CODES.auth);
    const envelope = JSON.parse(err.join("\n"));
    expect(envelope.code).toBe("auth");
    expect(envelope.hint).toContain("thicket auth login");
  });

  it("usage errors exit 2 in the house format", async () => {
    const { code, err } = await exec(["projects", "show"]);
    expect(code).toBe(EXIT_CODES.usage);
    const envelope = JSON.parse(err.join("\n"));
    expect(envelope.code).toBe("usage");
  });

  it("multi-org without --org is ambiguous with a hint", async () => {
    const twoOrgs = {
      ...AUTH_DOC,
      organizations: [
        AUTH_DOC.organizations[0],
        { ...AUTH_DOC.organizations[0], id: "org-2", slug: "beta", name: "Beta" },
      ],
    };
    const { code, err } = await exec(["projects"], {
      "GET /api/v1/authorization": twoOrgs,
    });
    expect(code).toBe(EXIT_CODES.ambiguous);
    const envelope = JSON.parse(err.join("\n"));
    expect(envelope.code).toBe("ambiguous");
    expect(envelope.hint).toContain("thicket orgs use");
  });
});

describe("writes through the fake transport", () => {
  it("todo add resolves project, list, and me", async () => {
    let created: Record<string, unknown> | null = null;
    const { code, out } = await exec(
      [
        "todo",
        "Ship it",
        "--in",
        "Website",
        "--list",
        "Launch",
        "--due",
        "2026-09-01",
        "--assignee",
        "me",
      ],
      {
        "GET /api/v1/acme/projects": PROJECTS,
        "GET /api/v1/acme/projects/1e6b3cbb-0000-4000-8000-000000000001/tools": [
          { tool: "todos", label: "To-dos", enabled: true, container_id: "1e6b3cbb-0000-4000-8000-0000000000c1" },
        ],
        "GET /api/v1/acme/recordings/1e6b3cbb-0000-4000-8000-0000000000c1/children": [
          { id: "1e6b3cbb-0000-4000-8000-0000000000l1", title: "Launch" },
        ],
        "POST /api/v1/acme/recordings/1e6b3cbb-0000-4000-8000-0000000000l1/children": (
          init?: RequestInit,
        ) => {
          created = JSON.parse(String(init?.body));
          return { id: "new-todo", title: "Ship it", due_on: "2026-09-01" };
        },
      },
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope.ok).toBe(true);
    expect(created).toMatchObject({
      type: "todo",
      title: "Ship it",
      due_on: "2026-09-01",
      assignee_ids: ["1e6b3cbb-0000-4000-8000-0000000000aa"],
    });
  });
});

describe("self-description", () => {
  it("commands --json emits the full catalog", async () => {
    const { code, out } = await exec(["commands", "--json"]);
    expect(code).toBe(0);
    const envelope = JSON.parse(out.join("\n"));
    const names = envelope.data.commands.map((c: { name: string }) => c.name);
    expect(names).toContain("projects list");
    expect(names).toContain("todo");
    expect(names).toContain("auth login");
    expect(names).toContain("commands");
    expect(envelope.data.global_flags.length).toBeGreaterThan(5);
  });

  it("--agent --help returns the matched command's structured spec", async () => {
    const { code, out } = await exec(["todos", "add", "--agent", "--help"]);
    expect(code).toBe(0);
    const spec = JSON.parse(out.join("\n"));
    expect(spec.name).toBe("todos add");
    expect(spec.usage).toContain("thicket todos add");
    expect(spec.flags.some((f: { flag: string }) => f.flag.includes("--due"))).toBe(true);
    expect(spec.global_flags).toBeDefined();
  });

  it("catalog ↔ registry parity: every spec is unique and well-formed", () => {
    const specs = allCommands();
    const names = specs.map((s) => s.path.join(" "));
    expect(new Set(names).size).toBe(names.length);
    for (const spec of specs) {
      const entry = catalogEntry(spec);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.usage.startsWith("thicket ")).toBe(true);
    }
  });

  it("version and help exit 0", async () => {
    expect((await exec(["--version"])).code).toBe(0);
    expect((await exec(["--help"])).code).toBe(0);
  });
});
