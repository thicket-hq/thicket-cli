// The board (kanban) tool: columns, cards, moves. Completion IS the Done
// column, so `thicket done <card>` works on cards too.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { CliError, clip, day, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import {
  resolveColumn,
  resolvePeople,
  resolveProject,
  resolveTool,
} from "../lib/resolve.js";
import { detailLines, type RecordingRow } from "../lib/rows.js";
import { parseDate } from "../lib/dates.js";

const CATEGORY = "Cards";

const inFlag = { flag: "-i, --in <project>", description: "Project name or id" };

function requireIn(options: Record<string, unknown>): string {
  const value = options.in;
  if (typeof value !== "string" || !value) {
    throw new CliError("usage", "This command needs a project", "Pass --in <project name or id>");
  }
  return value;
}

async function columns(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const tool = await resolveTool(ctx, requireIn(options), "board");
  const org = await ctx.org();
  const rows = (await org.recordings.children(tool.containerId, {
    type: "column",
  })) as RecordingRow[];
  return {
    data: rows,
    summary: `${rows.length} column${rows.length === 1 ? "" : "s"} on "${tool.projectName}"`,
    human: table(
      ["COLUMN", "ID"],
      rows.map((c) => [clip(String(c.title ?? ""), 40), c.id]),
    ),
    breadcrumbs: [
      { action: "cards", cmd: `thicket cards --in ${tool.projectId} --column <column>` },
      { action: "create", cmd: 'thicket card "Title" --in <project> --column <column>' },
    ],
  };
}

async function list(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  let rows: RecordingRow[];
  let where: string;
  if (options.column) {
    const projectRef = requireIn(options);
    const column = await resolveColumn(ctx, projectRef, String(options.column));
    rows = (await org.recordings.children(column.id, {
      type: "card",
    })) as RecordingRow[];
    where = `in "${column.title}"`;
  } else {
    const project = await resolveProject(ctx, requireIn(options));
    rows = (await org.recordings.list({
      type: "card",
      project_id: project.id,
    })) as RecordingRow[];
    where = `on "${project.name}"`;
  }
  return {
    data: rows,
    summary: `${rows.length} card${rows.length === 1 ? "" : "s"} ${where}`,
    human: table(
      ["", "TITLE", "DUE", "ID"],
      rows.map((c) => [
        c.completed ? pc.green("✓") : "◯",
        clip(String(c.title ?? ""), 52),
        day(c.due_on),
        c.id,
      ]),
    ),
    breadcrumbs: [
      { action: "show", cmd: "thicket cards show <id>" },
      { action: "move", cmd: "thicket cards move <id> --to <column>" },
    ],
  };
}

async function show(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const org = await ctx.org();
  const row = (await org.recordings.get(args[0])) as RecordingRow;
  const steps = (await org.recordings
    .children(args[0], { type: "step" })
    .catch(() => [])) as RecordingRow[];
  const data = { ...row, steps };
  return {
    data,
    summary: String(row.title ?? row.id),
    human: [
      ...detailLines(row),
      ...(steps.length
        ? [
            "",
            pc.dim("Steps:"),
            ...steps.map(
              (s) => `  ${s.completed ? pc.green("✓") : "◯"} ${s.title} ${pc.dim(s.id)}`,
            ),
          ]
        : []),
    ],
    breadcrumbs: [
      { action: "move", cmd: `thicket cards move ${row.id} --to <column>` },
      { action: "comment", cmd: `thicket comment ${row.id} "text"` },
    ],
  };
}

async function create(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const projectRef = requireIn(options);
  if (!options.column) {
    throw new CliError("usage", "Which column should the card land in?", "Pass --column <name or id> (see: thicket cards columns --in <project>)");
  }
  const column = await resolveColumn(ctx, projectRef, String(options.column));
  const org = await ctx.org();
  const body: Record<string, unknown> = { type: "card", title: args[0] };
  if (options.content) body.content = options.content;
  if (options.due) body.due_on = parseDate(String(options.due));
  if (options.assignee) {
    body.assignee_ids = await resolvePeople(
      ctx,
      Array.isArray(options.assignee) ? options.assignee.map(String) : [String(options.assignee)],
    );
  }
  const created = (await org.recordings.createChild(
    column.id,
    body as { type: string },
  )) as RecordingRow;
  return {
    data: created,
    summary: `Added "${created.title}" to "${column.title}"`,
    human: [`${pc.green("Added.")} ${created.title} (${created.id}) in ${column.title}`],
    breadcrumbs: [
      { action: "show", cmd: `thicket cards show ${created.id}` },
    ],
  };
}

async function move(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  if (!options.to) {
    throw new CliError("usage", "Where should the card go?", "Pass --to <column name or id>");
  }
  const org = await ctx.org();
  const card = (await org.recordings.get(args[0])) as RecordingRow;
  const projectRef = String(options.in ?? card.project_id ?? "");
  if (!projectRef) {
    throw new CliError("usage", "Could not determine the card's project", "Pass --in <project>");
  }
  const column = await resolveColumn(ctx, projectRef, String(options.to));
  await org.recordings.move(args[0], {
    parent_id: column.id,
    ...(options.position !== undefined
      ? { position: Number(options.position) }
      : {}),
  });
  return {
    data: { id: args[0], column_id: column.id },
    summary: `Moved "${card.title}" to "${column.title}"`,
    human: [`${pc.green("Moved.")} ${card.title} → ${column.title}`],
  };
}

const cardListFlags = [
  inFlag,
  { flag: "--column <column>", description: "Only this column's cards" },
];

const createSpec: Omit<CommandSpec, "path" | "summary"> = {
  category: CATEGORY,
  args: [{ name: "title", description: "Card title", required: true }],
  flags: [
    inFlag,
    { flag: "--column <column>", description: "Column name or id (required)" },
    { flag: "-c, --content <text>", description: "Card description" },
    { flag: "-d, --due <date>", description: "Due date (natural language ok)" },
    { flag: "-a, --assignee <person...>", description: 'Assign people: "me", a name, or an email' },
  ],
  handler: create,
};

export const cardCommands: CommandSpec[] = [
  {
    path: ["cards"],
    category: CATEGORY,
    summary: "List a project's cards (bare shorthand for cards list)",
    flags: cardListFlags,
    handler: list,
  },
  {
    path: ["cards", "list"],
    category: CATEGORY,
    summary: "List a project's cards, optionally scoped to one column",
    flags: cardListFlags,
    handler: list,
  },
  {
    path: ["cards", "columns"],
    category: CATEGORY,
    summary: "List a board's columns",
    flags: [inFlag],
    handler: columns,
  },
  {
    path: ["cards", "show"],
    category: CATEGORY,
    summary: "One card in full, with its steps",
    args: [{ name: "id", description: "Card id", required: true }],
    handler: show,
  },
  { path: ["cards", "create"], summary: "Add a card to a column", ...createSpec },
  { path: ["card"], summary: "Add a card to a column (shortcut)", ...createSpec },
  {
    path: ["cards", "move"],
    category: CATEGORY,
    summary: "Move a card to another column",
    args: [{ name: "id", description: "Card id", required: true }],
    flags: [
      { flag: "--to <column>", description: "Destination column name or id" },
      { flag: "--position <n>", description: "Position inside the column" },
      inFlag,
    ],
    notes: ["Moving into the Done column completes the card; out of it reopens it"],
    handler: move,
  },
];
