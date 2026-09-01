// The local connector, with no inbound endpoint:
// reads the agent's own inbox, corroborates every row against the API,
// applies the trust mode, acks directives with a cheer, and prints ONE
// trusted event per line of NDJSON. Diagnostics go to stderr. Thicket never
// calls in: the agent connects out, so there is nothing to expose or tear down.
import { ThicketError } from "thicket-sdk";
import type { CliContext } from "./context.js";
import { inboxEvents, sleep, toWatchError, type Cursor, type NotificationRow } from "./inbox.js";
import { mentionIdsIn } from "./markdown.js";
import { CliError } from "./output.js";
import { stripHtml } from "./rows.js";
import { recordingUrl } from "./urls.js";

export type TrustMode = "operator" | "allowlist" | "members";

export type EventKind =
  | "mentioned"
  | "assigned"
  | "commented"
  | "cheered"
  | "card_added"
  | "todo_added"
  | "chatted";

const KIND_BY_ACTION: Record<string, EventKind> = {
  mentioned: "mentioned",
  assigned: "assigned",
  commented: "commented",
  cheered: "cheered",
  card_added: "card_added",
  todo_added: "todo_added",
  chatted: "chatted",
};

/** Kinds that address the agent: they are acked and worked. */
export const DIRECTIVE_KINDS = new Set<EventKind>(["mentioned", "assigned"]);

export type RecordingDetail = {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  project_id: string | null;
  parent_id: string | null;
  creator_id: string | null;
  creator_name?: string | null;
  created_at: string;
  assignee_ids?: string[];
  mentioned_membership_ids?: string[];
  status?: string;
};

export type MyCheerRow = {
  id: string;
  content: string;
  created_at: string;
  cheerer_name: string | null;
  cheerer_membership_id: string;
  recording_id: string;
  recording_type: string;
  recording_title: string | null;
  recording_parent_id: string | null;
  project_id: string | null;
  project_name: string | null;
};

export type ConnectorEvent = {
  event_id: string;
  kind: EventKind;
  created_at: string;
  actor: { membership_id: string; name: string | null; role: string | null; kind: string | null };
  recording: {
    id: string;
    type: string;
    title: string | null;
    project_id: string | null;
    parent_id: string | null;
    web_url: string;
    text: string;
  };
  /** The comment or chat line that carried the trigger, when one did. */
  comment: { id: string; created_at: string; text: string; web_url: string } | null;
  /** The cheer, for kind "cheered". */
  cheer: { id: string; content: string } | null;
  /** What the agent should act on: the comment's text when there is one, else the recording's. */
  instruction: string;
  trigger: {
    directive: boolean;
    from_operator: boolean;
    mentioned: boolean;
    assigned: boolean;
    subscribed: boolean;
  };
  /** The connector's own ack cheer on directives; null when none was attempted. */
  ack: { ok: boolean; cheer_id: string | null; error: string | null } | null;
  cursor: Cursor;
};

export type WatchOptions = {
  ctx: CliContext;
  baseUrl: string;
  org: string;
  agent: { membership_id: string; name: string };
  /** Project ids to watch; empty = all. */
  projects: { id: string; name: string }[];
  trust: { mode: TrustMode; allow: string[] };
  cursor: Cursor;
  pollSeconds: number;
  cheers: boolean;
  cheerPollSeconds: number;
  /** The ack cheer content for directives, or false to skip acks. */
  ack: string | false;
  pollOnly?: boolean;
  signal: AbortSignal;
  log: (line: string) => void;
  emit: (event: ConnectorEvent) => void;
  now?: () => number;
};

type Verdict = { allowed: boolean; reason: string };

/** The trust decision for one row (pure, so it is testable on its own). */
export function trustVerdict(
  row: NotificationRow,
  kind: EventKind,
  trust: WatchOptions["trust"],
  agentId: string,
): Verdict {
  const actor = row.actor_membership_id;
  if (!actor) return { allowed: false, reason: "actor-less row" };
  if (actor === agentId) return { allowed: false, reason: "the agent's own activity" };
  if (row.actor_role === "client") return { allowed: false, reason: "client author (excluded fail-closed)" };
  if (trust.mode === "members") return { allowed: true, reason: "members mode" };
  const listed = trust.mode === "allowlist" && trust.allow.includes(actor);
  if (DIRECTIVE_KINDS.has(kind)) {
    if (row.directive === true) return { allowed: true, reason: "server directive verdict" };
    if (listed) return { allowed: true, reason: "actor on the allow list" };
    return { allowed: false, reason: `not a directive under ${trust.mode} trust` };
  }
  if (row.from_operator === true) return { allowed: true, reason: "actor is an operator" };
  if (listed) return { allowed: true, reason: "actor on the allow list" };
  return { allowed: false, reason: `actor may not direct the agent under ${trust.mode} trust` };
}

export class Deduper {
  private seen = new Set<string>();
  private order: string[] = [];
  constructor(private cap = 5000) {}
  has(id: string): boolean {
    return this.seen.has(id);
  }
  /** True the first time an id is seen. */
  first(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.cap) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }
}

type Corroboration = {
  ok: boolean;
  reason?: string;
  recording?: RecordingDetail;
  comment?: RecordingDetail | null;
  cheer?: MyCheerRow | null;
  mentioned: boolean;
  assigned: boolean;
  subscribed: boolean;
};

/** Re-fetches the facts a row claims; the API copy is what gets acted on. */
export async function corroborate(
  ctx: CliContext,
  row: NotificationRow,
  kind: EventKind,
  agentId: string,
  signal: AbortSignal,
): Promise<Corroboration> {
  const org = await ctx.org();
  const none: Corroboration = { ok: false, mentioned: false, assigned: false, subscribed: false };
  if (!row.recording_id) return { ...none, reason: "no recording on the row" };
  let recording: RecordingDetail;
  try {
    recording = await org.request<RecordingDetail>("GET", `/recordings/${row.recording_id}`, { signal });
  } catch (err) {
    if (err instanceof ThicketError && (err.code === "not_found" || err.code === "forbidden")) {
      return { ...none, reason: `recording ${row.recording_id} is not readable (${err.code})` };
    }
    throw err;
  }
  if (recording.status && recording.status !== "active" && recording.status !== "drafted") {
    return { ...none, reason: `recording is ${recording.status}` };
  }
  const actor = row.actor_membership_id;
  const mentionsAgent = (html: string | null | undefined) => mentionIdsIn(html).includes(agentId);
  const mentioned = (recording.mentioned_membership_ids ?? mentionIdsIn(recording.content)).includes(agentId);
  const assigned = (recording.assignee_ids ?? []).includes(agentId);

  async function latestByActor(): Promise<RecordingDetail | null> {
    const rows =
      recording.type === "chat"
        ? await org.request<RecordingDetail[]>("GET", `/recordings/${recording.id}/children`, {
            query: { type: "chat_message", limit: 50 },
            signal,
          })
        : await org.request<RecordingDetail[]>("GET", `/recordings/${recording.id}/comments`, { signal });
    const cutoff = Date.parse(row.created_at) + 60_000;
    const mine = rows
      .filter((c) => c.creator_id === actor && Date.parse(c.created_at) <= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return mine[0] ?? null;
  }

  async function subscribedTo(id: string | null): Promise<boolean> {
    if (!id) return false;
    try {
      const sub = await org.request<{ subscribed: boolean }>("GET", `/recordings/${id}/subscription`, { signal });
      return sub.subscribed === true;
    } catch {
      return false;
    }
  }

  switch (kind) {
    case "mentioned": {
      if (mentioned && recording.creator_id === actor) {
        return { ok: true, recording, comment: null, mentioned: true, assigned, subscribed: false };
      }
      // The mention lives in a comment (or chat line) on this recording.
      const rows =
        recording.type === "chat"
          ? await org.request<RecordingDetail[]>("GET", `/recordings/${recording.id}/children`, {
              query: { type: "chat_message", limit: 50 },
              signal,
            })
          : await org.request<RecordingDetail[]>("GET", `/recordings/${recording.id}/comments`, { signal });
      const cutoff = Date.parse(row.created_at) + 60_000;
      const hit = rows
        .filter((c) => c.creator_id === actor && mentionsAgent(c.content) && Date.parse(c.created_at) <= cutoff)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!hit) return { ...none, reason: "no content by the actor mentions the agent" };
      return { ok: true, recording, comment: hit, mentioned: true, assigned, subscribed: false };
    }
    case "assigned":
      if (!assigned) return { ...none, reason: "the agent is not among the assignees" };
      return { ok: true, recording, comment: null, mentioned, assigned: true, subscribed: false };
    case "commented": {
      const subscribed = await subscribedTo(recording.id);
      if (!subscribed) return { ...none, reason: "the agent does not subscribe to this thread" };
      const comment = await latestByActor();
      if (!comment) return { ...none, reason: "no comment by the actor on the thread" };
      return { ok: true, recording, comment, mentioned: false, assigned, subscribed: true };
    }
    case "cheered": {
      const since = new Date(Date.parse(row.created_at) - 4 * 3600_000).toISOString();
      const mine = await org.request<{ received: MyCheerRow[] }>("GET", "/my/cheers", { query: { since }, signal });
      const cheer = (mine.received ?? [])
        .filter((c) => c.recording_id === recording.id && c.cheerer_membership_id === actor)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!cheer) return { ...none, reason: "no matching cheer in the received feed" };
      return { ok: true, recording, comment: null, cheer, mentioned: false, assigned, subscribed: false };
    }
    case "card_added":
    case "todo_added": {
      if (recording.creator_id !== actor) return { ...none, reason: "the recording was not created by the actor" };
      const subscribed = await subscribedTo(recording.parent_id);
      return { ok: true, recording, comment: null, mentioned, assigned, subscribed };
    }
    case "chatted": {
      const line = await latestByActor();
      return { ok: true, recording, comment: line, mentioned: false, assigned: false, subscribed: await subscribedTo(recording.id) };
    }
  }
}

export type AckResult = NonNullable<ConnectorEvent["ack"]>;

export async function ackWithCheer(
  ctx: CliContext,
  recordingId: string,
  content: string,
  signal: AbortSignal,
): Promise<AckResult> {
  const org = await ctx.org();
  try {
    const cheer = await org.request<{ id: string }>("POST", `/recordings/${recordingId}/cheers`, {
      body: { content: content.slice(0, 16) },
      signal,
    });
    return { ok: true, cheer_id: cheer.id, error: null };
  } catch (err) {
    return { ok: false, cheer_id: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The connector loop. Resolves when the signal aborts. */
export async function runWatch(opts: WatchOptions): Promise<void> {
  const { ctx, signal, log, emit } = opts;
  const now = opts.now ?? Date.now;
  const seen = new Deduper();
  const projectIds = new Set(opts.projects.map((p) => p.id));
  let cursor: Cursor = { ...opts.cursor };
  // Declared before the cheers loop starts: it reads this on its first poll.
  let operatorIds: Set<string> | null = null;

  const cheersLoop = opts.cheers ? pollCheers() : Promise.resolve();
  try {
    for await (const event of inboxEvents({
      ctx,
      cursor,
      pollSeconds: opts.pollSeconds,
      signal,
      log,
      pollOnly: opts.pollOnly,
      now,
    })) {
      if (event.type === "ready") {
        cursor = event.cursor;
        log(`inbox: ${event.source} connected; cursor since=${cursor.since ?? "now"}`);
        continue;
      }
      if (event.type === "reconnect") {
        cursor = event.cursor;
        log(`inbox: server asked to reconnect (${event.reason})`);
        continue;
      }
      cursor = event.cursor;
      await handleRow(event.row, event.cursor);
    }
  } finally {
    await cheersLoop.catch(() => {});
  }

  async function handleRow(row: NotificationRow, at: Cursor): Promise<void> {
    if (!seen.first(row.id)) return;
    const kind = KIND_BY_ACTION[row.action];
    if (!kind) {
      log(`skip ${row.id}: action ${row.action} is not a trigger`);
      return;
    }
    if (projectIds.size && (!row.project_id || !projectIds.has(row.project_id))) {
      log(`skip ${row.id}: ${kind} outside the watched projects`);
      return;
    }
    const verdict = trustVerdict(row, kind, opts.trust, opts.agent.membership_id);
    if (!verdict.allowed) {
      log(`drop ${row.id}: ${kind} by ${row.actor_name ?? row.actor_membership_id ?? "nobody"}: ${verdict.reason}`);
      return;
    }
    let fact: Corroboration;
    try {
      fact = await withRetry(() => corroborate(ctx, row, kind, opts.agent.membership_id, signal));
    } catch (err) {
      if (signal.aborted) return;
      log(`drop ${row.id}: could not corroborate (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    if (!fact.ok || !fact.recording) {
      log(`drop ${row.id}: ${kind} uncorroborated: ${fact.reason ?? "unknown"}`);
      return;
    }
    await emitEvent(row, kind, fact, at);
  }

  async function emitEvent(row: NotificationRow, kind: EventKind, fact: Corroboration, at: Cursor): Promise<void> {
    const rec = fact.recording!;
    const directive = DIRECTIVE_KINDS.has(kind);
    const recordingUrlOf = (r: RecordingDetail) =>
      recordingUrl(opts.baseUrl, opts.org, { id: r.id, type: r.type, project_id: r.project_id, parent_id: r.parent_id });
    const comment = fact.comment
      ? {
          id: fact.comment.id,
          created_at: fact.comment.created_at,
          text: stripHtml(fact.comment.content ?? ""),
          web_url:
            fact.comment.type === "chat_message"
              ? recordingUrlOf(rec)
              : `${recordingUrlOf(rec)}#comment-${fact.comment.id}`,
        }
      : null;
    let ack: ConnectorEvent["ack"] = null;
    if (directive && opts.ack !== false) {
      ack = await ackWithCheer(ctx, fact.comment ? fact.comment.id : rec.id, opts.ack, signal);
      if (!ack.ok) log(`ack ${row.id}: cheer failed: ${ack.error}`);
    }
    const recordingText = stripHtml(rec.content ?? "");
    emit({
      event_id: row.id,
      kind,
      created_at: row.created_at,
      actor: {
        membership_id: row.actor_membership_id!,
        name: row.actor_name,
        role: row.actor_role,
        kind: row.actor_kind,
      },
      recording: {
        id: rec.id,
        type: rec.type,
        title: rec.title,
        project_id: rec.project_id,
        parent_id: rec.parent_id,
        web_url: recordingUrlOf(rec),
        text: recordingText,
      },
      comment,
      cheer: fact.cheer ? { id: fact.cheer.id, content: fact.cheer.content } : null,
      instruction: comment?.text || (kind === "cheered" ? fact.cheer?.content ?? "" : recordingText || rec.title || ""),
      trigger: {
        directive,
        from_operator: row.from_operator === true,
        mentioned: fact.mentioned,
        assigned: fact.assigned,
        subscribed: fact.subscribed,
      },
      ack,
      cursor: at,
    });
  }

  async function pollCheers(): Promise<void> {
    const org = await ctx.org();
    // The first fetch is a baseline: history is never dispatched.
    let since = new Date(now()).toISOString();
    let failures = 0;
    while (!signal.aborted) {
      await sleep(opts.cheerPollSeconds * 1000, signal);
      if (signal.aborted) return;
      try {
        const feed = await org.request<{ received: MyCheerRow[] }>("GET", "/my/cheers", { query: { since }, signal });
        failures = 0;
        const received = [...(feed.received ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
        for (const cheer of received) {
          if (cheer.created_at > since) since = cheer.created_at;
          if (seen.has(`cheer:${cheer.id}`)) continue;
          // Present the cheer as a notification-shaped row so trust and
          // corroboration run the same code path as an inbox "cheered".
          const row: NotificationRow = {
            id: `cheer:${cheer.id}`,
            action: "cheered",
            title: cheer.cheerer_name ?? "",
            body: cheer.content,
            recording_id: cheer.recording_id,
            recording_type: cheer.recording_type,
            recording_parent_id: cheer.recording_parent_id,
            project_id: cheer.project_id,
            actor_name: cheer.cheerer_name,
            actor_membership_id: cheer.cheerer_membership_id,
            actor_role: null,
            actor_kind: null,
            from_operator: null,
            directive: null,
            read_at: null,
            created_at: cheer.created_at,
          };
          await enrichActor(row);
          await handleRow(row, cursor);
        }
      } catch (err) {
        if (signal.aborted) return;
        const cliErr = toWatchError(err);
        if (!cliErr.retryable) {
          log(`cheers: ${cliErr.message}; cheer polling stopped`);
          return;
        }
        failures += 1;
        const wait = cliErr.retryAfter ? cliErr.retryAfter * 1000 : Math.min(300_000, 5000 * 2 ** failures);
        log(`cheers: ${cliErr.message}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait, signal);
      }
    }
  }

  /** The cheers feed carries no role or operator verdict: fill them from /people and /agents. */
  async function enrichActor(row: NotificationRow): Promise<void> {
    const people = await ctx.people();
    const person = people.find((p) => p.membership_id === row.actor_membership_id);
    row.actor_role = person?.role ?? null;
    row.actor_kind = person?.kind ?? null;
    row.from_operator = await isOperator(row.actor_membership_id);
  }

  async function isOperator(membershipId: string | null): Promise<boolean> {
    if (!membershipId) return false;
    if (!operatorIds) {
      const org = await ctx.org();
      try {
        const agent = await org.request<{ operators: { membership_id: string }[] }>(
          "GET",
          `/agents/${opts.agent.membership_id}`,
          { signal },
        );
        operatorIds = new Set(agent.operators.map((o) => o.membership_id));
      } catch {
        operatorIds = new Set();
      }
    }
    return operatorIds.has(membershipId);
  }

  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        const cliErr = toWatchError(err);
        if (!cliErr.retryable || signal.aborted) throw err;
        await sleep(cliErr.retryAfter ? cliErr.retryAfter * 1000 : 1000 * 2 ** attempt, signal);
      }
    }
    throw last instanceof Error ? last : new CliError("network", String(last));
  }
}
