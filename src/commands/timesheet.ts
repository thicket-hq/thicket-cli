// Timesheets: time logged on a project and its items, the report and its
// CSV, the weekly timesheet, absence, and approvals. Team only: a client
// gets not_found from every one of these. An entry has no trash of its own
// (it goes there only with its item), so deleting one is permanent and
// `timesheet delete` asks for --yes.
import pc from "picocolors";
import type {
  OrgScope,
  TimesheetApprovalRow,
  TimesheetEntry,
  TimesheetEntryInput,
  TimesheetReportQuery,
  TimesheetWeek,
  TimesheetWeekApproval,
} from "thicket-sdk";
import type { CliContext } from "../lib/context.js";
import { parseDate } from "../lib/dates.js";
import {
  CliError,
  clip,
  table,
  toCliError,
  type Breadcrumb,
  type CommandResult,
} from "../lib/output.js";
import { readBody, resolveRecordingRef } from "../lib/refs.js";
import type { ArgSpec, CommandSpec, FlagSpec } from "../lib/registry.js";
import {
  looksLikeId,
  matchNamed,
  resolvePeople,
  resolveProject,
} from "../lib/resolve.js";
import { idOrUrlNote } from "../lib/specs.js";
import { looksLikeUrl, parseThicketUrl } from "../lib/urls.js";

const CATEGORY = "Timesheets";

type Options = Record<string, unknown>;
type Handler = CommandSpec["handler"];

const REPORT_STATUSES = ["approved", "submitted", "changed", "not_submitted"] as const;

// --- Days and hours -----------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day from a flag or argument: YYYY-MM-DD, or natural language. */
function dayArg(value: unknown, what: string): string {
  const parsed = parseDate(String(value));
  if (!ISO_DAY.test(parsed)) {
    throw new CliError(
      "usage",
      `${what} needs a day like 2026-09-25, "today", "yesterday" or "last friday", got "${String(value)}"`,
    );
  }
  return parsed;
}

/** A calendar day shifted by whole days (no time zone involved). */
function shiftDay(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The report's default range: the last month, ending today (the same day a
 * month back, or that month's last day when it is shorter: Mar 31 to Feb 28).
 */
export function lastMonth(today: string): { from: string; to: string } {
  const [year, month, day] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 2, 1));
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return { from: start.toISOString().slice(0, 10), to: today };
}

/** Hundredths of an hour from the API's decimal string ("1.5" is 150), so sums stay exact. */
function hundredths(hours: string): number {
  return Math.round(Number(hours) * 100);
}

/** "3", "1.5", "0.12": the shortest form. */
function formatHours(value: number): string {
  const whole = Math.floor(value / 100);
  const cents = String(value % 100).padStart(2, "0");
  if (cents === "00") return String(whole);
  return `${whole}.${cents.endsWith("0") ? cents[0] : cents}`;
}

function hoursPhrase(value: number): string {
  return `${formatHours(value)} ${value === 100 ? "hour" : "hours"}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Quotes a flag value for a suggested command when the shell would split it. */
function shellWord(value: string): string {
  return /^[\w@.:-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

// --- What time is on ----------------------------------------------------------

const ITEM_TYPES: Record<string, string> = {
  todo: "To-do",
  message: "Message",
  document: "Document",
  upload: "File",
  card: "Card",
  calendar_event: "Event",
};

function itemLabel(type: string, title: string | null, occurrence?: string | null): string {
  return `${ITEM_TYPES[type] ?? type}: ${title ?? "(untitled)"}${occurrence ? ` (${occurrence})` : ""}`;
}

/** Project and Item as the CSV export writes them. */
function entryPlace(e: TimesheetEntry): { project: string; item: string } {
  if (!e.parent) return { project: "Absence", item: e.absence_type?.name ?? "" };
  return {
    project: e.project?.name ?? "",
    item: e.parent.type === "timesheet" ? "" : itemLabel(e.parent.type, e.parent.title, e.occurrence_date),
  };
}

/** "Logged 1.5 hours on "Fix the header", 2026-09-25", "Logged 8 hours of Vacation, 2026-09-25". */
function entrySentence(verb: string, e: TimesheetEntry, forPerson: boolean): string {
  const hours = hoursPhrase(hundredths(e.hours));
  let what: string;
  if (!e.parent) what = `${hours} of ${e.absence_type?.name ?? "absence"}`;
  else if (e.parent.type === "timesheet") what = `${hours} on ${e.project?.name ?? "the project"} (the project itself)`;
  else what = `${hours} on "${e.parent.title ?? "(untitled)"}"`;
  return `${verb} ${what}, ${e.date}${forPerson ? `, for ${e.person.name}` : ""}`;
}

function entryCrumbs(e: TimesheetEntry, forPerson: boolean): Breadcrumb[] {
  const who = forPerson ? ` --person ${e.person.membership_id}` : "";
  return [
    { action: "edit", cmd: `thicket timesheet edit ${e.id} --hours 2`, description: "Change its day, hours, notes or person" },
    { action: "delete", cmd: `thicket timesheet delete ${e.id} --yes`, description: "Permanent: an entry has no trash" },
    { action: "week", cmd: `thicket timesheet week --week ${e.date}${who}`, description: "The week it is in" },
  ];
}

// --- Approval status ----------------------------------------------------------

type ApprovalView = Pick<
  TimesheetWeekApproval,
  "status" | "changed_since" | "self_approved" | "decided_by" | "rejection_reason"
>;

/** The status as the web app words it: "Approved by Sarah Chen", "Changed since approval". */
function statusLabel(status: string | null, approval?: ApprovalView | null): string {
  switch (status) {
    case "not_submitted":
      return "Not submitted";
    case "submitted":
      return "Submitted";
    case "approved":
      if (approval?.self_approved) return "Self-approved";
      return approval?.decided_by ? `Approved by ${approval.decided_by.name}` : "Approved";
    case "changed":
      return approval?.changed_since === "approval" ? "Changed since approval" : "Changed since it was submitted";
    case "rejected":
      return approval?.decided_by ? `Rejected by ${approval.decided_by.name}` : "Rejected";
    default:
      return status ?? "";
  }
}

function waitsOnDecision(row: { status: string }): boolean {
  return row.status === "submitted" || row.status === "changed";
}

// --- Resolution ---------------------------------------------------------------

/** --person: "me", a name, an email, or a membership id. */
async function personFlag(ctx: CliContext, options: Options): Promise<string | undefined> {
  if (options.person === undefined) return undefined;
  const [id] = await resolvePeople(ctx, [String(options.person)]);
  if (!id) {
    throw new CliError("usage", "--person needs someone", '"me", a name, an email, or a membership id');
  }
  return id;
}

async function resolveAbsenceType(org: OrgScope, ref: string): Promise<{ id: string; name: string }> {
  if (looksLikeId(ref)) return { id: ref, name: ref };
  const types = await org.timesheets.absenceTypes();
  try {
    return matchNamed(types.map((t) => ({ id: t.id, name: t.name })), ref, "absence type");
  } catch (err) {
    if (err instanceof CliError && !err.hint) err.hint = "List them: thicket timesheet absence-types";
    throw err;
  }
}

type LogTarget =
  | { kind: "item"; id: string; occurrence: string | null }
  | { kind: "project"; id: string }
  | { kind: "absence"; ref: string };

/** Exactly one of: an item, --project, --absence. Checked before any request. */
function assertOneTarget(ref: string | undefined, options: Options): void {
  const given = [ref !== undefined, options.project !== undefined, options.absence !== undefined].filter(Boolean).length;
  if (given === 0) {
    throw new CliError(
      "usage",
      "What is the time on?",
      "Pass an item (thicket timesheet log <id|url> --hours 1.5), --project <project> for time on the project itself, or --absence <type>",
    );
  }
  if (given > 1) {
    throw new CliError("usage", "Time goes on one thing: an item, --project, or --absence", "Pass just one of them");
  }
}

async function logTarget(ctx: CliContext, ref: string | undefined, options: Options): Promise<LogTarget> {
  let target: LogTarget;
  if (options.absence !== undefined) {
    target = { kind: "absence", ref: String(options.absence) };
  } else if (options.project !== undefined) {
    target = { kind: "project", id: (await resolveProject(ctx, String(options.project))).id };
  } else {
    const value = String(ref).trim();
    const parsed = looksLikeUrl(value) ? parseThicketUrl(value) : null;
    if (parsed?.project_id && !parsed.recording_id && (parsed.type === null || parsed.type === "timesheet")) {
      // The project's page or its timesheet: time on the project itself.
      ctx.adoptOrg(parsed.org);
      target = { kind: "project", id: parsed.project_id };
    } else {
      const rec = resolveRecordingRef(ctx, value);
      target = { kind: "item", id: rec.id, occurrence: rec.occurrence };
    }
  }
  if (options.occurrence !== undefined) {
    if (target.kind !== "item") {
      throw new CliError("usage", "--occurrence names a repeating event's day, so it goes with an event", "Pass the event's id or URL");
    }
    target.occurrence = dayArg(options.occurrence, "--occurrence");
  }
  return target;
}

// --- Refusals -----------------------------------------------------------------

type HintContext = "log" | "edit" | "submit" | "decide" | "read";

/**
 * What to run next after the server's timesheet refusals. The server's own
 * code rides the error envelope as api_code either way.
 */
function refusalHint(apiCode: string, context: HintContext, options: Options): string | undefined {
  switch (apiCode) {
    case "daily_cap": {
      let week = "";
      if (typeof options.date === "string") {
        const parsed = parseDate(options.date);
        if (ISO_DAY.test(parsed)) week = ` --week ${parsed}`;
      }
      const who = typeof options.person === "string" ? ` --person ${shellWord(options.person)}` : "";
      return `Nobody logs more than 24 hours on one day. See the day's entries: thicket timesheet week${week}${who}`;
    }
    case "approvals_off":
      return "Without approvals, logged hours count as they are: thicket timesheet report";
    case "week_state":
      if (context === "submit") {
        const week = typeof options.week === "string" ? ` --week ${shellWord(options.week)}` : "";
        return `See the week and its status: thicket timesheet week${week}`;
      }
      return "See where each week stands: thicket timesheet approvals";
    default:
      return undefined;
  }
}

function withHints(context: HintContext, handler: Handler): Handler {
  return async (ctx, args, options) => {
    try {
      return await handler(ctx, args, options);
    } catch (err) {
      const error = toCliError(err);
      const hint = error.apiCode ? refusalHint(error.apiCode, context, options) : undefined;
      if (hint) error.hint = hint;
      throw error;
    }
  };
}

// --- Report -------------------------------------------------------------------

async function reportQuery(
  ctx: CliContext,
  options: Options,
): Promise<{ query: TimesheetReportQuery; flags: string }> {
  if ((options.from === undefined) !== (options.to === undefined)) {
    throw new CliError(
      "usage",
      "Pass --from and --to together",
      "e.g. --from 2026-09-01 --to 2026-09-30; leave both out for the last month",
    );
  }
  const range =
    options.from !== undefined
      ? { from: dayArg(options.from, "--from"), to: dayArg(options.to, "--to") }
      : lastMonth(parseDate("today"));
  const query: TimesheetReportQuery = { start_date: range.from, end_date: range.to };
  let flags = `--from ${range.from} --to ${range.to}`;
  if (options.status !== undefined) {
    const status = String(options.status) as (typeof REPORT_STATUSES)[number];
    if (!REPORT_STATUSES.includes(status)) {
      throw new CliError("usage", `Unknown status "${status}"`, `One of: ${REPORT_STATUSES.join(", ")}`);
    }
    query.status = status;
    flags += ` --status ${status}`;
  }
  // A project URL names its org, so the project resolves before anyone else.
  if (options.project !== undefined) {
    query.project_id = (await resolveProject(ctx, String(options.project))).id;
    flags += ` --project ${query.project_id}`;
  }
  const person = await personFlag(ctx, options);
  if (person) {
    query.person_id = person;
    flags += ` --person ${person}`;
  }
  return { query, flags };
}

async function report(ctx: CliContext, _args: string[], options: Options): Promise<CommandResult> {
  if (options.csv && (options.jq !== undefined || options.idsOnly || options.count)) {
    throw new CliError(
      "usage",
      "--csv prints the CSV itself, which --jq, --ids-only and --count don't read",
      "Drop --csv to work with the JSON, or drop the other flag",
    );
  }
  const { query, flags } = await reportQuery(ctx, options);
  const org = await ctx.org();
  if (options.csv) {
    return { data: null, raw: await org.timesheets.reportCsv(query) };
  }
  const entries = await org.timesheets.report(query);
  const total = entries.reduce((sum, e) => sum + hundredths(e.hours), 0);
  const status = query.status ? `, ${query.status.replace(/_/g, " ")}` : "";
  return {
    data: entries,
    summary: `${hoursPhrase(total)} across ${plural(entries.length, "entry", "entries")}, ${query.start_date} to ${query.end_date}${status}`,
    human: entries.length
      ? table(
          ["DATE", "PERSON", "HOURS", "PROJECT", "ITEM", "NOTES", "ID"],
          entries.map((e) => {
            const place = entryPlace(e);
            return [
              e.date,
              clip(e.person.name, 20),
              formatHours(hundredths(e.hours)),
              clip(place.project, 22),
              clip(place.item, 34),
              clip(e.description ?? "", 28),
              e.id,
            ];
          }),
        )
      : ["No time in that range."],
    breadcrumbs: [
      { action: "csv", cmd: `thicket timesheet report ${flags} --csv > timesheet.csv`, description: "The same rows as CSV" },
      { action: "edit", cmd: "thicket timesheet edit <entry-id> --hours 2" },
      { action: "log", cmd: "thicket timesheet log <id|url> --hours 1.5" },
    ],
  };
}

// --- Entries ------------------------------------------------------------------

async function log(ctx: CliContext, args: string[], options: Options): Promise<CommandResult> {
  assertOneTarget(args[0], options);
  if (options.hours === undefined) {
    throw new CliError("usage", "How many hours?", "Pass --hours 1.5 or --hours 1:30");
  }
  const date = dayArg(options.date ?? "today", "--date");
  // A pasted URL names its org, so the target resolves before people do.
  const target = await logTarget(ctx, args[0], options);
  const body: TimesheetEntryInput = { date, hours: String(options.hours) };
  const notes = await readBody(options.notes);
  if (notes !== undefined) body.description = notes;
  const person = await personFlag(ctx, options);
  if (person) body.person_id = person;
  const org = await ctx.org();
  let entry: TimesheetEntry;
  if (target.kind === "item") {
    entry = await org.timesheets.logOnRecording(target.id, {
      ...body,
      ...(target.occurrence ? { occurrence: target.occurrence } : {}),
    });
  } else if (target.kind === "project") {
    entry = await org.timesheets.logOnProject(target.id, body);
  } else {
    const type = await resolveAbsenceType(org, target.ref);
    entry = await org.timesheets.logAbsence({ ...body, absence_type_id: type.id });
  }
  const forPerson = person !== undefined;
  return {
    data: entry,
    summary: entrySentence("Logged", entry, forPerson),
    human: [`${pc.green("Logged.")} ${entrySentence("", entry, forPerson).trim()} ${pc.dim(`(${entry.id})`)}`],
    breadcrumbs: entryCrumbs(entry, forPerson),
  };
}

async function edit(ctx: CliContext, args: string[], options: Options): Promise<CommandResult> {
  const id = resolveRecordingRef(ctx, args[0]).id;
  if ([options.date, options.hours, options.notes, options.person].every((v) => v === undefined)) {
    throw new CliError("usage", "Nothing to change", 'Pass --date, --hours, --notes or --person (--notes "" clears the notes)');
  }
  const body: { date?: string; hours?: string; description?: string | null; person_id?: string } = {};
  if (options.date !== undefined) body.date = dayArg(options.date, "--date");
  if (options.hours !== undefined) body.hours = String(options.hours);
  if (options.notes !== undefined) body.description = (await readBody(options.notes)) || null;
  const person = await personFlag(ctx, options);
  if (person) body.person_id = person;
  const org = await ctx.org();
  const entry = await org.timesheets.updateEntry(id, body);
  const forPerson = person !== undefined;
  return {
    data: entry,
    summary: entrySentence("Updated:", entry, forPerson),
    human: [`${pc.green("Updated.")} ${entrySentence("", entry, forPerson).trim()} ${pc.dim(`(${entry.id})`)}`],
    breadcrumbs: entryCrumbs(entry, forPerson),
  };
}

async function remove(ctx: CliContext, args: string[], options: Options): Promise<CommandResult> {
  const id = resolveRecordingRef(ctx, args[0]).id;
  if (options.yes !== true) {
    throw new CliError(
      "usage",
      "Deleting a time entry is permanent: it has no trash of its own",
      `Run again with --yes: thicket timesheet delete ${id} --yes`,
    );
  }
  const org = await ctx.org();
  // Read it first, so the answer says what went (and holds enough to log it again).
  const entry = await org.timesheets.getEntry(id);
  await org.timesheets.deleteEntry(id);
  return {
    data: { id, deleted: true, entry },
    summary: entrySentence("Deleted", entry, false),
    human: [`${pc.green("Deleted.")} ${entrySentence("", entry, false).trim()}`],
    ids: [id],
    breadcrumbs: [
      { action: "week", cmd: `thicket timesheet week --week ${entry.date}`, description: "The week it was in" },
    ],
  };
}

// --- The weekly timesheet -----------------------------------------------------

type GridRow = { label: string; cells: Map<string, number> };

/** The week as rows of per-day hundredths: its rows first, then absence with hours. */
function weekGrid(week: TimesheetWeek): GridRow[] {
  const rows: GridRow[] = [];
  const byKey = new Map<string, GridRow>();
  const key = (id: string, occurrence: string | null) => `${id}|${occurrence ?? ""}`;
  for (const r of week.rows) {
    const row: GridRow = {
      label: r.item ? `${r.project.name}: ${itemLabel(r.item.type, r.item.title, r.occurrence_date)}` : r.project.name,
      cells: new Map(),
    };
    byKey.set(key(r.recording_id, r.occurrence_date), row);
    rows.push(row);
  }
  const absence = new Map<string, GridRow>();
  for (const e of week.entries) {
    let row: GridRow | undefined;
    if (!e.parent) {
      const typeKey = e.absence_type?.id ?? "";
      row = absence.get(typeKey);
      if (!row) {
        row = { label: `Absence: ${e.absence_type?.name ?? ""}`, cells: new Map() };
        absence.set(typeKey, row);
      }
    } else {
      row = byKey.get(key(e.parent.id, e.occurrence_date));
      if (!row) {
        const place = entryPlace(e);
        row = { label: place.item ? `${place.project}: ${place.item}` : place.project, cells: new Map() };
        byKey.set(key(e.parent.id, e.occurrence_date), row);
        rows.push(row);
      }
    }
    row.cells.set(e.date, (row.cells.get(e.date) ?? 0) + hundredths(e.hours));
  }
  return [...rows, ...absence.values()];
}

const WEEKDAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function weekLines(week: TimesheetWeek): string[] {
  const grid = weekGrid(week);
  const cell = (n: number) => (n ? formatHours(n) : "");
  const dayTotals = week.days.map((d: string) => grid.reduce((sum, r) => sum + (r.cells.get(d) ?? 0), 0));
  const lines = [pc.bold(`${week.person.name}, week of ${week.week_start} to ${week.week_end}`)];
  lines.push(
    ...table(
      ["", ...week.days.map((d: string) => `${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(8)}`), "TOTAL"],
      [
        ...grid.map((r) => [
          clip(r.label, 44),
          ...week.days.map((d: string) => cell(r.cells.get(d) ?? 0)),
          cell([...r.cells.values()].reduce((a, b) => a + b, 0)),
        ]),
        ["TOTAL", ...dayTotals.map(cell), formatHours(hundredths(week.total_hours))],
      ],
    ),
  );
  if (week.approvals_enabled) {
    lines.push("", `Status: ${statusLabel(week.status, week.approval)}`);
    if (week.status === "rejected" && week.approval?.rejection_reason) {
      lines.push(`Reason: ${week.approval.rejection_reason}`);
    }
  }
  if (week.entries.length) {
    lines.push("", pc.dim("Entries"));
    for (const e of week.entries) {
      const place = entryPlace(e);
      lines.push(
        `  ${e.date}  ${formatHours(hundredths(e.hours)).padStart(5)}  ${clip(place.item ? `${place.project}: ${place.item}` : place.project, 50)}${e.description ? pc.dim(`  ${clip(e.description, 30)}`) : ""}  ${pc.dim(e.id)}`,
      );
    }
  }
  return lines;
}

async function week(ctx: CliContext, _args: string[], options: Options): Promise<CommandResult> {
  const day = dayArg(options.week ?? "today", "--week");
  const person = await personFlag(ctx, options);
  const org = await ctx.org();
  const w = await org.timesheets.week({ week: day, ...(person ? { person_id: person } : {}) });
  const who = person ? ` --person ${w.person.membership_id}` : "";
  const total = hundredths(w.total_hours);
  const canSubmit =
    w.approvals_enabled && w.writable && ["not_submitted", "changed", "rejected"].includes(w.status ?? "");
  return {
    data: w,
    summary: `${w.person.name}, week of ${w.week_start}: ${hoursPhrase(total)}${w.approvals_enabled ? ` (${statusLabel(w.status, w.approval)})` : ""}`,
    human: weekLines(w),
    ids: w.entries.map((e: TimesheetEntry) => e.id),
    breadcrumbs: [
      ...(w.writable
        ? [{ action: "log", cmd: `thicket timesheet log <id|url> --hours 1.5 --date <day>${who}`, description: "Log time in this week" }]
        : []),
      ...(canSubmit
        ? [{ action: "submit", cmd: `thicket timesheet submit --week ${w.week_start}${who}`, description: w.status === "not_submitted" ? "Submit it for approval" : "Resubmit it" }]
        : []),
      ...(w.entries.length ? [{ action: "edit", cmd: "thicket timesheet edit <entry-id> --hours 2" }] : []),
      { action: "previous", cmd: `thicket timesheet week --week ${shiftDay(w.week_start, -7)}${who}` },
      { action: "next", cmd: `thicket timesheet week --week ${shiftDay(w.week_start, 7)}${who}` },
    ],
  };
}

async function submit(ctx: CliContext, _args: string[], options: Options): Promise<CommandResult> {
  const day = dayArg(options.week ?? "today", "--week");
  const person = await personFlag(ctx, options);
  const org = await ctx.org();
  // The server takes the week by its first day, which the org's week start decides.
  const w = await org.timesheets.week({ week: day, ...(person ? { person_id: person } : {}) });
  const approval = await org.timesheets.submitWeek(w.week_start, person ? { person_id: person } : undefined);
  const whose = person ? `${approval.person.name}'s` : "your";
  const who = person ? ` --person ${approval.person.membership_id}` : "";
  return {
    data: approval,
    summary: `Submitted ${whose} week of ${approval.week_start} to ${approval.week_end} for approval (${hoursPhrase(hundredths(w.total_hours))})`,
    human: [`${pc.green("Submitted.")} Week of ${approval.week_start} to ${approval.week_end}, ${hoursPhrase(hundredths(w.total_hours))}`],
    breadcrumbs: [{ action: "week", cmd: `thicket timesheet week --week ${approval.week_start}${who}`, description: "The week and its status" }],
  };
}

// --- Approvals ----------------------------------------------------------------

function approvalRowCells(r: TimesheetApprovalRow, withWeek: boolean): string[] {
  return [
    clip(r.person.name, 24) + (r.removed ? pc.dim(" (removed)") : ""),
    ...(withWeek ? [r.week_start] : []),
    formatHours(hundredths(r.hours)),
    statusLabel(r.status, r),
    r.person.membership_id,
  ];
}

async function approvals(ctx: CliContext, _args: string[], options: Options): Promise<CommandResult> {
  const day = dayArg(options.week ?? "today", "--week");
  const org = await ctx.org();
  const a = await org.timesheets.approvals({ week: day });
  const waiting = [...a.weeks.filter(waitsOnDecision), ...a.waiting];
  const human = [pc.bold(`Week of ${a.week_start} to ${a.week_end}`)];
  human.push(
    ...(a.weeks.length
      ? table(["PERSON", "HOURS", "STATUS", "MEMBERSHIP"], a.weeks.map((r: TimesheetApprovalRow) => approvalRowCells(r, false)))
      : ["Nobody has time this week."]),
  );
  if (a.without_time.length) {
    human.push(pc.dim(`Without time: ${a.without_time.map((p: { name: string }) => p.name).join(", ")}`));
  }
  if (a.waiting.length) {
    human.push("", pc.bold("Waiting from other weeks"));
    human.push(...table(["PERSON", "WEEK", "HOURS", "STATUS", "MEMBERSHIP"], a.waiting.map((r: TimesheetApprovalRow) => approvalRowCells(r, true))));
  }
  const first = waiting[0];
  return {
    data: a,
    summary: `${plural(a.weeks.length, "person", "people")} with time in the week of ${a.week_start}, ${plural(waiting.length, "week")} waiting on you${a.all_approved && a.weeks.length ? "; everyone this week is approved" : ""}`,
    human,
    breadcrumbs: [
      ...waiting.slice(0, 3).map((r) => ({
        action: "approve",
        cmd: `thicket timesheet approve ${r.person.membership_id} ${r.week_start}`,
        description: `${r.person.name}, ${hoursPhrase(hundredths(r.hours))}, ${statusLabel(r.status, r)}`,
      })),
      ...(first
        ? [
            { action: "reject", cmd: `thicket timesheet reject ${first.person.membership_id} ${first.week_start} --reason "..."`, description: "Send it back; they get the reason" },
            { action: "inspect", cmd: `thicket timesheet week --person ${first.person.membership_id} --week ${first.week_start}`, description: "Their week, entry by entry" },
          ]
        : []),
      { action: "previous", cmd: `thicket timesheet approvals --week ${shiftDay(a.week_start, -7)}` },
    ],
  };
}

/** approve/reject's <person> <week-start>: the week as stored, so its exact first day. */
async function decisionTarget(ctx: CliContext, args: string[]): Promise<{ membershipId: string; weekStart: string }> {
  const [personRef, weekStart] = args;
  if (!ISO_DAY.test(weekStart ?? "")) {
    throw new CliError(
      "usage",
      `<week-start> is the week's first day as YYYY-MM-DD, got "${weekStart ?? ""}"`,
      "Copy it from: thicket timesheet approvals",
    );
  }
  const [membershipId] = await resolvePeople(ctx, [personRef]);
  if (!membershipId) throw new CliError("usage", "Whose week?", '"me", a name, an email, or a membership id');
  return { membershipId, weekStart };
}

async function approve(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { membershipId, weekStart } = await decisionTarget(ctx, args);
  const org = await ctx.org();
  const approval = await org.timesheets.approve(membershipId, weekStart);
  const range = `${approval.week_start} to ${approval.week_end}`;
  const summary = approval.self_approved
    ? `Self-approved your week of ${range}`
    : `Approved ${approval.person.name}'s week of ${range}`;
  return {
    data: approval,
    summary,
    human: [`${pc.green("Approved.")} ${summary}`],
    breadcrumbs: [{ action: "approvals", cmd: `thicket timesheet approvals --week ${approval.week_start}`, description: "Who else is waiting" }],
  };
}

async function reject(ctx: CliContext, args: string[], options: Options): Promise<CommandResult> {
  const reason = (await readBody(options.reason))?.trim();
  if (!reason) {
    throw new CliError(
      "usage",
      "Say why you're rejecting this week",
      'Pass --reason "..." (at most 1,000 characters); it reaches them in Thicket and by email',
    );
  }
  const { membershipId, weekStart } = await decisionTarget(ctx, args);
  const org = await ctx.org();
  const approval = await org.timesheets.reject(membershipId, weekStart, reason);
  const summary = `Rejected ${approval.person.name}'s week of ${approval.week_start} to ${approval.week_end}; they get the reason`;
  return {
    data: approval,
    summary,
    human: [`${pc.green("Rejected.")} ${summary}`],
    breadcrumbs: [{ action: "approvals", cmd: `thicket timesheet approvals --week ${approval.week_start}`, description: "Who else is waiting" }],
  };
}

async function absenceTypes(ctx: CliContext, _args: string[], options: Options): Promise<CommandResult> {
  const org = await ctx.org();
  const types = await org.timesheets.absenceTypes(options.all ? { include_archived: true } : undefined);
  const active = types.find((t) => !t.archived);
  return {
    data: types,
    summary: `${plural(types.length, "absence type")}${options.all ? ", archived included" : ""}`,
    human: table(
      ["NAME", "STATUS", "ID"],
      types.map((t) => [clip(t.name, 40), t.archived ? pc.dim("archived") : "active", t.id]),
    ),
    breadcrumbs: active
      ? [{ action: "log", cmd: `thicket timesheet log --absence ${shellWord(active.name)} --hours 8 --date <day>`, description: "Log absence" }]
      : [],
  };
}

// --- Specs --------------------------------------------------------------------

const personFlagSpec = (what: string): FlagSpec => ({
  flag: "--person <person>",
  description: `${what}: "me", a name, an email, or a membership id (owners and admins, for someone else)`,
});

const weekFlag: FlagSpec = {
  flag: "--week <day>",
  description: 'Any day in the week: 2026-09-21, "today", "last week" (default: this week)',
};

const entryArg: ArgSpec = { name: "entry-id", description: "Time entry id (from the report or the week)", required: true };

const decisionArgs: ArgSpec[] = [
  { name: "person", description: 'Whose week: "me", a name, an email, or a membership id', required: true },
  { name: "week-start", description: "The week's first day, YYYY-MM-DD, as thicket timesheet approvals lists it", required: true },
];

const teamOnlyNote = "Team only: clients get not_found from every timesheet command";

const weekSpec: Omit<CommandSpec, "path" | "summary"> = {
  category: CATEGORY,
  flags: [weekFlag, personFlagSpec("Whose week")],
  notes: [
    "Rows are projects and items with time or added this week, then absence; each cell is the day's total",
    "Entries under the grid carry the ids thicket timesheet edit and delete take",
    "With approvals on, the status is as read now: a change after submitting or approving reads Changed until it is resubmitted or approved again",
    teamOnlyNote,
  ],
  handler: withHints("read", week),
};

export const timesheetCommands: CommandSpec[] = [
  {
    path: ["timesheet"],
    summary: "Your timesheet this week (bare shorthand for timesheet week)",
    ...weekSpec,
  },
  {
    path: ["timesheet", "week"],
    summary: "One person's week: hours per row and day, the total, and its approval status",
    ...weekSpec,
  },
  {
    path: ["timesheet", "report"],
    category: CATEGORY,
    summary: "Time logged across projects in a date range, with totals, or as CSV",
    flags: [
      { flag: "--from <day>", description: "Range start (with --to; default: a month ago)" },
      { flag: "--to <day>", description: "Range end (with --from; default: today); at most 366 days" },
      personFlagSpec("Only this person's time"),
      { flag: "-p, --project <project>", description: "Only this project: name, id, or URL" },
      { flag: "--status <status>", description: `While approvals are on: ${REPORT_STATUSES.join(", ")} (default approved)` },
      { flag: "--csv", description: "Print the export as CSV instead: Date,Person,Hours,Project,Item,Notes,Created (plus Status with approvals on)" },
    ],
    notes: [
      "Without a project, absence comes along: everyone's for owners and admins, your own for members",
      "--csv prints the CSV itself in every output mode (there is no envelope around it); redirect it to a file. Errors stay structured on stderr",
      "While approvals are on the report shows approved hours unless --status says otherwise; rejected weeks stay out until resubmitted",
      teamOnlyNote,
    ],
    handler: withHints("read", report),
  },
  {
    path: ["timesheet", "log"],
    category: CATEGORY,
    summary: "Log time on an item, on a project itself, or as absence",
    args: [{ name: "item", description: "To-do, message, doc, file, card or event: id or URL (omit with --project or --absence)" }],
    flags: [
      { flag: "--hours <hours>", description: 'Required: "1.5" or "1:30"' },
      { flag: "-d, --date <day>", description: 'The day: 2026-09-25, "yesterday", "last friday", "-2" (default: today)' },
      { flag: "--notes <text>", description: "What the time was for (or - for stdin)" },
      { flag: "-p, --project <project>", description: "Time on the project itself instead of an item: name, id, or URL" },
      { flag: "--absence <type>", description: "Absence instead, by type name or id (see thicket timesheet absence-types)" },
      { flag: "--occurrence <day>", description: "A repeating event's day (an event URL's ?occurrence= works too)" },
      personFlagSpec("Whose time"),
    ],
    notes: [
      idOrUrlNote,
      "The project's Timesheet must be switched on in its settings; items elsewhere can't take time",
      "Nobody logs more than 24 hours on one day: the server refuses with api_code daily_cap",
      teamOnlyNote,
    ],
    handler: withHints("log", log),
  },
  {
    path: ["timesheet", "edit"],
    category: CATEGORY,
    summary: "Change a time entry's day, hours, notes, or person",
    args: [entryArg],
    flags: [
      { flag: "-d, --date <day>", description: "Move it to another day" },
      { flag: "--hours <hours>", description: '"1.5" or "1:30"' },
      { flag: "--notes <text>", description: 'New notes (or - for stdin); --notes "" clears them' },
      personFlagSpec("Move it to someone else"),
    ],
    notes: [
      "What the time is on never changes; delete it and log it again instead",
      "Editing only the notes does not count as a change to an approved week",
    ],
    handler: withHints("edit", edit),
  },
  {
    path: ["timesheet", "delete"],
    category: CATEGORY,
    summary: "Delete a time entry for good (needs --yes)",
    args: [entryArg],
    flags: [{ flag: "-y, --yes", description: "Confirm: the entry has no trash and can't be restored" }],
    notes: [
      "The one permanent delete in this CLI: an entry goes to the trash only with its item",
      "The response carries the deleted entry, enough to log it again",
    ],
    handler: withHints("edit", remove),
  },
  {
    path: ["timesheet", "submit"],
    category: CATEGORY,
    summary: "Submit a week for approval (while approvals are on)",
    flags: [weekFlag, personFlagSpec("Whose week")],
    notes: [
      "Submitting again resubmits a changed or rejected week; nothing locks, and later edits read Changed",
      "Refused with api_code approvals_off while approvals are off",
    ],
    handler: withHints("submit", submit),
  },
  {
    path: ["timesheet", "approvals"],
    category: CATEGORY,
    summary: "Who has time in a week, and every week waiting on your approval (owners and admins)",
    flags: [weekFlag],
    notes: [
      "waiting lists submitted or changed weeks from other periods, oldest first; breadcrumbs name the exact approve command",
      "Refused with api_code approvals_off while approvals are off",
    ],
    handler: withHints("decide", approvals),
  },
  {
    path: ["timesheet", "approve"],
    category: CATEGORY,
    summary: "Approve a submitted week as its hours are now (owners and admins)",
    args: decisionArgs,
    notes: ["Approving your own week marks it self-approved", "Approving notifies no one"],
    handler: withHints("decide", approve),
  },
  {
    path: ["timesheet", "reject"],
    category: CATEGORY,
    summary: "Send a week back with a reason (owners and admins)",
    args: decisionArgs,
    flags: [{ flag: "--reason <text>", description: "Required: why (or - for stdin); it reaches the person" }],
    notes: ["A rejected week stays out of the report until it is resubmitted"],
    handler: withHints("decide", reject),
  },
  {
    path: ["timesheet", "absence-types"],
    category: CATEGORY,
    summary: "The organization's absence types (Vacation, Sick leave, ...)",
    flags: [{ flag: "--all", description: "Include archived types" }],
    notes: ["Owners and admins manage the types in the web app: Admin, Timesheets"],
    handler: withHints("read", absenceTypes),
  },
];
