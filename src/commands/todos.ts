// To-dos: lists, items, completion, assignment. The API shape underneath:
// project tools → the todos container → todolist children → todo children;
// a todo created directly under the container is a "loose" to-do.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { parseDate } from "../lib/dates.js";
import { bodyFields } from "../lib/markdown.js";
import { CliError, clip, day, table, type CommandResult } from "../lib/output.js";
import { readBody, resolveRecordingRef } from "../lib/refs.js";
import type { CommandSpec } from "../lib/registry.js";
import { plainFlag, recordingArg } from "../lib/specs.js";
import {
  resolvePeople,
  resolveProject,
  resolveTodoList,
  resolveTool,
} from "../lib/resolve.js";
import { detailLines, todoTable, type RecordingRow } from "../lib/rows.js";

const CATEGORY = "To-dos";

const inFlag = { flag: "-i, --in <project>", description: "Project name or id" };

function requireIn(options: Record<string, unknown>): string {
  const value = options.in;
  if (typeof value !== "string" || !value) {
    throw new CliError("usage", "This command needs a project", "Pass --in <project name or id>");
  }
  return value;
}

async function todosList(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  let rows: RecordingRow[];
  let where: string;
  if (options.list) {
    const listRef = String(options.list);
    const list = await resolveTodoList(ctx, requireIn(options), listRef);
    rows = (await org.recordings.children(list.id, {
      type: "todo",
      ...(options.completed ? { completed: "true" } : {}),
    })) as RecordingRow[];
    where = `in "${list.title}"`;
  } else {
    const project = await resolveProject(ctx, requireIn(options));
    rows = (await org.recordings.list({
      type: "todo",
      project_id: project.id,
    })) as RecordingRow[];
    if (!options.completed) rows = rows.filter((r) => !r.completed);
    where = `in "${project.name}"`;
  }
  return {
    data: rows,
    summary: `${rows.length} ${options.completed ? "" : "open "}to-do${rows.length === 1 ? "" : "s"} ${where}`,
    human: todoTable(rows),
    breadcrumbs: [
      { action: "show", cmd: "thicket todos show <id>" },
      { action: "done", cmd: "thicket done <id>", description: "Complete one" },
      { action: "add", cmd: 'thicket todo "Title" --in <project>', description: "Add one" },
    ],
  };
}

async function todosShow(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const org = await ctx.org();
  const id = resolveRecordingRef(ctx, args[0]).id;
  const row = (await org.recordings.get(id)) as RecordingRow;
  const assignees = await org.request<{ membership_id: string; name: string }[]>(
    "GET",
    `/recordings/${id}/assignees`,
  ).catch(() => []);
  const data = { ...row, assignees };
  return {
    data,
    summary: String(row.title ?? row.id),
    human: detailLines(data as RecordingRow),
    breadcrumbs: [
      { action: "done", cmd: `thicket done ${row.id}` },
      { action: "comment", cmd: `thicket comment ${row.id} "text"` },
      { action: "comments", cmd: `thicket comments ${row.id}` },
    ],
  };
}

async function todoAdd(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const projectRef = requireIn(options);
  const org = await ctx.org();
  let parentId: string;
  let where: string;
  if (options.list) {
    const list = await resolveTodoList(ctx, projectRef, String(options.list));
    parentId = list.id;
    where = `"${list.title}"`;
  } else {
    const tool = await resolveTool(ctx, projectRef, "todos");
    parentId = tool.containerId;
    where = `${tool.projectName} (loose, outside any list)`;
  }
  const body: Record<string, unknown> = { type: "todo", title: args[0] };
  if (options.due) body.due_on = parseDate(String(options.due));
  if (options.start) body.starts_on = parseDate(String(options.start));
  Object.assign(body, await bodyFields(ctx, { content: await readBody(options.notes), plain: options.plain === true }));
  if (options.assignee) {
    body.assignee_ids = await resolvePeople(
      ctx,
      Array.isArray(options.assignee) ? options.assignee.map(String) : [String(options.assignee)],
    );
  }
  const created = (await org.recordings.createChild(parentId, body as { type: string })) as RecordingRow;
  return {
    data: created,
    summary: `Added "${created.title}" to ${where}`,
    human: [
      `${pc.green("Added.")} ${created.title} (${created.id})${created.due_on ? `, due ${day(created.due_on)}` : ""}`,
    ],
    breadcrumbs: [
      { action: "done", cmd: `thicket done ${created.id}` },
      { action: "show", cmd: `thicket todos show ${created.id}` },
    ],
  };
}

async function todosUpdate(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const body: Record<string, unknown> = {};
  if (options.title !== undefined) body.title = options.title;
  if (options.due !== undefined) {
    body.due_on = options.due === "none" ? null : parseDate(String(options.due));
  }
  if (options.start !== undefined) {
    body.starts_on = options.start === "none" ? null : parseDate(String(options.start));
  }
  Object.assign(body, await bodyFields(ctx, { content: await readBody(options.notes), plain: options.plain === true }));
  if (Object.keys(body).length === 0) {
    throw new CliError("usage", "Nothing to update", "Pass --title, --due, --start, or --notes");
  }
  const updated = (await org.request(
    "PATCH",
    `/recordings/${resolveRecordingRef(ctx, args[0]).id}`,
    { body },
  )) as RecordingRow;
  return {
    data: updated,
    summary: `Updated "${updated.title}"`,
    human: [`${pc.green("Updated.")} ${updated.title}`],
  };
}

function completion(complete: boolean): CommandSpec["handler"] {
  return async (ctx, args) => {
    const org = await ctx.org();
    const ids = args[0]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => resolveRecordingRef(ctx, s).id);
    if (ids.length === 0) {
      throw new CliError("usage", "No to-do ids given");
    }
    const results: { id: string }[] = [];
    for (const id of ids) {
      if (complete) await org.recordings.complete(id);
      else await org.recordings.uncomplete(id);
      results.push({ id });
    }
    const verb = complete ? "Completed" : "Reopened";
    return {
      data: { [complete ? "completed" : "reopened"]: results.map((r) => r.id) },
      summary: `${verb} ${results.length} to-do${results.length === 1 ? "" : "s"}`,
      human: [`${pc.green(`${verb}.`)} ${results.map((r) => r.id).join(", ")}`],
      ids: results.map((r) => r.id),
    };
  };
}

async function assign(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const [rawId, ...people] = args;
  const id = resolveRecordingRef(ctx, rawId).id;
  const org = await ctx.org();
  let ids: string[];
  if (options.none) {
    ids = [];
  } else if (options.add || options.remove) {
    const current = await org.request<{ membership_id: string }[]>(
      "GET",
      `/recordings/${id}/assignees`,
    );
    const set = new Set(current.map((a) => a.membership_id));
    for (const m of await resolvePeople(ctx, people)) {
      if (options.remove) set.delete(m);
      else set.add(m);
    }
    ids = [...set];
  } else {
    if (people.length === 0) {
      throw new CliError("usage", "Who should this be assigned to?", 'e.g. thicket assign <id> me, or --none to clear');
    }
    ids = await resolvePeople(ctx, people);
  }
  await org.request("PUT", `/recordings/${id}/assignees`, {
    body: { membership_ids: ids },
  });
  return {
    data: { id, membership_ids: ids },
    summary: ids.length
      ? `Assigned to ${ids.length} ${ids.length === 1 ? "person" : "people"}`
      : "Cleared all assignments",
    human: [
      pc.green(ids.length ? "Assigned." : "Cleared."),
    ],
  };
}

async function listsList(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const tool = await resolveTool(ctx, requireIn(options), "todos");
  const org = await ctx.org();
  const lists = (await org.recordings.children(tool.containerId, {
    type: "todolist",
  })) as RecordingRow[];
  return {
    data: lists,
    summary: `${lists.length} list${lists.length === 1 ? "" : "s"} in "${tool.projectName}"`,
    human: table(
      ["TITLE", "ID"],
      lists.map((l) => [clip(String(l.title ?? ""), 60), l.id]),
    ),
    breadcrumbs: [
      { action: "todos", cmd: `thicket todos --in ${tool.projectId} --list <list>` },
      { action: "add", cmd: 'thicket todo "Title" --in <project> --list <list>' },
    ],
  };
}

async function listsCreate(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const tool = await resolveTool(ctx, requireIn(options), "todos");
  const org = await ctx.org();
  const body: Record<string, unknown> = {
    type: "todolist",
    title: args[0],
    ...(await bodyFields(ctx, { content: await readBody(options.notes), plain: options.plain === true })),
  };
  const created = (await org.recordings.createChild(
    tool.containerId,
    body as { type: string },
  )) as RecordingRow;
  return {
    data: created,
    summary: `Created list "${created.title}" in "${tool.projectName}"`,
    human: [`${pc.green("Created.")} ${created.title} (${created.id})`],
    breadcrumbs: [
      { action: "add", cmd: `thicket todo "Title" --in ${tool.projectId} --list ${created.id}` },
    ],
  };
}

const todoListFlags = [
  inFlag,
  { flag: "-l, --list <list>", description: "To-do list name or id" },
  { flag: "--completed", description: "Include completed to-dos" },
];

const addFlags = [
  inFlag,
  { flag: "-l, --list <list>", description: "To-do list name or id (omit for a loose to-do)" },
  { flag: "-d, --due <date>", description: 'Due date: 2026-09-01, "tomorrow", "friday", "+3"' },
  { flag: "--start <date>", description: "Start date (makes it a date range)" },
  { flag: "-a, --assignee <person...>", description: 'Assign people: "me", a name, or an email' },
  { flag: "--notes <markdown>", description: "Notes under the to-do, as Markdown (or - for stdin)" },
  plainFlag,
];

const addSpec: Omit<CommandSpec, "path" | "summary"> = {
  category: CATEGORY,
  args: [{ name: "title", description: "The to-do", required: true }],
  flags: addFlags,
  notes: ['Dates accept natural language: "tomorrow", "next monday", "+3", "eow"'],
  handler: todoAdd,
};

export const todoCommands: CommandSpec[] = [
  {
    path: ["todos"],
    category: CATEGORY,
    summary: "List a project's open to-dos (bare shorthand for todos list)",
    flags: todoListFlags,
    handler: todosList,
  },
  {
    path: ["todos", "list"],
    category: CATEGORY,
    summary: "List a project's to-dos, optionally scoped to one list",
    flags: todoListFlags,
    notes: ["Without --list: open items across the whole project; --completed includes done ones"],
    handler: todosList,
  },
  {
    path: ["todos", "show"],
    category: CATEGORY,
    summary: "One to-do in full, with assignees",
    args: [recordingArg("To-do id or URL")],
    handler: todosShow,
  },
  {
    path: ["todos", "add"],
    summary: "Add a to-do",
    ...addSpec,
  },
  {
    path: ["todo"],
    summary: "Add a to-do (shortcut for todos add)",
    ...addSpec,
  },
  {
    path: ["todos", "update"],
    category: CATEGORY,
    summary: "Edit a to-do's title, dates, or notes",
    args: [recordingArg("To-do id or URL")],
    flags: [
      { flag: "--title <title>", description: "New title" },
      { flag: "-d, --due <date>", description: 'New due date ("none" clears it)' },
      { flag: "--start <date>", description: 'New start date ("none" clears it)' },
      { flag: "--notes <markdown>", description: "New notes, as Markdown (or - for stdin)" },
      plainFlag,
    ],
    handler: todosUpdate,
  },
  {
    path: ["todos", "complete"],
    category: CATEGORY,
    summary: "Complete to-dos (comma-separate for several)",
    args: [{ name: "id", description: "To-do id(s)", required: true }],
    handler: completion(true),
  },
  {
    path: ["todos", "uncomplete"],
    category: CATEGORY,
    summary: "Reopen completed to-dos",
    args: [{ name: "id", description: "To-do id(s)", required: true }],
    handler: completion(false),
  },
  {
    path: ["done"],
    category: CATEGORY,
    summary: "Complete to-dos (shortcut for todos complete)",
    args: [{ name: "id", description: "To-do id(s), comma-separated", required: true }],
    handler: completion(true),
  },
  {
    path: ["reopen"],
    category: CATEGORY,
    summary: "Reopen completed to-dos (shortcut for todos uncomplete)",
    args: [{ name: "id", description: "To-do id(s), comma-separated", required: true }],
    handler: completion(false),
  },
  {
    path: ["assign"],
    category: CATEGORY,
    summary: "Assign a to-do, card, or step",
    args: [
      { name: "id", description: "Recording id", required: true },
      { name: "person", description: '"me", a name, or an email', variadic: true },
    ],
    flags: [
      { flag: "--add", description: "Add to the current assignees instead of replacing" },
      { flag: "--remove", description: "Remove these people instead of replacing" },
      { flag: "--none", description: "Clear every assignment" },
    ],
    notes: ["Without --add/--remove the given people REPLACE the assignee set"],
    handler: assign,
  },
  {
    path: ["todolists"],
    category: CATEGORY,
    summary: "List a project's to-do lists",
    flags: [inFlag],
    handler: listsList,
  },
  {
    path: ["todolists", "list"],
    category: CATEGORY,
    summary: "List a project's to-do lists",
    flags: [inFlag],
    handler: listsList,
  },
  {
    path: ["todolists", "create"],
    category: CATEGORY,
    summary: "Create a to-do list",
    args: [{ name: "title", description: "List title", required: true }],
    flags: [inFlag, { flag: "--notes <markdown>", description: "Description under the list title (Markdown)" }, plainFlag],
    handler: listsCreate,
  },
];
