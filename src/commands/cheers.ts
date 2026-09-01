// Cheers: the short reaction (16 characters) that doubles as an agent's ack.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { readBody, resolveRecordingRef } from "../lib/refs.js";
import { CliError, clip, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { looksLikeId, resolvePeople } from "../lib/resolve.js";
import { recordingArg } from "../lib/specs.js";

const CATEGORY = "Cheers";

async function cheer(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const content = (await readBody(args[1]))?.trim();
  if (!content) throw new CliError("usage", "What is the cheer?", 'e.g. thicket cheer <id> "On it!"');
  if ([...content].length > 16) {
    throw new CliError("validation", "A cheer is at most 16 characters of text or emoji");
  }
  const org = await ctx.org();
  if (options.event) {
    const eventId = String(options.event);
    if (!looksLikeId(eventId)) throw new CliError("usage", "--event needs an event id");
    const result = await org.request<{ already_cheered?: boolean; id?: string }>(
      "POST",
      `/events/${eventId}/cheers`,
      { body: { content } },
    );
    return {
      data: { event_id: eventId, content, ...result },
      summary: result.already_cheered ? "Already cheered that event with the same content" : `Cheered event ${eventId}`,
      human: [pc.green(result.already_cheered ? "Already cheered." : "Cheered.")],
    };
  }
  const ref = resolveRecordingRef(ctx, args[0]);
  const target = ref.commentId ?? ref.id;
  const created = await org.request<{ id: string; content: string }>(
    "POST",
    `/recordings/${target}/cheers`,
    { body: { content } },
  );
  return {
    data: { ...created, recording_id: target },
    summary: `Cheered "${content}"`,
    human: [`${pc.green("Cheered.")} ${content} (${created.id})`],
    breadcrumbs: [{ action: "remove", cmd: `thicket cheers remove ${created.id}` }],
  };
}

async function mine(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const query: Record<string, string> = {};
  if (options.since) {
    if (Number.isNaN(Date.parse(String(options.since)))) throw new CliError("usage", "--since needs an ISO 8601 instant");
    query.since = new Date(String(options.since)).toISOString();
  }
  type Row = {
    id: string;
    content: string;
    created_at: string;
    cheerer_name: string | null;
    cheerer_membership_id: string;
    recording_id: string;
    recording_type: string;
    recording_title: string | null;
    project_name: string | null;
  };
  const feed = await org.request<{ received: Row[]; given: Row[] }>("GET", "/my/cheers", { query });
  let received = feed.received ?? [];
  const given = feed.given ?? [];
  if (options.from) {
    const [who] = await resolvePeople(ctx, [String(options.from)]);
    received = received.filter((r) => r.cheerer_membership_id === who);
  }
  const which = options.given ? "given" : options.received ? "received" : "both";
  const data = which === "given" ? { given } : which === "received" ? { received } : { received, given };
  const render = (rows: Row[], who: (r: Row) => string) =>
    rows.map(
      (r) =>
        `  ${pc.bold(r.content)} ${who(r)} ${pc.dim(`on ${clip(r.recording_title ?? r.recording_type, 40)} · ${r.project_name ?? ""} · ${r.created_at.slice(0, 16)}`)}`,
    );
  return {
    data,
    summary: `${received.length} received, ${given.length} given`,
    human: [
      ...(which !== "given" ? [pc.bold("Received"), ...(received.length ? render(received, (r) => `from ${r.cheerer_name ?? r.cheerer_membership_id}`) : ["  none"]), ""] : []),
      ...(which !== "received" ? [pc.bold("Given"), ...(given.length ? render(given, () => "") : ["  none"])] : []),
    ],
    breadcrumbs: [{ action: "show", cmd: "thicket show <recording_id>" }],
  };
}

async function on(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const org = await ctx.org();
  type Row = { id: string; content: string; membership_id: string; name: string | null; created_at: string };
  const rows = await org.request<Row[]>("GET", `/recordings/${ref.commentId ?? ref.id}/cheers`);
  return {
    data: rows,
    summary: `${rows.length} cheer${rows.length === 1 ? "" : "s"}`,
    human: rows.length
      ? table(["CHEER", "BY", "MEMBERSHIP", "WHEN", "ID"], rows.map((r) => [r.content, r.name ?? "", r.membership_id, r.created_at.slice(0, 16), r.id]))
      : ["No cheers yet."],
  };
}

async function remove(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const org = await ctx.org();
  await org.request("DELETE", `/cheers/${args[0]}`);
  return { data: { id: args[0], removed: true }, summary: "Cheer removed", human: [pc.green("Removed.")] };
}

const cheerSpec: Omit<CommandSpec, "path" | "summary"> = {
  category: CATEGORY,
  args: [
    recordingArg("Recording id or URL (omit with --event)"),
    { name: "content", description: "Up to 16 characters of text or emoji (or - for stdin)", required: true },
  ],
  flags: [{ flag: "--event <eventId>", description: "Cheer a change-log event instead of a recording" }],
  notes: [
    "Cheering notifies the recording's author only; a duplicate cheer on an event answers already_cheered",
    'An agent acks a directive with a cheer: thicket cheer <url> "On it!"',
  ],
  handler: cheer,
};

const myFlags = [
  { flag: "--since <iso>", description: "Only cheers created after this instant" },
  { flag: "--from <person>", description: "Only cheers from this person (name, email, or membership id)" },
  { flag: "--received", description: "Received cheers only" },
  { flag: "--given", description: "Given cheers only" },
];

export const cheerCommands: CommandSpec[] = [
  { path: ["cheer"], summary: "Cheer a recording (a short reaction, the agent ack)", ...cheerSpec },
  {
    path: ["cheers"],
    category: CATEGORY,
    summary: "Cheers you received and gave (bare shorthand for cheers list)",
    flags: myFlags,
    handler: mine,
  },
  {
    path: ["cheers", "list"],
    category: CATEGORY,
    summary: "Cheers you received and gave",
    flags: myFlags,
    notes: ["--since is the agent runtime's cheer-trigger cursor; --from gates on who cheered"],
    handler: mine,
  },
  { path: ["cheers", "add"], summary: "Cheer a recording", ...cheerSpec },
  {
    path: ["cheers", "on"],
    category: CATEGORY,
    summary: "The cheers on one recording",
    args: [recordingArg()],
    handler: on,
  },
  {
    path: ["cheers", "remove"],
    category: CATEGORY,
    summary: "Remove a cheer you left (admins can remove anyone's)",
    args: [{ name: "id", description: "Cheer id", required: true }],
    handler: remove,
  },
];
