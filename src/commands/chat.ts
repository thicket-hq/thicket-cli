// Project chat: post a line, read recent history.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { bodyFields } from "../lib/markdown.js";
import { CliError, clip, type CommandResult } from "../lib/output.js";
import { readBody, resolveRecordingRef } from "../lib/refs.js";
import type { CommandSpec } from "../lib/registry.js";
import { resolveTool } from "../lib/resolve.js";
import { detailLines, stripHtml, type RecordingRow } from "../lib/rows.js";
import { markdownNotes, plainFlag, recordingArg } from "../lib/specs.js";
import { recordingUrl } from "../lib/urls.js";

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
  const text = await readBody(args[0]);
  if (!text?.trim()) throw new CliError("usage", "Nothing to say", 'thicket chat post "text" --in <project>');
  const tool = await resolveTool(ctx, requireIn(options), "chat");
  const org = await ctx.org();
  const created = (await org.recordings.createChild(tool.containerId, {
    type: "chat_message",
    ...(await bodyFields(ctx, {
      content: options.html ? undefined : text,
      contentHtml: options.html ? text : undefined,
      plain: options.plain === true,
    })),
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

async function line(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const org = await ctx.org();
  const row = (await org.recordings.get(ref.id)) as RecordingRow & { creator_id?: string | null };
  if (row.type !== "chat_message") {
    throw new CliError("not_found", `${ref.id} is a ${row.type ?? "recording"}, not a chat line`, `Read it with: thicket show ${ref.id}`);
  }
  const slug = await ctx.orgSlug();
  const web_url = recordingUrl(ctx.settings.baseUrl, slug, {
    id: row.id,
    type: row.type,
    project_id: (row.project_id as string | null | undefined) ?? null,
    parent_id: (row.parent_id as string | null | undefined) ?? null,
  });
  return {
    data: { ...row, text: stripHtml(String(row.content ?? "")), web_url },
    summary: `${row.creator_name ?? "someone"}: ${clip(stripHtml(String(row.content ?? "")), 80)}`,
    human: [
      `${pc.bold(row.creator_name ?? "someone")} ${pc.dim(String(row.created_at ?? ""))}${row.creator_id ? pc.dim(`  membership ${row.creator_id}`) : ""}`,
      `  ${stripHtml(String(row.content ?? ""))}`,
      ...detailLines(row).slice(1, 2),
      pc.dim(web_url),
    ],
    breadcrumbs: [
      { action: "history", cmd: `thicket chat history --in ${row.project_id ?? "<project>"}`, description: "The conversation around it" },
      { action: "reply", cmd: `thicket chat post "text" --in ${row.project_id ?? "<project>"}` },
    ],
  };
}

export const chatCommands: CommandSpec[] = [
  {
    path: ["chat", "post"],
    category: CATEGORY,
    summary: "Post a line to a project's chat room (Markdown; @mentions resolved)",
    args: [{ name: "text", description: "What to say, as Markdown (or - for stdin)", required: true }],
    flags: [inFlag, plainFlag, { flag: "--html", description: "Treat the text as raw HTML" }],
    notes: markdownNotes,
    handler: post,
  },
  {
    path: ["chat", "line"],
    category: CATEGORY,
    summary: "One chat line by id or URL",
    args: [recordingArg("Chat line id or URL")],
    handler: line,
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
