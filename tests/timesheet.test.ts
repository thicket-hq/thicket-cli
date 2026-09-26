// The timesheet group end to end through run() with a fake transport: the
// report and its raw CSV, logging on an item, a repeating event's day, the
// project and absence, edit, the --yes gate on delete, the week grid,
// submit, approvals, and the server's refusals with their hints.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { lastMonth } from "../src/commands/timesheet.js";
import { parseDate } from "../src/lib/dates.js";
import { EXIT_CODES } from "../src/lib/output.js";

const ME = "1e6b3cbb-0000-4000-8000-0000000000aa";
const JANE = "1e6b3cbb-0000-4000-8000-0000000000bb";
const BOB = "1e6b3cbb-0000-4000-8000-0000000000cc";
const PROJECT = "1e6b3cbb-0000-4000-8000-000000000001";
const LIST = "1e6b3cbb-0000-4000-8000-00000000a151";
const TODO = "1e6b3cbb-0000-4000-8000-00000000d0d0";
const EVENT = "1e6b3cbb-0000-4000-8000-00000000e7e7";
const SHEET = "1e6b3cbb-0000-4000-8000-00000000c5c5";
const ENTRY = "1e6b3cbb-0000-4000-8000-00000000e001";
const ENTRY2 = "1e6b3cbb-0000-4000-8000-00000000e002";
const ENTRY3 = "1e6b3cbb-0000-4000-8000-00000000e003";
const VACATION = "1e6b3cbb-0000-4000-8000-00000000fac0";
const SICK = "1e6b3cbb-0000-4000-8000-00000000fac1";
const APP = "https://www.thickethq.com/o/acme";

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
];

const person = (membership_id: string, name: string) => ({ membership_id, name, image: null });
const WEBSITE = { id: PROJECT, name: "Website" };
const TODO_PARENT = { id: TODO, type: "todo", title: "Fix the header", app_url: `${APP}/projects/${PROJECT}/todos/${LIST}/${TODO}` };
const SHEET_PARENT = { id: SHEET, type: "timesheet", title: "Timesheet", app_url: `${APP}/projects/${PROJECT}/timesheet` };

function entry(over: Record<string, unknown> = {}) {
  return {
    id: ENTRY,
    type: "timesheet_entry",
    date: "2026-09-22",
    hours: "1.5",
    description: "Header fix",
    person: person(ME, "Jason Hanschell"),
    creator: person(ME, "Jason Hanschell"),
    project: WEBSITE,
    parent: TODO_PARENT,
    occurrence_date: null,
    absence_type: null,
    created_at: "2026-09-22T17:00:00.000Z",
    updated_at: "2026-09-22T17:00:00.000Z",
    ...over,
  };
}

const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

const APPROVAL = {
  person: person(ME, "Jason Hanschell"),
  week_start: "2026-09-21",
  week_end: "2026-09-27",
  status: "changed",
  changed_since: "approval",
  submitted_at: "2026-09-25T17:00:00.000Z",
  submitted_by: person(ME, "Jason Hanschell"),
  decided_at: "2026-09-25T18:00:00.000Z",
  decided_by: person(JANE, "Jane Doe"),
  self_approved: false,
  rejection_reason: null,
};

const WEEK = {
  person: person(ME, "Jason Hanschell"),
  week_start: "2026-09-21",
  week_end: "2026-09-27",
  week_starts_on: "monday",
  days: DAYS,
  writable: true,
  approvals_enabled: true,
  status: "changed",
  approval: APPROVAL,
  total_hours: "10.0",
  rows: [
    { recording_id: SHEET, occurrence_date: null, project: WEBSITE, item: null, added: false, can_log: true, can_edit: true, closed_reason: null },
    { recording_id: TODO, occurrence_date: null, project: WEBSITE, item: { id: TODO, type: "todo", title: "Fix the header", app_url: TODO_PARENT.app_url }, added: true, can_log: true, can_edit: true, closed_reason: null },
  ],
  absence_types: [{ id: VACATION, name: "Vacation", archived: false, can_log: true }],
  projects: [WEBSITE],
  entries: [
    entry({ id: ENTRY3, date: "2026-09-23", hours: "8.0", project: null, parent: null, absence_type: { id: VACATION, name: "Vacation" }, description: null }),
    entry({ id: ENTRY }),
    entry({ id: ENTRY2, hours: "0.5", parent: SHEET_PARENT, description: null }),
  ],
};

function approvalRow(membershipId: string, name: string, weekStart: string, status: string, hours: string, over: Record<string, unknown> = {}) {
  return {
    ...APPROVAL,
    person: person(membershipId, name),
    week_start: weekStart,
    week_end: DAYS[6],
    status,
    changed_since: null,
    decided_by: null,
    hours,
    removed: false,
    ...over,
  };
}

const APPROVALS = {
  week_start: "2026-09-21",
  week_end: "2026-09-27",
  week_starts_on: "monday",
  weeks: [
    approvalRow(JANE, "Jane Doe", "2026-09-21", "submitted", "32.5"),
    approvalRow(ME, "Jason Hanschell", "2026-09-21", "approved", "40.0", { self_approved: true }),
  ],
  without_time: [person(BOB, "Bob Smith")],
  waiting: [approvalRow(JANE, "Jane Doe", "2026-09-14", "changed", "30.0", { week_end: "2026-09-20", changed_since: "submission" })],
  counts: { not_submitted: 0, submitted: 1, approved: 1, changed: 0, rejected: 0 },
  all_approved: false,
};

const TYPES = [
  { id: VACATION, name: "Vacation", position: 1, archived: false, archived_at: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { id: SICK, name: "Sick leave", position: 2, archived: false, archived_at: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
];

type Handler = (url: URL, init?: RequestInit) => unknown;
type Routes = Record<string, unknown | Handler>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = { method: string; path: string; query: URLSearchParams; accept?: string; body?: any };

function refusal(status: number, code: string, message: string): Handler {
  return () =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function fakeFetch(routes: Routes, calls: Call[]): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    if (key !== "GET /api/v1/authorization" && key !== "GET /api/v1/acme/people") {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, path: url.pathname, query: url.searchParams, accept: headers.accept, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    }
    if (key in routes) {
      const value = routes[key];
      const result = typeof value === "function" ? (value as Handler)(url, init) : value;
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        status: method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: `no route ${key}` } }), { status: 404 });
  }) as typeof globalThis.fetch;
}

async function exec(argv: string[], routes: Routes = {}, opts: { isTty?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const code = await run(argv, {
    env: {
      THICKET_CONFIG_DIR: mkdtempSync(join(tmpdir(), "thicket-cli-timesheet-")),
      THICKET_TOKEN_STORE: "file",
      THICKET_TOKEN: "thicket_pat_test",
      THICKET_BASE_URL: "http://localhost:9999",
    },
    fetch: fakeFetch({ "GET /api/v1/authorization": AUTH_DOC, "GET /api/v1/acme/people": PEOPLE, ...routes }, calls),
    isTty: opts.isTty ?? false,
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
  return { code, out, err, calls, envelope: parse(out), error: parse(err) };
}

describe("timesheet report", () => {
  it("passes the filters, totals the hours, and suggests the CSV", async () => {
    const { code, envelope, calls } = await exec(
      [
        "timesheet", "report",
        "--from", "2026-09-01", "--to", "2026-09-30",
        "--person", "Jane",
        "--project", `${APP}/projects/${PROJECT}/todos/${LIST}/${TODO}`,
        "--status", "submitted",
      ],
      {
        "GET /api/v1/acme/reports/timesheet": [
          entry({ hours: "2.5", person: person(JANE, "Jane Doe") }),
          entry({ id: ENTRY2, hours: "1.5", person: person(JANE, "Jane Doe"), parent: SHEET_PARENT }),
        ],
      },
    );
    expect(code).toBe(0);
    const q = calls[0].query;
    expect(q.get("start_date")).toBe("2026-09-01");
    expect(q.get("end_date")).toBe("2026-09-30");
    expect(q.get("person_id")).toBe(JANE);
    expect(q.get("project_id")).toBe(PROJECT);
    expect(q.get("status")).toBe("submitted");
    expect(envelope.data).toHaveLength(2);
    expect(envelope.summary).toBe("4 hours across 2 entries, 2026-09-01 to 2026-09-30, submitted");
    expect(envelope.breadcrumbs[0].cmd).toContain("--csv");
    expect(envelope.breadcrumbs[0].cmd).toContain(`--person ${JANE}`);
  });

  it("defaults to the last month, ending today", async () => {
    const { code, envelope, calls } = await exec(["timesheet", "report"], {
      "GET /api/v1/acme/reports/timesheet": [entry({ hours: "1.0" })],
    });
    expect(code).toBe(0);
    const range = lastMonth(parseDate("today"));
    expect(calls[0].query.get("start_date")).toBe(range.from);
    expect(calls[0].query.get("end_date")).toBe(range.to);
    expect(envelope.summary).toBe(`1 hour across 1 entry, ${range.from} to ${range.to}`);
  });

  it("lastMonth clamps to the shorter month", () => {
    expect(lastMonth("2026-03-31")).toEqual({ from: "2026-02-28", to: "2026-03-31" });
    expect(lastMonth("2026-01-15")).toEqual({ from: "2025-12-15", to: "2026-01-15" });
  });

  it("--csv prints the export itself, unwrapped, whatever the output mode", async () => {
    const csv = "Date,Person,Hours,Project,Item,Notes,Created\n2026-09-22,Jane Doe,2.5,Website,To-do: Fix the header,,2026-09-22T17:00:00Z\n";
    const { code, out, calls } = await exec(["timesheet", "report", "--from", "2026-09-01", "--to", "2026-09-30", "--csv", "--json"], {
      "GET /api/v1/acme/reports/timesheet/csv": () => new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } }),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toBe(csv.replace(/\n$/, ""));
    expect(calls[0].accept).toBe("text/csv");
    expect(calls[0].query.get("start_date")).toBe("2026-09-01");
  });

  it("refuses --csv with --jq, half a range, and an unknown status", async () => {
    const jq = await exec(["timesheet", "report", "--csv", "--jq", ".data"]);
    expect(jq.code).toBe(EXIT_CODES.usage);
    const half = await exec(["timesheet", "report", "--from", "2026-09-01"]);
    expect(half.code).toBe(EXIT_CODES.usage);
    expect(half.error.error).toContain("together");
    const status = await exec(["timesheet", "report", "--status", "rejected"]);
    expect(status.code).toBe(EXIT_CODES.usage);
    expect(status.error.hint).toContain("not_submitted");
    const noProject = await exec(["timesheet", "report", "--project", `${APP}/calendar/${EVENT}`]);
    expect(noProject.code).toBe(EXIT_CODES.usage);
    expect(noProject.error.error).toContain("names no project");
    expect([...jq.calls, ...half.calls, ...status.calls, ...noProject.calls]).toEqual([]);
  });

  it("a client gets not_found, as from every timesheet route", async () => {
    const { code, error } = await exec(["timesheet", "report"], {
      "GET /api/v1/acme/reports/timesheet": refusal(404, "not_found", "Not found"),
    });
    expect(code).toBe(EXIT_CODES.not_found);
    expect(error.code).toBe("not_found");
    expect(error.api_code).toBe("not_found");
  });
});

describe("timesheet log", () => {
  it("logs on an item by URL, taking a repeating event's day from ?occurrence=", async () => {
    const { code, envelope, calls } = await exec(
      ["timesheet", "log", `${APP}/projects/${PROJECT}/calendar/${EVENT}?occurrence=2026-09-22`, "--hours", "1:30", "--date", "2026-09-22", "--notes", "Standup"],
      {
        [`POST /api/v1/acme/recordings/${EVENT}/timesheet/entries`]: entry({
          parent: { id: EVENT, type: "calendar_event", title: "Standup", app_url: `${APP}/projects/${PROJECT}/calendar/${EVENT}?occurrence=2026-09-22` },
          occurrence_date: "2026-09-22",
          description: "Standup",
        }),
      },
    );
    expect(code).toBe(0);
    expect(calls[0].body).toEqual({ date: "2026-09-22", hours: "1:30", description: "Standup", occurrence: "2026-09-22" });
    expect(envelope.summary).toBe('Logged 1.5 hours on "Standup", 2026-09-22');
    expect(envelope.breadcrumbs.map((b: { cmd: string }) => b.cmd)).toContain(`thicket timesheet delete ${ENTRY} --yes`);
  });

  it("--occurrence names the day for an event id, and dates look back", async () => {
    const { code, calls } = await exec(
      ["timesheet", "log", EVENT, "--hours", "1", "--occurrence", "2026-09-29", "--date", "-1"],
      { [`POST /api/v1/acme/recordings/${EVENT}/timesheet/entries`]: entry() },
    );
    expect(code).toBe(0);
    expect(calls[0].body).toEqual({ date: parseDate("yesterday"), hours: "1", occurrence: "2026-09-29" });
  });

  it("logs on the project itself, for someone else", async () => {
    const { code, envelope, calls } = await exec(
      ["timesheet", "log", "--project", PROJECT, "--hours", "0.5", "--person", "jane@acme.test", "--date", "2026-09-22"],
      {
        [`POST /api/v1/acme/projects/${PROJECT}/timesheet/entries`]: entry({ hours: "0.5", parent: SHEET_PARENT, person: person(JANE, "Jane Doe") }),
      },
    );
    expect(code).toBe(0);
    expect(calls[0].body).toEqual({ date: "2026-09-22", hours: "0.5", person_id: JANE });
    expect(envelope.summary).toBe("Logged 0.5 hours on Website (the project itself), 2026-09-22, for Jane Doe");
  });

  it("a project URL in place of an item means time on the project itself", async () => {
    const { code, calls } = await exec(["timesheet", "log", `${APP}/projects/${PROJECT}/timesheet`, "--hours", "2"], {
      [`POST /api/v1/acme/projects/${PROJECT}/timesheet/entries`]: entry({ parent: SHEET_PARENT }),
    });
    expect(code).toBe(0);
    expect(calls[0].path).toBe(`/api/v1/acme/projects/${PROJECT}/timesheet/entries`);
  });

  it("logs absence by type name, case-insensitively", async () => {
    const { code, envelope, calls } = await exec(
      ["timesheet", "log", "--absence", "vacation", "--hours", "8", "--date", "2026-09-23"],
      {
        "GET /api/v1/acme/timesheet/absence-types": TYPES,
        "POST /api/v1/acme/my/timesheet/absences": entry({ hours: "8.0", project: null, parent: null, absence_type: { id: VACATION, name: "Vacation" }, date: "2026-09-23" }),
      },
    );
    expect(code).toBe(0);
    expect(calls[1].body).toEqual({ date: "2026-09-23", hours: "8", absence_type_id: VACATION });
    expect(envelope.summary).toBe("Logged 8 hours of Vacation, 2026-09-23");
  });

  it("refuses without a target, with two targets, and without --hours, before any request", async () => {
    const none = await exec(["timesheet", "log", "--hours", "1"]);
    expect(none.code).toBe(EXIT_CODES.usage);
    expect(none.error.error).toBe("What is the time on?");
    expect(none.error.hint).toContain("--project");
    expect(none.error.hint).toContain("--absence");
    const two = await exec(["timesheet", "log", TODO, "--project", PROJECT, "--hours", "1"]);
    expect(two.code).toBe(EXIT_CODES.usage);
    const noHours = await exec(["timesheet", "log", TODO]);
    expect(noHours.code).toBe(EXIT_CODES.usage);
    expect(noHours.error.hint).toContain("1:30");
    const badDay = await exec(["timesheet", "log", TODO, "--hours", "1", "--date", "someday"]);
    expect(badDay.code).toBe(EXIT_CODES.usage);
    const stray = await exec(["timesheet", "log", "--project", PROJECT, "--hours", "1", "--occurrence", "2026-09-22"]);
    expect(stray.code).toBe(EXIT_CODES.usage);
    expect([...none.calls, ...two.calls, ...noHours.calls, ...badDay.calls, ...stray.calls]).toEqual([]);
  });

  it("surfaces daily_cap with its api_code and a hint to the day", async () => {
    const { code, error } = await exec(["timesheet", "log", TODO, "--hours", "20", "--date", "2026-09-25"], {
      [`POST /api/v1/acme/recordings/${TODO}/timesheet/entries`]: refusal(422, "daily_cap", "That would put Jason Hanschell over 24 hours on Fri, Sep 25."),
    });
    expect(code).toBe(EXIT_CODES.validation);
    expect(error.code).toBe("validation");
    expect(error.api_code).toBe("daily_cap");
    expect(error.error).toContain("over 24 hours");
    expect(error.hint).toContain("thicket timesheet week --week 2026-09-25");
    expect(error.retryable).toBe(false);
  });
});

describe("timesheet edit and delete", () => {
  it("edit sends only what changed; --notes \"\" clears the notes", async () => {
    const { code, envelope, calls } = await exec(["timesheet", "edit", ENTRY, "--hours", "2", "--notes", ""], {
      [`PATCH /api/v1/acme/timesheet-entries/${ENTRY}`]: entry({ hours: "2.0", description: null }),
    });
    expect(code).toBe(0);
    expect(calls[0].body).toEqual({ hours: "2", description: null });
    expect(envelope.summary).toBe('Updated: 2 hours on "Fix the header", 2026-09-22');
  });

  it("edit with nothing to change is refused", async () => {
    const { code, error, calls } = await exec(["timesheet", "edit", ENTRY]);
    expect(code).toBe(EXIT_CODES.usage);
    expect(error.hint).toContain("--hours");
    expect(calls).toEqual([]);
  });

  it("delete without --yes is refused with the command to confirm, and sends nothing", async () => {
    const { code, error, calls } = await exec(["timesheet", "delete", ENTRY]);
    expect(code).toBe(EXIT_CODES.usage);
    expect(error.error).toContain("permanent");
    expect(error.hint).toBe(`Run again with --yes: thicket timesheet delete ${ENTRY} --yes`);
    expect(calls).toEqual([]);
  });

  it("delete --yes reads the entry, deletes it, and returns what went", async () => {
    const { code, envelope, calls } = await exec(["timesheet", "delete", ENTRY, "--yes"], {
      [`GET /api/v1/acme/timesheet-entries/${ENTRY}`]: entry(),
      [`DELETE /api/v1/acme/timesheet-entries/${ENTRY}`]: { ok: true },
    });
    expect(code).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(envelope.data).toMatchObject({ id: ENTRY, deleted: true, entry: { hours: "1.5" } });
    expect(envelope.summary).toBe('Deleted 1.5 hours on "Fix the header", 2026-09-22');
  });
});

describe("timesheet week and submit", () => {
  it("reads one person's week with its status and next steps", async () => {
    const { code, envelope, calls } = await exec(["timesheet", "week", "--week", "2026-09-24", "--person", "me"], {
      "GET /api/v1/acme/my/timesheet": WEEK,
    });
    expect(code).toBe(0);
    expect(calls[0].query.get("week")).toBe("2026-09-24");
    expect(calls[0].query.get("person_id")).toBe(ME);
    expect(envelope.summary).toBe("Jason Hanschell, week of 2026-09-21: 10 hours (Changed since approval)");
    const cmds = envelope.breadcrumbs.map((b: { cmd: string }) => b.cmd);
    expect(cmds).toContain(`thicket timesheet submit --week 2026-09-21 --person ${ME}`);
    expect(cmds).toContain(`thicket timesheet week --week 2026-09-14 --person ${ME}`);
  });

  it("bare timesheet is this week, and --ids-only lists its entries", async () => {
    const { code, out } = await exec(["timesheet", "--ids-only"], { "GET /api/v1/acme/my/timesheet": WEEK });
    expect(code).toBe(0);
    expect(out).toEqual([ENTRY3, ENTRY, ENTRY2]);
  });

  it("renders the grid for a terminal: rows by day, absence, totals, status", async () => {
    const { code, out } = await exec(["timesheet", "week"], { "GET /api/v1/acme/my/timesheet": WEEK }, { isTty: true });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("MON 21");
    const todoRow = out.find((l) => l.startsWith("Website: To-do: Fix the header"));
    expect(todoRow).toMatch(/1\.5\s+1\.5$/);
    const projectRow = out.find((l) => /^Website\s/.test(l));
    expect(projectRow).toMatch(/0\.5\s+0\.5$/);
    expect(out.find((l) => l.startsWith("Absence: Vacation"))).toMatch(/8\s+8$/);
    expect(out.find((l) => l.startsWith("TOTAL"))).toMatch(/2\s+8\s+10$/);
    expect(text).toContain("Status: Changed since approval");
    expect(text).toContain(ENTRY2);
  });

  it("submit finds the week's first day, then submits it", async () => {
    const { code, envelope, calls } = await exec(["timesheet", "submit", "--week", "2026-09-24"], {
      "GET /api/v1/acme/my/timesheet": WEEK,
      "POST /api/v1/acme/my/timesheet/weeks/2026-09-21/submit": { ...APPROVAL, status: "submitted", changed_since: null },
    });
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/acme/my/timesheet",
      "POST /api/v1/acme/my/timesheet/weeks/2026-09-21/submit",
    ]);
    expect(envelope.summary).toBe("Submitted your week of 2026-09-21 to 2026-09-27 for approval (10 hours)");
  });

  it("submit while approvals are off surfaces approvals_off with a way forward", async () => {
    const { code, error } = await exec(["timesheet", "submit"], {
      "GET /api/v1/acme/my/timesheet": { ...WEEK, approvals_enabled: false, status: null, approval: null },
      "POST /api/v1/acme/my/timesheet/weeks/2026-09-21/submit": refusal(409, "approvals_off", "Approvals are off. An owner or admin can turn them on in Admin › Timesheets."),
    });
    expect(code).toBe(EXIT_CODES.api);
    expect(error.api_code).toBe("approvals_off");
    expect(error.hint).toContain("thicket timesheet report");
    expect(error.retryable).toBe(false);
  });
});

describe("timesheet approvals", () => {
  it("lists the week and what waits, with exact approve commands", async () => {
    const { code, envelope, calls } = await exec(["timesheet", "approvals", "--week", "2026-09-24"], {
      "GET /api/v1/acme/timesheet/approvals": APPROVALS,
    });
    expect(code).toBe(0);
    expect(calls[0].query.get("week")).toBe("2026-09-24");
    expect(envelope.summary).toBe("2 people with time in the week of 2026-09-21, 2 weeks waiting on you");
    const cmds = envelope.breadcrumbs.map((b: { cmd: string }) => b.cmd);
    expect(cmds[0]).toBe(`thicket timesheet approve ${JANE} 2026-09-21`);
    expect(cmds[1]).toBe(`thicket timesheet approve ${JANE} 2026-09-14`);
    expect(cmds).toContain(`thicket timesheet reject ${JANE} 2026-09-21 --reason "..."`);
    expect(envelope.breadcrumbs[1].description).toBe("Jane Doe, 30 hours, Changed since it was submitted");
  });

  it("approve posts the stored week; a bad week start is refused first", async () => {
    const ok = await exec(["timesheet", "approve", JANE, "2026-09-14"], {
      [`POST /api/v1/acme/timesheet/approvals/${JANE}/2026-09-14/approve`]: approvalRow(JANE, "Jane Doe", "2026-09-14", "approved", "30.0", { week_end: "2026-09-20" }),
    });
    expect(ok.code).toBe(0);
    expect(ok.envelope.summary).toBe("Approved Jane Doe's week of 2026-09-14 to 2026-09-20");
    const self = await exec(["timesheet", "approve", "me", "2026-09-21"], {
      [`POST /api/v1/acme/timesheet/approvals/${ME}/2026-09-21/approve`]: { ...APPROVAL, status: "approved", self_approved: true },
    });
    expect(self.envelope.summary).toBe("Self-approved your week of 2026-09-21 to 2026-09-27");
    const bad = await exec(["timesheet", "approve", JANE, "monday"]);
    expect(bad.code).toBe(EXIT_CODES.usage);
    expect(bad.error.hint).toContain("thicket timesheet approvals");
    expect(bad.calls).toEqual([]);
  });

  it("approving a week nobody submitted surfaces week_state", async () => {
    const { code, error } = await exec(["timesheet", "approve", JANE, "2026-09-07"], {
      [`POST /api/v1/acme/timesheet/approvals/${JANE}/2026-09-07/approve`]: refusal(409, "week_state", "Jane Doe hasn't submitted this week"),
    });
    expect(code).toBe(EXIT_CODES.api);
    expect(error.api_code).toBe("week_state");
    expect(error.hint).toBe("See where each week stands: thicket timesheet approvals");
  });

  it("reject needs --reason, then sends it", async () => {
    const refused = await exec(["timesheet", "reject", JANE, "2026-09-21"]);
    expect(refused.code).toBe(EXIT_CODES.usage);
    expect(refused.error.error).toBe("Say why you're rejecting this week");
    expect(refused.calls).toEqual([]);
    const blank = await exec(["timesheet", "reject", JANE, "2026-09-21", "--reason", "   "]);
    expect(blank.code).toBe(EXIT_CODES.usage);
    const sent = await exec(["timesheet", "reject", JANE, "2026-09-21", "--reason", "Tuesday is missing the client call"], {
      [`POST /api/v1/acme/timesheet/approvals/${JANE}/2026-09-21/reject`]: approvalRow(JANE, "Jane Doe", "2026-09-21", "rejected", "32.5", { rejection_reason: "Tuesday is missing the client call" }),
    });
    expect(sent.code).toBe(0);
    expect(sent.calls[0].body).toEqual({ reason: "Tuesday is missing the client call" });
    expect(sent.envelope.summary).toBe("Rejected Jane Doe's week of 2026-09-21 to 2026-09-27; they get the reason");
  });
});

describe("timesheet absence-types", () => {
  it("lists active types, and archived ones with --all", async () => {
    const active = await exec(["timesheet", "absence-types"], { "GET /api/v1/acme/timesheet/absence-types": TYPES });
    expect(active.code).toBe(0);
    expect(active.calls[0].query.has("include_archived")).toBe(false);
    expect(active.envelope.summary).toBe("2 absence types");
    expect(active.envelope.breadcrumbs[0].cmd).toBe("thicket timesheet log --absence Vacation --hours 8 --date <day>");
    const all = await exec(["timesheet", "absence-types", "--all"], {
      "GET /api/v1/acme/timesheet/absence-types": [...TYPES, { ...TYPES[1], id: ENTRY, name: "Jury duty", archived: true, archived_at: "2026-09-10T00:00:00.000Z" }],
    });
    expect(all.calls[0].query.get("include_archived")).toBe("true");
    expect(all.envelope.summary).toBe("3 absence types, archived included");
  });
});
