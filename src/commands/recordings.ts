// The generic recording surface: everything is a recording, so show and
// the trash/archive/restore lifecycle work on ANY id.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { CliError, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { resolveRecordingRef } from "../lib/refs.js";
import { detailLines, type RecordingRow } from "../lib/rows.js";
import { idOrUrlNote, recordingArg } from "../lib/specs.js";
import { recordingUrl } from "../lib/urls.js";

const CATEGORY = "Recordings";

async function show(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const org = await ctx.org();
  const row = (await org.recordings.get(ref.id)) as RecordingRow;
  const slug = await ctx.orgSlug();
  const web_url = recordingUrl(ctx.settings.baseUrl, slug, {
    id: row.id,
    type: row.type,
    project_id: (row.project_id as string | null | undefined) ?? null,
    parent_id: (row.parent_id as string | null | undefined) ?? null,
  });
  const crumbs = [
    { action: "thread", cmd: `thicket comments thread ${row.id}`, description: "The whole thread with mention tokens" },
    { action: "comment", cmd: `thicket comment ${row.id} "text"` },
  ];
  if (row.type === "todo" || row.type === "card") {
    crumbs.unshift({ action: "done", cmd: `thicket done ${row.id}` });
  }
  return {
    data: { ...row, web_url },
    summary: String(row.title ?? row.id),
    human: [...detailLines(row), pc.dim(web_url)],
    breadcrumbs: crumbs,
  };
}

function lifecycle(
  status: "trashed" | "archived" | "active",
  verb: string,
): CommandSpec["handler"] {
  return async (ctx, args) => {
    const org = await ctx.org();
    const ids = args[0]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => resolveRecordingRef(ctx, s).id);
    if (ids.length === 0) {
      throw new CliError("usage", "No recording ids given");
    }
    for (const id of ids) {
      await org.recordings.setStatus(id, status);
    }
    return {
      data: { ids, status },
      summary: `${verb} ${ids.length} recording${ids.length === 1 ? "" : "s"}`,
      human: [`${pc.green(`${verb}.`)} ${ids.join(", ")}`],
      ids,
    };
  };
}

const idArg = {
  name: "id",
  description: "Recording id(s), comma-separated",
  required: true,
};

export const recordingCommands: CommandSpec[] = [
  {
    path: ["show"],
    category: CATEGORY,
    summary: "Show any recording by id or URL, whatever its type",
    args: [recordingArg()],
    notes: [idOrUrlNote, "The response carries web_url, the item's link in the app; assignee_ids and mentioned_membership_ids ride the recording"],
    handler: show,
  },
  {
    path: ["trash"],
    category: CATEGORY,
    summary: "Move recordings to the trash (recoverable for 30 days)",
    args: [idArg],
    notes: ["Trash is what \"delete\" means here; nothing on this command hard-deletes"],
    handler: lifecycle("trashed", "Trashed"),
  },
  {
    path: ["archive"],
    category: CATEGORY,
    summary: "Archive recordings",
    args: [idArg],
    handler: lifecycle("archived", "Archived"),
  },
  {
    path: ["restore"],
    category: CATEGORY,
    summary: "Restore trashed or archived recordings",
    args: [idArg],
    handler: lifecycle("active", "Restored"),
  },
];
