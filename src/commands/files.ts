// Docs & Files: documents, uploads, folders — one tool, one container.
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { CliError, clip, day, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { looksLikeId, matchNamed, resolveTool } from "../lib/resolve.js";
import { detailLines, type RecordingRow } from "../lib/rows.js";

const CATEGORY = "Docs & Files";

const inFlag = { flag: "-i, --in <project>", description: "Project name or id" };
const folderFlag = {
  flag: "-f, --folder <folder>",
  description: "Folder name or id (default: the project's top level)",
};

function requireIn(options: Record<string, unknown>): string {
  const value = options.in;
  if (typeof value !== "string" || !value) {
    throw new CliError("usage", "This command needs a project", "Pass --in <project name or id>");
  }
  return value;
}

async function resolveFolder(
  ctx: CliContext,
  options: Record<string, unknown>,
): Promise<{ id: string; projectName: string; projectId: string }> {
  const tool = await resolveTool(ctx, requireIn(options), "folder");
  if (!options.folder) {
    return {
      id: tool.containerId,
      projectName: tool.projectName,
      projectId: tool.projectId,
    };
  }
  const ref = String(options.folder);
  if (looksLikeId(ref)) {
    return { id: ref, projectName: tool.projectName, projectId: tool.projectId };
  }
  const org = await ctx.org();
  const folders = (await org.recordings.children(tool.containerId, {
    type: "folder",
  })) as RecordingRow[];
  const match = matchNamed(
    folders.map((f) => ({ id: f.id, name: String(f.title ?? "") })),
    ref,
    "folder",
  );
  return { id: match.id, projectName: tool.projectName, projectId: tool.projectId };
}

async function filesList(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const folder = await resolveFolder(ctx, options);
  const org = await ctx.org();
  const rows = (await org.recordings.children(folder.id)) as RecordingRow[];
  return {
    data: rows,
    summary: `${rows.length} item${rows.length === 1 ? "" : "s"} in "${folder.projectName}"`,
    human: table(
      ["TYPE", "TITLE", "BY", "UPDATED", "ID"],
      rows.map((r) => [
        String(r.type ?? ""),
        clip(String(r.title ?? ""), 44),
        clip(r.creator_name ?? "", 18),
        day(r.updated_at),
        r.id,
      ]),
    ),
    breadcrumbs: [
      { action: "show", cmd: "thicket docs show <id>", description: "Read a doc" },
      { action: "download", cmd: "thicket files download <id>" },
      { action: "upload", cmd: "thicket files upload <path> --in <project>" },
    ],
  };
}

async function docsList(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const folder = await resolveFolder(ctx, options);
  const org = await ctx.org();
  const rows = (await org.recordings.children(folder.id, {
    type: "document",
  })) as RecordingRow[];
  return {
    data: rows,
    summary: `${rows.length} doc${rows.length === 1 ? "" : "s"} in "${folder.projectName}"`,
    human: table(
      ["TITLE", "BY", "UPDATED", "ID"],
      rows.map((r) => [
        clip(String(r.title ?? ""), 50),
        clip(r.creator_name ?? "", 18),
        day(r.updated_at),
        r.id,
      ]),
    ),
    breadcrumbs: [{ action: "show", cmd: "thicket docs show <id>" }],
  };
}

async function docsShow(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const org = await ctx.org();
  const row = (await org.recordings.get(args[0])) as RecordingRow;
  return {
    data: row,
    summary: String(row.title ?? row.id),
    human: detailLines(row),
    breadcrumbs: [
      { action: "comment", cmd: `thicket comment ${row.id} "text"` },
    ],
  };
}

async function docsCreate(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const folder = await resolveFolder(ctx, options);
  const org = await ctx.org();
  const body: Record<string, unknown> = { type: "document", title: args[0] };
  if (options.contentHtml) body.content_html = options.contentHtml;
  else if (options.content) body.content = options.content;
  const created = (await org.recordings.createChild(
    folder.id,
    body as { type: string },
  )) as RecordingRow;
  return {
    data: created,
    summary: `Created doc "${created.title}"`,
    human: [`${pc.green("Created.")} ${created.title} (${created.id})`],
  };
}

async function docsUpdate(
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

async function upload(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const path = args[0];
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new CliError("usage", `Not a readable file: ${path}`);
  }
  const folder = await resolveFolder(ctx, options);
  const filename = options.name ? String(options.name) : basename(path);
  const bytes = await readFile(path);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), filename);
  if (options.notify) form.append("notify", String(options.notify));
  const slug = await ctx.orgSlug();
  const response = await ctx.rawFetch(
    `/api/v1/${slug}/recordings/${folder.id}/uploads`,
    { method: "POST", body: form },
  );
  const created = (await response.json().catch(() => null)) as
    | RecordingRow
    | { error?: { message?: string } }
    | null;
  if (!response.ok || !created || !("id" in created)) {
    throw new CliError(
      "api",
      (created as { error?: { message?: string } })?.error?.message ??
        `Upload failed (HTTP ${response.status})`,
    );
  }
  return {
    data: created,
    summary: `Uploaded "${filename}" (${info.size} bytes) to "${folder.projectName}"`,
    human: [`${pc.green("Uploaded.")} ${filename} (${created.id})`],
    breadcrumbs: [
      { action: "download", cmd: `thicket files download ${created.id}` },
    ],
  };
}

async function download(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const row = (await org.recordings.get(args[0])) as RecordingRow;
  const slug = await ctx.orgSlug();
  const response = await ctx.rawFetch(
    `/api/v1/${slug}/uploads/${args[0]}/download`,
  );
  if (!response.ok || !response.body) {
    throw new CliError("api", `Download failed (HTTP ${response.status})`);
  }
  const out = options.output
    ? String(options.output)
    : String(row.title ?? args[0]);
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(out),
  );
  return {
    data: { id: args[0], path: out },
    summary: `Saved to ${out}`,
    human: [`${pc.green("Saved.")} ${out}`],
  };
}

export const fileCommands: CommandSpec[] = [
  {
    path: ["files"],
    category: CATEGORY,
    summary: "List everything in a project's Docs & Files (bare shorthand)",
    flags: [inFlag, folderFlag],
    handler: filesList,
  },
  {
    path: ["files", "list"],
    category: CATEGORY,
    summary: "List everything in a project's Docs & Files",
    flags: [inFlag, folderFlag],
    handler: filesList,
  },
  {
    path: ["files", "upload"],
    category: CATEGORY,
    summary: "Upload a file to Docs & Files",
    args: [{ name: "path", description: "Local file to upload", required: true }],
    flags: [
      inFlag,
      folderFlag,
      { flag: "--name <filename>", description: "Store under a different filename" },
      { flag: "--notify <who>", description: '"everyone", "none", or membership ids (default: silent)' },
    ],
    handler: upload,
  },
  {
    path: ["files", "download"],
    category: CATEGORY,
    summary: "Download a file",
    args: [{ name: "id", description: "Upload id", required: true }],
    flags: [{ flag: "-o, --output <path>", description: "Where to save (default: the stored filename)" }],
    handler: download,
  },
  {
    path: ["upload"],
    category: CATEGORY,
    summary: "Upload a file (shortcut for files upload)",
    args: [{ name: "path", description: "Local file to upload", required: true }],
    flags: [
      inFlag,
      folderFlag,
      { flag: "--name <filename>", description: "Store under a different filename" },
      { flag: "--notify <who>", description: '"everyone", "none", or membership ids (default: silent)' },
    ],
    handler: upload,
  },
  {
    path: ["docs"],
    category: CATEGORY,
    summary: "List a project's docs (bare shorthand for docs list)",
    flags: [inFlag, folderFlag],
    handler: docsList,
  },
  {
    path: ["docs", "list"],
    category: CATEGORY,
    summary: "List a project's docs",
    flags: [inFlag, folderFlag],
    handler: docsList,
  },
  {
    path: ["docs", "show"],
    category: CATEGORY,
    summary: "Read a doc",
    args: [{ name: "id", description: "Doc id", required: true }],
    handler: docsShow,
  },
  {
    path: ["docs", "create"],
    category: CATEGORY,
    summary: "Create a doc",
    args: [{ name: "title", description: "Doc title", required: true }],
    flags: [
      inFlag,
      folderFlag,
      { flag: "-c, --content <text>", description: "Body as plain text" },
      { flag: "--content-html <html>", description: "Body as rich HTML (sanitized server-side)" },
    ],
    handler: docsCreate,
  },
  {
    path: ["docs", "update"],
    category: CATEGORY,
    summary: "Edit a doc",
    args: [{ name: "id", description: "Doc id", required: true }],
    flags: [
      { flag: "--title <title>", description: "New title" },
      { flag: "-c, --content <text>", description: "New body (plain text)" },
      { flag: "--content-html <html>", description: "New body (rich HTML)" },
    ],
    handler: docsUpdate,
  },
];
