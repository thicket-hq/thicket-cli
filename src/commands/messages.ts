// Message board + the flat comment surface every recording shares.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { CliError, clip, day, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { resolveTool } from "../lib/resolve.js";
import { detailLines, stripHtml, type RecordingRow } from "../lib/rows.js";

const CATEGORY = "Messages";

const inFlag = { flag: "-i, --in <project>", description: "Project name or id" };

function requireIn(options: Record<string, unknown>): string {
  const value = options.in;
  if (typeof value !== "string" || !value) {
    throw new CliError("usage", "This command needs a project", "Pass --in <project name or id>");
  }
  return value;
}

async function list(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const tool = await resolveTool(ctx, requireIn(options), "message_board");
  const org = await ctx.org();
  const rows = (await org.recordings.children(tool.containerId, {
    type: "message",
  })) as RecordingRow[];
  return {
    data: rows,
    summary: `${rows.length} message${rows.length === 1 ? "" : "s"} on "${tool.projectName}"`,
    human: table(
      ["TITLE", "BY", "COMMENTS", "POSTED", "ID"],
      rows.map((m) => [
        clip(String(m.title ?? ""), 44),
        clip(m.creator_name ?? "", 20),
        String(m.comment_count ?? 0),
        day(m.created_at),
        m.id,
      ]),
    ),
    breadcrumbs: [
      { action: "show", cmd: "thicket messages show <id>" },
      { action: "post", cmd: 'thicket message "Title" --content "..." --in <project>' },
    ],
  };
}

async function show(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const org = await ctx.org();
  const row = (await org.recordings.get(args[0])) as RecordingRow;
  return {
    data: row,
    summary: String(row.title ?? row.id),
    human: detailLines(row),
    breadcrumbs: [
      { action: "comments", cmd: `thicket comments ${row.id}` },
      { action: "comment", cmd: `thicket comment ${row.id} "text"` },
    ],
  };
}

async function post(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const tool = await resolveTool(ctx, requireIn(options), "message_board");
  const org = await ctx.org();
  const body: Record<string, unknown> = { type: "message", title: args[0] };
  if (options.contentHtml) body.content_html = options.contentHtml;
  else if (options.content) body.content = options.content;
  if (options.draft) body.status = "drafted";
  if (options.notify) {
    const notify = String(options.notify);
    body.notify =
      notify === "everyone" || notify === "none" ? notify : notify.split(",");
  }
  const created = (await org.recordings.createChild(
    tool.containerId,
    body as { type: string },
  )) as RecordingRow;
  return {
    data: created,
    summary: `${options.draft ? "Drafted" : "Posted"} "${created.title}" to "${tool.projectName}"`,
    human: [
      `${pc.green(options.draft ? "Drafted." : "Posted.")} ${created.title} (${created.id})`,
    ],
    breadcrumbs: [
      { action: "show", cmd: `thicket messages show ${created.id}` },
    ],
  };
}

async function update(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const body: Record<string, unknown> = {};
  if (options.title !== undefined) body.title = options.title;
  if (options.contentHtml !== undefined) body.content_html = options.contentHtml;
  else if (options.content !== undefined) body.content = options.content;
  if (Object.keys(body).length === 0) {
    throw new CliError("usage", "Nothing to update", "Pass --title or --content");
  }
  const org = await ctx.org();
  const updated = (await org.request("PATCH", `/recordings/${args[0]}`, {
    body,
  })) as RecordingRow;
  return {
    data: updated,
    summary: `Updated "${updated.title}"`,
    human: [`${pc.green("Updated.")} ${updated.title}`],
  };
}

function pin(on: boolean): CommandSpec["handler"] {
  return async (ctx, args) => {
    const org = await ctx.org();
    await org.request(on ? "PUT" : "DELETE", `/recordings/${args[0]}/pin`);
    return {
      data: { id: args[0], pinned: on },
      summary: on ? "Pinned to the top of the board" : "Unpinned",
      human: [pc.green(on ? "Pinned." : "Unpinned.")],
    };
  };
}

async function commentsList(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const org = await ctx.org();
  const rows = await org.request<RecordingRow[]>(
    "GET",
    `/recordings/${args[0]}/comments`,
  );
  return {
    data: rows,
    summary: `${rows.length} comment${rows.length === 1 ? "" : "s"}`,
    human: rows.flatMap((c) => [
      `${pc.bold(c.creator_name ?? "someone")} ${pc.dim(String(c.created_at ?? ""))}`,
      `  ${clip(stripHtml(String(c.content ?? "")), 300)}`,
      "",
    ]),
    breadcrumbs: [
      { action: "comment", cmd: `thicket comment ${args[0]} "text"`, description: "Reply (comments are flat: always on the parent recording)" },
    ],
  };
}

async function commentAdd(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const org = await ctx.org();
  const created = (await org.recordings.comment(args[0], {
    content: args[1],
  })) as RecordingRow;
  return {
    data: created,
    summary: "Comment posted",
    human: [`${pc.green("Posted.")} (${created.id})`],
  };
}

const postFlags = [
  inFlag,
  { flag: "-c, --content <text>", description: "Body as plain text (becomes safe HTML)" },
  { flag: "--content-html <html>", description: "Body as rich HTML (sanitized server-side)" },
  { flag: "--draft", description: "Save as an unpublished draft" },
  { flag: "--notify <who>", description: '"everyone" (default), "none", or comma-separated membership ids' },
];

const postSpec: Omit<CommandSpec, "path" | "summary"> = {
  category: CATEGORY,
  args: [{ name: "title", description: "Message title", required: true }],
  flags: postFlags,
  handler: post,
};

export const messageCommands: CommandSpec[] = [
  {
    path: ["messages"],
    category: CATEGORY,
    summary: "List a project's message board (bare shorthand for messages list)",
    flags: [inFlag],
    handler: list,
  },
  {
    path: ["messages", "list"],
    category: CATEGORY,
    summary: "List a project's messages",
    flags: [inFlag],
    handler: list,
  },
  {
    path: ["messages", "show"],
    category: CATEGORY,
    summary: "One message in full",
    args: [{ name: "id", description: "Message id", required: true }],
    handler: show,
  },
  { path: ["messages", "post"], summary: "Post to the message board", ...postSpec },
  { path: ["message"], summary: "Post to the message board (shortcut)", ...postSpec },
  {
    path: ["messages", "update"],
    category: CATEGORY,
    summary: "Edit a message",
    args: [{ name: "id", description: "Message id", required: true }],
    flags: [
      { flag: "--title <title>", description: "New title" },
      { flag: "-c, --content <text>", description: "New body (plain text)" },
      { flag: "--content-html <html>", description: "New body (rich HTML)" },
    ],
    handler: update,
  },
  {
    path: ["messages", "pin"],
    category: CATEGORY,
    summary: "Pin a message to the top of its board",
    args: [{ name: "id", description: "Message id", required: true }],
    handler: pin(true),
  },
  {
    path: ["messages", "unpin"],
    category: CATEGORY,
    summary: "Unpin a message",
    args: [{ name: "id", description: "Message id", required: true }],
    handler: pin(false),
  },
  {
    path: ["comments"],
    category: CATEGORY,
    summary: "List the comments on any recording",
    args: [{ name: "id", description: "Recording id", required: true }],
    notes: ["Comments are flat: reply to the parent recording, never to a comment"],
    handler: commentsList,
  },
  {
    path: ["comment"],
    category: CATEGORY,
    summary: "Comment on any recording",
    args: [
      { name: "id", description: "Recording id", required: true },
      { name: "text", description: "Comment text", required: true },
    ],
    handler: commentAdd,
  },
];
