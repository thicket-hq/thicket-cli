// Subscriptions: follow a thread, watch a column, ring the chat bell.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { resolveRecordingRef } from "../lib/refs.js";
import { table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { recordingArg } from "../lib/specs.js";

const CATEGORY = "Subscriptions";

type Subscription = { subscribed: boolean; subscribers: { membership_id: string; name: string }[] };

async function show(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const ref = resolveRecordingRef(ctx, args[0]);
  const org = await ctx.org();
  const sub = await org.request<Subscription>("GET", `/recordings/${ref.id}/subscription`);
  return {
    data: { recording_id: ref.id, ...sub },
    summary: `${sub.subscribed ? "Subscribed" : "Not subscribed"}; ${sub.subscribers.length} subscriber${sub.subscribers.length === 1 ? "" : "s"}`,
    ids: sub.subscribers.map((s) => s.membership_id),
    human: [
      sub.subscribed ? pc.green("You are subscribed.") : pc.yellow("You are not subscribed."),
      ...table(["SUBSCRIBER", "MEMBERSHIP"], sub.subscribers.map((s) => [s.name, s.membership_id])),
    ],
    breadcrumbs: [
      { action: sub.subscribed ? "remove" : "add", cmd: `thicket subscriptions ${sub.subscribed ? "remove" : "add"} ${ref.id}` },
    ],
  };
}

function set(on: boolean): CommandSpec["handler"] {
  return async (ctx, args) => {
    const ref = resolveRecordingRef(ctx, args[0]);
    const org = await ctx.org();
    const result = await org.request<{ subscribed: boolean }>(on ? "PUT" : "DELETE", `/recordings/${ref.id}/subscription`);
    return {
      data: { recording_id: ref.id, subscribed: result?.subscribed ?? on },
      summary: on ? "Subscribed" : "Unsubscribed",
      human: [pc.green(on ? "Subscribed." : "Unsubscribed.")],
    };
  };
}

export const subscriptionCommands: CommandSpec[] = [
  {
    path: ["subscriptions"],
    category: CATEGORY,
    summary: "Your subscription on a recording, and who else subscribes (shorthand for subscriptions show)",
    args: [recordingArg()],
    handler: show,
  },
  {
    path: ["subscriptions", "show"],
    category: CATEGORY,
    summary: "Your subscription on a recording, and who else subscribes",
    args: [recordingArg()],
    notes: ["On a card column this is \"watch this column\"; on a chat room it is the chat bell"],
    handler: show,
  },
  {
    path: ["subscriptions", "add"],
    category: CATEGORY,
    summary: "Subscribe yourself to a recording",
    args: [recordingArg()],
    handler: set(true),
  },
  {
    path: ["subscriptions", "remove"],
    category: CATEGORY,
    summary: "Unsubscribe yourself from a recording",
    args: [recordingArg()],
    handler: set(false),
  },
];
