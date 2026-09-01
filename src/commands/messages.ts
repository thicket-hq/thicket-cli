// Message board + the flat comment surface every recording shares.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { bodyFields, mentionToken } from "../lib/markdown.js";
import { CliError, clip, day, table, type CommandResult } from "../lib/output.js";
import { readBody, resolveRecordingRef } from "../lib/refs.js";
import type { CommandSpec } from "../lib/registry.js";
import { resolveTool } from "../lib/resolve.js";
import { detailLines, stripHtml, type RecordingRow } from "../lib/rows.js";
import { contentFlags, idOrUrlNote, markdownNotes, plainFlag, recordingArg } from "../lib/specs.js";
import { recordingUrl } from "../lib/urls.js";

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
  const row = (await org.recordings.get(resolveRecordingRef(ctx, args[0]).id)) as RecordingRow;
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
  const body: Record<string, unknown> = {
    type: "message",
    title: args[0],
    ...(await bodyFields(ctx, {
      content: await readBody(options.content),
      contentHtml: options.contentHtml as string | undefined,
      plain: options.plain === true,
    })),
  };
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
  const body: Record<string, unknown> = {
    ...(await bodyFields(ctx, {
      content: await readBody(options.content),
      contentHtml: options.contentHtml as string | undefined,
      plain: options.plain === true,
    })),
  };
  if (options.title !== undefined) body.title = options.title;
  if (Object.keys(body).length === 0) {
    throw new CliError("usage", "Nothing to update", "Pass --title or --content");
  }
  const org = await ctx.org();
  const id = resolveRecordingRef(ctx, args[0]).id;
  const updated = (await org.request("PATCH", `/recordings/${id}`, {
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
    const id = resolveRecordingRef(ctx, args[0]).id;
    await org.request(on ? "PUT" : "DELETE", `/recordings/${id}/pin`);
    return {
      data: { id, pinned: on },
      summary: on ? "Pinned to the top of the board" : "Unpinned",
      human: [pc.green(on ? "Pinned." : "Unpinned.")],
    };
  };
}

async function commentsList(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const org = await ctx.org();
  const rows = await org.request<RecordingRow[]>(
    "GET",
    `/recordings/${ref.id}/comments`,
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
      { action: "thread", cmd: `thicket comments thread ${ref.id}`, description: "The recording plus every comment, with mention tokens" },
      { action: "comment", cmd: `thicket comment ${ref.id} "text"`, description: "Reply (comments are flat: always on the parent recording)" },
    ],
  };
}

type ThreadAuthor = { membership_id: string; name: string; mention: string };

/** The whole thread: the recording's text plus every comment, oldest first. */
async function commentsThread(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const org = await ctx.org();
  const slug = await ctx.orgSlug();
  const recording = (await org.recordings.get(ref.id)) as RecordingRow & {
    creator_id?: string | null;
    assignee_ids?: string[];
    mentioned_membership_ids?: string[];
  };
  const comments = (await org.request<(RecordingRow & { creator_id?: string | null })[]>(
    "GET",
    `/recordings/${ref.id}/comments`,
  )).sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const web_url = recordingUrl(ctx.settings.baseUrl, slug, {
    id: recording.id,
    type: recording.type,
    project_id: (recording.project_id as string | null | undefined) ?? null,
    parent_id: (recording.parent_id as string | null | undefined) ?? null,
  });
  const authors = new Map<string, ThreadAuthor>();
  const author = (id: string | null | undefined, name: string | null | undefined): ThreadAuthor | null => {
    if (!id) return null;
    const existing = authors.get(id);
    if (existing) return existing;
    const entry = { membership_id: id, name: name ?? "someone", mention: mentionToken(id, name ?? "someone") };
    authors.set(id, entry);
    return entry;
  };
  const rootAuthor = author(recording.creator_id, recording.creator_name);
  const entries = [
    {
      kind: "recording" as const,
      id: recording.id,
      type: recording.type ?? "recording",
      title: recording.title ?? null,
      author: rootAuthor,
      created_at: recording.created_at ?? null,
      text: stripHtml(String(recording.content ?? "")),
      html: recording.content ?? null,
      web_url,
    },
    ...comments.map((c) => ({
      kind: "comment" as const,
      id: c.id,
      type: "comment",
      title: null,
      author: author(c.creator_id, c.creator_name),
      created_at: c.created_at ?? null,
      text: stripHtml(String(c.content ?? "")),
      html: c.content ?? null,
      web_url: `${web_url}#comment-${c.id}`,
    })),
  ];
  const data = {
    recording: { ...recording, web_url },
    entries,
    authors: [...authors.values()],
    reply_cmd: `thicket comment ${recording.id} "<markdown>"`,
  };
  const human: string[] = [
    `${pc.bold(recording.title ?? "(untitled)")} ${pc.dim(`${recording.type} · ${recording.id}`)}`,
    pc.dim(web_url),
    "",
  ];
  for (const e of entries) {
    human.push(
      `${pc.bold(e.author?.name ?? "someone")} ${pc.dim(String(e.created_at ?? "").slice(0, 16))}${e.author ? pc.dim(`  ${e.author.mention}`) : ""}`,
    );
    human.push(...(e.text ? e.text.split("\n").map((l) => `  ${l}`) : [pc.dim("  (no text)")]));
    human.push("");
  }
  if (authors.size) {
    human.push(pc.dim("Mention tokens (paste into a reply):"));
    for (const a of authors.values()) human.push(`  ${a.mention}`);
  }
  return {
    data,
    summary: `${comments.length} comment${comments.length === 1 ? "" : "s"} on "${recording.title ?? recording.id}"; ${authors.size} author${authors.size === 1 ? "" : "s"}`,
    human,
    breadcrumbs: [
      { action: "reply", cmd: `thicket comment ${recording.id} "..."`, description: "Reply on the recording (Markdown; @mention with the tokens above)" },
      { action: "cheer", cmd: `thicket cheer ${recording.id} "On it!"` },
    ],
  };
}

async function commentAdd(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const text = await readBody(args[1]);
  if (!text?.trim()) throw new CliError("usage", "The comment is empty", 'thicket comment <id> "text" (or - for stdin)');
  const org = await ctx.org();
  const body = await bodyFields(ctx, {
    content: options.html ? undefined : text,
    contentHtml: options.html ? text : undefined,
    plain: options.plain === true,
  });
  const created = (await org.recordings.comment(ref.id, body)) as RecordingRow;
  return {
    data: created,
    summary: "Comment posted",
    human: [`${pc.green("Posted.")} (${created.id})`],
    breadcrumbs: [{ action: "thread", cmd: `thicket comments thread ${ref.id}` }],
  };
}

const postFlags = [
  inFlag,
  ...contentFlags("Body"),
  { flag: "--draft", description: "Save as an unpublished draft" },
  { flag: "--notify <who>", description: '"everyone" (default), "none", or comma-separated membership ids' },
];

const postSpec: Omit<CommandSpec, "path" | "summary"> = {
  category: CATEGORY,
  args: [{ name: "title", description: "Message title", required: true }],
  flags: postFlags,
  notes: markdownNotes,
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
    args: [recordingArg("Message id or URL")],
    handler: show,
  },
  { path: ["messages", "post"], summary: "Post to the message board", ...postSpec },
  { path: ["message"], summary: "Post to the message board (shortcut)", ...postSpec },
  {
    path: ["messages", "update"],
    category: CATEGORY,
    summary: "Edit a message",
    args: [recordingArg("Message id or URL")],
    flags: [
      { flag: "--title <title>", description: "New title" },
      ...contentFlags("New body"),
    ],
    notes: markdownNotes,
    handler: update,
  },
  {
    path: ["messages", "pin"],
    category: CATEGORY,
    summary: "Pin a message to the top of its board",
    args: [recordingArg("Message id or URL")],
    handler: pin(true),
  },
  {
    path: ["messages", "unpin"],
    category: CATEGORY,
    summary: "Unpin a message",
    args: [recordingArg("Message id or URL")],
    handler: pin(false),
  },
  {
    path: ["comments"],
    category: CATEGORY,
    summary: "List the comments on any recording",
    args: [recordingArg()],
    notes: ["Comments are flat: reply to the parent recording, never to a comment", idOrUrlNote],
    handler: commentsList,
  },
  {
    path: ["comments", "list"],
    category: CATEGORY,
    summary: "List the comments on any recording",
    args: [recordingArg()],
    handler: commentsList,
  },
  {
    path: ["comments", "thread"],
    category: CATEGORY,
    summary: "The full thread: the recording's text plus every comment, oldest first, with mention tokens",
    args: [recordingArg()],
    notes: [
      "entries[].author.mention is the paste-ready [@Name](member:<uuid>) token for a reply",
      "Reply on recording.id (comments are flat), never on a comment id",
      idOrUrlNote,
    ],
    handler: commentsThread,
  },
  {
    path: ["comment"],
    category: CATEGORY,
    summary: "Comment on any recording (Markdown; @mentions resolved)",
    args: [
      recordingArg(),
      { name: "text", description: "Comment body as Markdown (or - for stdin)", required: true },
    ],
    flags: [
      plainFlag,
      { flag: "--html", description: "Treat the text as raw HTML instead of Markdown" },
    ],
    notes: markdownNotes,
    handler: commentAdd,
  },
];
