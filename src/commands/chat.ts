// Project chat: post a line, read recent history.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { CliError, clip, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { resolveTool } from "../lib/resolve.js";
import { stripHtml, type RecordingRow } from "../lib/rows.js";

const CATEGORY = "Chat";

const inFlag = { flag: "-i, --in <project>", description: "Project name or id" };

function requireIn(options: Record<string, unknown>): string {
  const value = options.in;
  if (typeof value !== "string" || !value) {
    throw new CliError("usage", "This command needs a project", "Pass --in <project name or id>");
  }
  return value;
}

async function post(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const tool = await resolveTool(ctx, requireIn(options), "chat");
  const org = await ctx.org();
  const created = (await org.recordings.createChild(tool.containerId, {
    type: "chat_message",
    content: args[0],
  })) as RecordingRow;
  return {
    data: created,
    summary: `Posted to "${tool.projectName}" chat`,
    human: [`${pc.green("Posted.")} (${created.id})`],
    breadcrumbs: [
      { action: "history", cmd: `thicket chat history --in ${tool.projectId}` },
    ],
  };
}

async function history(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const tool = await resolveTool(ctx, requireIn(options), "chat");
  const org = await ctx.org();
  const limit = options.limit ? Number(options.limit) : 30;
  const rows = (await org.recordings.children(tool.containerId, {
    type: "chat_message",
    limit,
  })) as RecordingRow[];
  // Render oldest → newest, terminal-transcript style.
  const ordered = [...rows].sort((a, b) =>
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
  );
  return {
    data: ordered,
    summary: `${ordered.length} line${ordered.length === 1 ? "" : "s"} in "${tool.projectName}" chat`,
    human: ordered.map(
      (l) =>
        `${pc.dim(String(l.created_at ?? "").slice(0, 16))} ${pc.bold(l.creator_name ?? "someone")}: ${clip(stripHtml(String(l.content ?? "")), 120)}`,
    ),
    breadcrumbs: [
      { action: "post", cmd: `thicket chat post "text" --in ${tool.projectId}` },
    ],
  };
}

export const chatCommands: CommandSpec[] = [
  {
    path: ["chat", "post"],
    category: CATEGORY,
    summary: "Post a line to a project's chat room",
    args: [{ name: "text", description: "What to say", required: true }],
    flags: [inFlag],
    handler: post,
  },
  {
    path: ["chat", "history"],
    category: CATEGORY,
    summary: "Recent chat lines, oldest first",
    args: [],
    flags: [
      inFlag,
      { flag: "-n, --limit <n>", description: "How many lines (default 30)" },
    ],
    handler: history,
  },
];
