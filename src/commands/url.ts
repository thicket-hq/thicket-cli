// URLs <-> ids: what a pasted link points at, and the link for an id.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { resolveRecordingRef } from "../lib/refs.js";
import { CliError, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import type { RecordingRow } from "../lib/rows.js";
import { parseThicketUrl, recordingUrl } from "../lib/urls.js";

async function parse(_ctx: CliContext, args: string[]): Promise<CommandResult> {
  const parsed = parseThicketUrl(args[0]);
  if (!parsed) throw new CliError("usage", `Not a Thicket URL: ${args[0]}`, "Expected https://www.thickethq.com/o/<org>/...");
  return {
    data: parsed,
    summary: parsed.recording_id
      ? `${parsed.type} ${parsed.recording_id} in ${parsed.org}`
      : parsed.project_id
        ? `${parsed.type ?? "project"} page of project ${parsed.project_id} in ${parsed.org}`
        : `organization ${parsed.org}`,
    ids: parsed.recording_id ? [parsed.recording_id] : [],
    human: Object.entries(parsed).map(([k, v]) => `${pc.dim(k.padEnd(13))} ${v ?? ""}`),
    breadcrumbs: parsed.recording_id
      ? [{ action: "show", cmd: `thicket show ${parsed.recording_id} --org ${parsed.org}` }]
      : [],
  };
}

async function of(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const org = await ctx.org();
  const rec = (await org.recordings.get(ref.id)) as RecordingRow;
  const slug = await ctx.orgSlug();
  const url = recordingUrl(ctx.settings.baseUrl, slug, {
    id: rec.id,
    type: rec.type,
    project_id: rec.project_id ?? null,
    parent_id: rec.parent_id ?? null,
  });
  return {
    data: { id: rec.id, type: rec.type, title: rec.title ?? null, web_url: url, markdown_link: `[${rec.title ?? rec.type}](${url})` },
    summary: url,
    human: [url],
    ids: [url],
  };
}

export const urlCommands: CommandSpec[] = [
  {
    path: ["url", "parse"],
    category: "Meta",
    summary: "What an app URL points at: {org, project_id, recording_id, type}",
    args: [{ name: "url", description: "A thickethq.com link (or an /o/... path)", required: true }],
    handler: parse,
  },
  {
    path: ["url", "of"],
    category: "Meta",
    summary: "The app URL (and a titled Markdown link) for a recording",
    args: [{ name: "id", description: "Recording id", required: true }],
    handler: of,
  },
];
