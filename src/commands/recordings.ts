// The generic recording surface: everything is a recording, so show and
// the trash/archive/restore lifecycle work on ANY id.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { CliError, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { detailLines, type RecordingRow } from "../lib/rows.js";

const CATEGORY = "Recordings";

async function show(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const org = await ctx.org();
  const row = (await org.recordings.get(args[0])) as RecordingRow;
  const crumbs = [
    { action: "comments", cmd: `thicket comments ${row.id}` },
    { action: "comment", cmd: `thicket comment ${row.id} "text"` },
  ];
  if (row.type === "todo" || row.type === "card") {
    crumbs.unshift({ action: "done", cmd: `thicket done ${row.id}` });
  }
  return {
    data: row,
    summary: String(row.title ?? row.id),
    human: detailLines(row),
    breadcrumbs: crumbs,
  };
}

function lifecycle(
  status: "trashed" | "archived" | "active",
  verb: string,
): CommandSpec["handler"] {
  return async (ctx, args) => {
    const org = await ctx.org();
    const ids = args[0].split(",").map((s) => s.trim()).filter(Boolean);
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
    summary: "Show any recording by id, whatever its type",
    args: [{ name: "id", description: "Recording id", required: true }],
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
