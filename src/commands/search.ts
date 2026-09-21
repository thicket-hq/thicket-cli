// Search, activity, your assignments, and the cross-project work reports.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { parseDate } from "../lib/dates.js";
import { CliError, clip, day, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { resolvePeople, resolveProject } from "../lib/resolve.js";
import { recordingTable, stripHtml, type RecordingRow } from "../lib/rows.js";

const CATEGORY = "Search & Reports";

async function search(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const query: Record<string, string | number | boolean> = {};
  if (options.project) {
    query.project_id = (await resolveProject(ctx, String(options.project))).id;
  }
  if (options.type) query.type = String(options.type);
  if (options.fileType) query.file_type = String(options.fileType);
  if (options.archived) query.archived = 1;
  if (options.recent) query.sort = "recent";
  if (options.limit) query.per_page = Number(options.limit);
  const rows = (await org.search.query(args[0], query)) as (RecordingRow & {
    excerpt?: string;
  })[];
  return {
    data: rows,
    summary: `${rows.length} result${rows.length === 1 ? "" : "s"} for "${args[0]}"`,
    human: rows.flatMap((r) => [
      `${pc.bold(clip(String(r.title ?? stripHtml(String(r.content ?? ""))), 60))} ${pc.dim(`${r.type} · ${r.project_name ?? ""}`)}`,
      ...(r.excerpt ? [`  ${clip(stripHtml(r.excerpt), 100)}`] : []),
      `  ${pc.dim(r.id)}`,
    ]),
    breadcrumbs: [
      { action: "show", cmd: "thicket show <id>", description: "Read a result" },
    ],
  };
}

async function activity(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const query: string[] = [];
  if (options.project) {
    const project = await resolveProject(ctx, String(options.project));
    query.push(`project_id=${encodeURIComponent(project.id)}`);
  }
  if (options.q) query.push(`q=${encodeURIComponent(String(options.q))}`);
  if (options.limit) query.push(`per_page=${Number(options.limit)}`);
  type ActivityRow = {
    action: string;
    actor_name?: string;
    project_name?: string;
    recording_id?: string;
    recording_title?: string;
    excerpt?: string;
    created_at?: string;
    [key: string]: unknown;
  };
  const rows = await org.request<ActivityRow[]>(
    "GET",
    `/activity${query.length ? `?${query.join("&")}` : ""}`,
  );
  return {
    data: rows,
    summary: `${rows.length} event${rows.length === 1 ? "" : "s"}`,
    human: rows.map(
      (e) =>
        `${pc.dim(day(e.created_at))} ${pc.bold(e.actor_name ?? "someone")} ${e.action} ${clip(String(e.recording_title ?? e.excerpt ?? ""), 50)} ${pc.dim(`· ${e.project_name ?? ""}`)}`,
    ),
  };
}

const DUE_SCOPES = [
  "overdue",
  "due_today",
  "due_tomorrow",
  "due_later_this_week",
  "due_next_week",
  "due_later",
];

async function assignments(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  if (options.completed) {
    const rows = await org.request<RecordingRow[]>(
      "GET",
      "/my/assignments/completed",
    );
    return {
      data: rows,
      summary: `${rows.length} completed assignment${rows.length === 1 ? "" : "s"}`,
      human: recordingTable(rows),
    };
  }
  if (options.due) {
    const scope = String(options.due);
    if (!DUE_SCOPES.includes(scope)) {
      throw new CliError(
        "usage",
        `Unknown due scope "${scope}"`,
        `One of: ${DUE_SCOPES.join(", ")}`,
      );
    }
    const rows = await org.request<RecordingRow[]>(
      "GET",
      `/my/assignments/due?scope=${scope}`,
    );
    return {
      data: rows,
      summary: `${rows.length} assignment${rows.length === 1 ? "" : "s"} (${scope.replace(/_/g, " ")})`,
      human: recordingTable(rows),
    };
  }
  const grouped = await org.request<{
    priorities: RecordingRow[];
    non_priorities: RecordingRow[];
  }>("GET", "/my/assignments");
  const total = grouped.priorities.length + grouped.non_priorities.length;
  const render = (rows: RecordingRow[]) =>
    rows.map(
      (r) =>
        `  ${r.completed ? pc.green("✓") : "◯"} ${clip(String(r.title ?? ""), 56)}${r.due_on ? pc.yellow(`  due ${day(r.due_on)}`) : ""} ${pc.dim(`· ${r.project_name ?? ""} · ${r.id}`)}`,
    );
  return {
    data: grouped,
    summary: `${total} open assignment${total === 1 ? "" : "s"}`,
    human: [
      ...(grouped.priorities.length
        ? [pc.bold("Up Next"), ...render(grouped.priorities), ""]
        : []),
      pc.bold("Everything else"),
      ...render(grouped.non_priorities),
    ],
    breadcrumbs: [
      { action: "done", cmd: "thicket done <id>" },
      { action: "due", cmd: "thicket assignments --due overdue" },
    ],
  };
}

async function reportOverdue(ctx: CliContext): Promise<CommandResult> {
  const org = await ctx.org();
  type Buckets = Record<string, (RecordingRow & { days_late?: number })[]>;
  const buckets = await org.request<Buckets>("GET", "/reports/todos/overdue");
  const labels: Record<string, string> = {
    under_a_week_late: "Under a week late",
    over_a_week_late: "Over a week late",
    over_a_month_late: "Over a month late",
    over_three_months_late: "Over three months late",
  };
  const total = Object.values(buckets).reduce((n, rows) => n + rows.length, 0);
  const human: string[] = [];
  for (const [key, rows] of Object.entries(buckets)) {
    if (!rows.length) continue;
    human.push(pc.bold(labels[key] ?? key));
    for (const r of rows) {
      const who = (r.assignees as { name: string }[] | undefined)
        ?.map((a) => a.name)
        .join(", ");
      human.push(
        `  ${clip(String(r.title ?? ""), 48)} ${pc.yellow(`${r.days_late}d late`)}${who ? pc.dim(`  ${who}`) : ""} ${pc.dim(`· ${r.project_name ?? ""} · ${r.id}`)}`,
      );
    }
    human.push("");
  }
  return {
    data: buckets,
    summary: `${total} overdue to-do${total === 1 ? "" : "s"}`,
    human: human.length ? human : ["Nothing is overdue."],
  };
}

async function reportAssigned(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const org = await ctx.org();
  if (!args[0]) {
    type Person = { membership_id: string; name: string; email: string; role: string };
    const { people } = await org.request<{ people: Person[] }>(
      "GET",
      "/reports/todos/assigned",
    );
    return {
      data: people,
      summary: `${people.length} people can have work assigned`,
      human: table(
        ["NAME", "EMAIL", "ROLE", "MEMBERSHIP"],
        people.map((p) => [p.name, p.email, p.role, p.membership_id]),
      ),
      ids: people.map((p) => p.membership_id),
      breadcrumbs: [
        { action: "person", cmd: "thicket reports assigned <person>", description: "One person's open work" },
      ],
    };
  }
  const [membershipId] = await resolvePeople(ctx, [args[0]]);
  const report = await org.request<{
    person: { name: string };
    items: (RecordingRow & { parent_title?: string })[];
  }>("GET", `/reports/todos/assigned/${membershipId}`);
  return {
    data: report,
    summary: `${report.items.length} open item${report.items.length === 1 ? "" : "s"} assigned to ${report.person?.name ?? args[0]}`,
    human: report.items.map(
      (r) =>
        `  ◯ ${clip(String(r.title ?? ""), 52)}${r.due_on ? pc.yellow(`  due ${day(r.due_on)}`) : ""} ${pc.dim(`· ${r.project_name ?? ""} · ${r.id}`)}`,
    ),
  };
}

async function reportUpcoming(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const from = parseDate(String(options.from ?? "today"));
  const to = parseDate(String(options.to ?? "+14"));
  const report = await org.request<{
    events: RecordingRow[];
    recurring_occurrences?: RecordingRow[];
    assignables: RecordingRow[];
  }>(
    "GET",
    `/reports/calendar/upcoming?window_starts_on=${from}&window_ends_on=${to}`,
  );
  const events = [
    ...report.events,
    ...(report.recurring_occurrences ?? []),
  ];
  return {
    data: report,
    summary: `${events.length} event${events.length === 1 ? "" : "s"}, ${report.assignables.length} dated item${report.assignables.length === 1 ? "" : "s"} (${from} to ${to})`,
    human: [
      ...(events.length
        ? [
            pc.bold("Events"),
            ...events.map(
              (e) =>
                `  ${pc.dim(day(String(e.starts_at ?? e.starts_on ?? "")))} ${clip(String(e.title ?? ""), 50)} ${pc.dim(`· ${e.project_name ?? ""}`)}`,
            ),
            "",
          ]
        : []),
      ...(report.assignables.length
        ? [
            pc.bold("Due"),
            ...report.assignables.map(
              (r) =>
                `  ${pc.dim(day(r.due_on))} ${clip(String(r.title ?? ""), 50)} ${pc.dim(`· ${r.project_name ?? ""} · ${r.id}`)}`,
            ),
          ]
        : []),
    ],
  };
}

async function reportHealth(ctx: CliContext): Promise<CommandResult> {
  const org = await ctx.org();
  type Gauge = {
    project_id: string;
    project_name: string;
    status: string;
    position: number;
    updated_at: string | null;
    updated_by: string | null;
  };
  // The report wraps its rows: GET /reports/health answers {gauges: [...]}.
  const { gauges: rows } = await org.request<{ gauges: Gauge[] }>(
    "GET",
    "/reports/health",
  );
  return {
    data: rows,
    summary: `${rows.length} project gauge${rows.length === 1 ? "" : "s"}`,
    human: table(
      ["PROJECT", "STATUS", "%", "UPDATED", "BY"],
      rows.map((g) => [
        clip(g.project_name, 32),
        g.status,
        String(g.position),
        day(g.updated_at),
        clip(g.updated_by ?? "", 24),
      ]),
    ),
  };
}

export const searchCommands: CommandSpec[] = [
  {
    path: ["search"],
    category: CATEGORY,
    summary: "Full-text search across everything you can see",
    args: [{ name: "query", description: "What to look for", required: true }],
    flags: [
      { flag: "-p, --project <project>", description: "Limit to one project" },
      { flag: "-t, --type <type>", description: "Limit to one type (todo, message, document, ...)" },
      { flag: "--file-type <kind>", description: "image, audio, video, or pdf" },
      { flag: "--archived", description: "Include archived projects" },
      { flag: "--recent", description: "Sort by recency instead of relevance" },
      { flag: "-n, --limit <n>", description: "Max results (default 50)" },
    ],
    handler: search,
  },
  {
    path: ["activity"],
    category: CATEGORY,
    summary: "The account-wide activity timeline",
    flags: [
      { flag: "-p, --project <project>", description: "One project's timeline" },
      { flag: "--q <keyword>", description: "Keyword filter" },
      { flag: "-n, --limit <n>", description: "Max events" },
    ],
    handler: activity,
  },
  {
    path: ["assignments"],
    category: CATEGORY,
    summary: "Your open work across projects (Up Next first)",
    flags: [
      { flag: "--due <scope>", description: `One window: ${DUE_SCOPES.join(", ")}` },
      { flag: "--completed", description: "Your completed assignments instead" },
    ],
    handler: assignments,
  },
  {
    path: ["reports", "overdue"],
    category: CATEGORY,
    summary: "Every overdue to-do, bucketed by lateness",
    handler: reportOverdue,
  },
  {
    path: ["reports", "assigned"],
    category: CATEGORY,
    summary: "Who can have work assigned, or one person's open work",
    args: [{ name: "person", description: '"me", a name, or an email (omit to list people)' }],
    handler: reportAssigned,
  },
  {
    path: ["reports", "upcoming"],
    category: CATEGORY,
    summary: "Events and dated work in a window (default: the next two weeks)",
    flags: [
      { flag: "--from <date>", description: "Window start (default today)" },
      { flag: "--to <date>", description: "Window end (default +14)" },
    ],
    handler: reportUpcoming,
  },
  {
    path: ["reports", "health"],
    category: CATEGORY,
    summary: "Project health gauges across the account",
    handler: reportHealth,
  },
];
