// The notification tray, and the agent inbox it doubles as: cursor reads,
// action filters, presence renewal, and --watch (the live stream as NDJSON).
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { inboxEvents, type NotificationRow } from "../lib/inbox.js";
import { CliError, clip, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { looksLikeId } from "../lib/resolve.js";
import { diag, makeAbort, ndjson } from "../lib/watch-io.js";

const CATEGORY = "Notifications";

function actions(options: Record<string, unknown>): string[] | undefined {
  if (!options.action) return undefined;
  const list = String(options.action)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function isoOrThrow(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const s = String(value);
  if (Number.isNaN(Date.parse(s))) {
    throw new CliError("usage", `${flag} needs an ISO 8601 instant, got "${s}"`, "e.g. --since 2026-09-01T12:00:00Z");
  }
  return new Date(s).toISOString();
}

async function list(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  if (options.watch) return watch(ctx, options);
  const org = await ctx.org();
  const query: Record<string, string | number | boolean> = {};
  const since = isoOrThrow(options.since, "--since");
  if (since) query.since = since;
  if (options.after) {
    if (!looksLikeId(String(options.after))) throw new CliError("usage", "--after needs a notification id");
    query.after = String(options.after);
  }
  const acts = actions(options);
  if (acts) query.action = acts.join(",");
  if (options.unread) query.unread = true;
  if (options.limit) query.limit = Number(options.limit);
  if (options.presence) query.presence = true;
  const page = await org.request<{
    unread_count: number;
    notifications: NotificationRow[];
    next_cursor?: { since: string | null; after: string | null };
  }>("GET", "/my/notifications", { query });
  const rows = page.notifications ?? [];
  return {
    data: page,
    summary: `${rows.length} notification${rows.length === 1 ? "" : "s"} (${page.unread_count} unread)`,
    ids: rows.map((r) => r.id),
    human: rows.length
      ? rows.map(
          (n) =>
            `${n.read_at ? "  " : pc.yellow("● ")}${pc.dim(n.created_at.slice(0, 16))} ${pc.bold(n.actor_name ?? n.title)} ${n.action}${n.directive ? pc.green(" directive") : ""} ${clip(n.body ?? "", 60)} ${pc.dim(n.id)}`,
        )
      : ["Nothing new."],
    breadcrumbs: [
      { action: "show", cmd: "thicket show <recording_id>", description: "Open what a row points at" },
      { action: "read", cmd: "thicket notifications read <id>", description: "Mark one read (--all for every row)" },
      ...(page.next_cursor?.since
        ? [{ action: "next", cmd: `thicket notifications --since ${page.next_cursor.since}${page.next_cursor.after ? ` --after ${page.next_cursor.after}` : ""}` }]
        : []),
    ],
  };
}

async function watch(ctx: CliContext, options: Record<string, unknown>): Promise<CommandResult> {
  const since = isoOrThrow(options.since, "--since") ?? null;
  const after = options.after ? String(options.after) : null;
  const { signal, dispose } = makeAbort();
  const log = diag("notifications");
  // Fail fast on auth and org before the long loop begins.
  await ctx.whoami();
  try {
    for await (const event of inboxEvents({
      ctx,
      cursor: { since, after },
      actions: actions(options),
      pollSeconds: options.poll ? Number(options.poll) : 10,
      signal,
      log,
      pollOnly: options.pollOnly === true,
    })) {
      if (event.type === "row") ndjson(event.row);
      else if (event.type === "ready") log(`${event.source}: connected, cursor since=${event.cursor.since ?? "now"}`);
      else log(`server asked to reconnect (${event.reason}); resuming from ${event.cursor.since}`);
    }
  } finally {
    dispose();
  }
  return { data: null, silent: true };
}

async function read(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  if (options.all) {
    await org.request("PUT", "/my/notifications", { body: { read: true } });
    return { data: { all: true, read: true }, summary: "Marked every notification read", human: [pc.green("All read.")] };
  }
  const id = args[0];
  if (!id) throw new CliError("usage", "Which notification?", "Pass its id, or --all");
  const ids = id.split(",").map((s) => s.trim()).filter(Boolean);
  for (const one of ids) {
    await org.request("PATCH", `/my/notifications/${one}`, { body: { read: options.unread ? false : true } });
  }
  return {
    data: { ids, read: !options.unread },
    summary: `Marked ${ids.length} notification${ids.length === 1 ? "" : "s"} ${options.unread ? "unread" : "read"}`,
    human: [pc.green(options.unread ? "Marked unread." : "Marked read.")],
    ids,
  };
}

const listFlags = [
  { flag: "--since <iso>", description: "Cursor: rows created after this instant (oldest first)" },
  { flag: "--after <id>", description: "Cursor tie-breaker: the last row id read (pair with --since)" },
  { flag: "--action <a,b>", description: "Only these actions, e.g. mentioned,assigned" },
  { flag: "--unread", description: "Unread rows only" },
  { flag: "-n, --limit <n>", description: "Page size, max 200 (default 50)" },
  { flag: "--presence", description: "Renew the caller's agent presence lease (agents only)" },
  { flag: "--watch", description: "Follow the live stream: one NDJSON row per line, until Ctrl-C" },
  { flag: "--poll <seconds>", description: "Poll interval when the stream is unavailable (default 10)" },
  { flag: "--poll-only", description: "Never open the stream; poll with presence instead" },
];

const listSpec: Omit<CommandSpec, "path" | "summary"> = {
  category: CATEGORY,
  flags: listFlags,
  notes: [
    "Agent inbox: pass --since/--after from the previous response's next_cursor to walk forward without gaps",
    "Rows carry actor_membership_id, actor_role, actor_kind, and for agents the server's from_operator and directive verdicts",
    "--watch prints raw notification rows; thicket agent watch is the corroborated, trust-gated connector",
  ],
  handler: list,
};

export const notificationCommands: CommandSpec[] = [
  { path: ["notifications"], summary: "Your notification tray (bare shorthand for notifications list)", aliases: ["inbox"], ...listSpec },
  { path: ["notifications", "list"], summary: "Your notifications, with cursor reads for agents", ...listSpec },
  {
    path: ["notifications", "read"],
    category: CATEGORY,
    summary: "Mark notifications read (or unread)",
    args: [{ name: "id", description: "Notification id(s), comma-separated" }],
    flags: [
      { flag: "--all", description: "Mark every notification read" },
      { flag: "--unread", description: "Mark unread instead" },
    ],
    handler: read,
  },
];
