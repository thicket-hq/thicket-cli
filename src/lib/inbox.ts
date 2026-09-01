// The agent inbox as an async iterator: rides the Server-Sent Events stream
// (GET /my/notifications/stream) when the server offers it, and polls
// GET /my/notifications with the same cursor when it does not. Either way
// the caller sees one notification row at a time plus the cursor to resume
// from, and the agent's presence lease is renewed as a side effect.
import { ThicketError } from "thicket-sdk";
import type { CliContext } from "./context.js";
import { CliError } from "./output.js";
import { bodyChunks, parseSse } from "./sse.js";

export type NotificationRow = {
  id: string;
  action: string;
  title: string;
  body: string | null;
  bundle_count?: number;
  recording_id: string | null;
  recording_type: string | null;
  recording_parent_id: string | null;
  project_id: string | null;
  bulletin_id?: string | null;
  actor_name: string | null;
  actor_membership_id: string | null;
  actor_role: string | null;
  actor_kind: string | null;
  from_operator: boolean | null;
  directive: boolean | null;
  read_at: string | null;
  created_at: string;
};

export type Cursor = { since: string | null; after: string | null };

export type InboxEvent =
  | { type: "row"; row: NotificationRow; cursor: Cursor; source: "sse" | "poll" }
  | { type: "ready"; cursor: Cursor; source: "sse" | "poll" }
  | { type: "reconnect"; cursor: Cursor; reason: string };

export type InboxOptions = {
  ctx: CliContext;
  cursor: Cursor;
  actions?: string[];
  /** Poll interval when the stream is unavailable. */
  pollSeconds: number;
  signal: AbortSignal;
  log: (line: string) => void;
  /** Skip the stream entirely (tests, or a server known not to have it). */
  pollOnly?: boolean;
  /** Stream lifetime cap on the client side; the server closes at ten minutes anyway. */
  now?: () => number;
};

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return retryAfter * 1000;
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 250;
}

const STREAM_RETRY_EVERY_MS = 5 * 60_000;
const STREAM_FAILURES_BEFORE_POLLING = 5;

/**
 * Yields inbox events forever (until the signal aborts). Without a cursor
 * the inbox starts now: history is never replayed as new.
 */
export async function* inboxEvents(opts: InboxOptions): AsyncGenerator<InboxEvent, void, void> {
  const { ctx, signal, log } = opts;
  const now = opts.now ?? Date.now;
  let cursor: Cursor = { ...opts.cursor };
  if (!cursor.since) cursor = { since: new Date(now()).toISOString(), after: null };
  let streamUnavailable = opts.pollOnly === true;
  let streamFailures = 0;
  let nextStreamAttempt = 0;
  let pollFailures = 0;

  while (!signal.aborted) {
    if (!streamUnavailable && now() >= nextStreamAttempt) {
      const outcome = yield* consumeStream();
      if (signal.aborted) return;
      if (outcome === "unavailable") {
        streamUnavailable = true;
        log("stream: not offered by this server; polling instead");
      } else if (outcome === "failed") {
        streamFailures += 1;
        if (streamFailures >= STREAM_FAILURES_BEFORE_POLLING) {
          nextStreamAttempt = now() + STREAM_RETRY_EVERY_MS;
          streamFailures = 0;
          log(`stream: ${STREAM_FAILURES_BEFORE_POLLING} failures in a row; polling for the next ${STREAM_RETRY_EVERY_MS / 60_000} minutes`);
        } else {
          await sleep(backoffMs(streamFailures), signal);
        }
      } else {
        // "reconnect": the server closed a healthy stream; come straight back.
        streamFailures = 0;
      }
      continue;
    }
    // Polling.
    try {
      const events = await pollOnce();
      pollFailures = 0;
      for (const event of events) yield event;
    } catch (err) {
      if (signal.aborted) return;
      const cliErr = toWatchError(err);
      if (!cliErr.retryable) throw cliErr;
      pollFailures += 1;
      const wait = backoffMs(pollFailures, cliErr.retryAfter);
      log(`poll: ${cliErr.message}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, signal);
      continue;
    }
    await sleep(opts.pollSeconds * 1000, signal);
  }

  async function* consumeStream(): AsyncGenerator<InboxEvent, "unavailable" | "failed" | "reconnect", void> {
    const slug = await ctx.orgSlug();
    const params = new URLSearchParams();
    if (cursor.since) params.set("since", cursor.since);
    if (cursor.after) params.set("after", cursor.after);
    if (opts.actions?.length) params.set("action", opts.actions.join(","));
    let response: Response;
    try {
      response = await ctx.rawFetch(`/api/v1/${slug}/my/notifications/stream?${params}`, {
        headers: { accept: "text/event-stream" },
        signal,
      });
    } catch (err) {
      if (signal.aborted) return "failed";
      log(`stream: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
    if (response.status === 401 || response.status === 403) {
      throw new CliError(
        response.status === 401 ? "auth" : "forbidden",
        `The stream refused the token (HTTP ${response.status})`,
        response.status === 401 ? "Run: thicket auth login" : undefined,
      );
    }
    if (response.status === 404 || response.status === 405 || response.status === 406) {
      await response.body?.cancel().catch(() => {});
      return "unavailable";
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 30_000;
      log(`stream: rate limited; waiting ${Math.round(wait / 1000)}s`);
      await response.body?.cancel().catch(() => {});
      await sleep(wait, signal);
      return "failed";
    }
    if (!response.ok || !/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 500) {
        log(`stream: HTTP ${response.status}`);
        return "failed";
      }
      return "unavailable";
    }
    let ready = false;
    try {
      for await (const message of parseSse(bodyChunks(response))) {
        if (signal.aborted) return "failed";
        if (message.event === "ready") {
          ready = true;
          const payload = safeJson(message.data) as { cursor?: Cursor } | null;
          if (payload?.cursor?.since) cursor = { since: payload.cursor.since, after: payload.cursor.after ?? null };
          yield { type: "ready", cursor: { ...cursor }, source: "sse" };
        } else if (message.event === "notification") {
          const row = safeJson(message.data) as NotificationRow | null;
          if (!row?.id) continue;
          cursor = { since: row.created_at, after: row.id };
          yield { type: "row", row, cursor: { ...cursor }, source: "sse" };
        } else if (message.event === "reconnect") {
          const payload = safeJson(message.data) as { cursor?: Cursor; reason?: string } | null;
          if (payload?.cursor?.since) cursor = { since: payload.cursor.since, after: payload.cursor.after ?? cursor.after };
          yield { type: "reconnect", cursor: { ...cursor }, reason: payload?.reason ?? "server" };
          return "reconnect";
        } else if (message.event === "error") {
          const payload = safeJson(message.data) as { message?: string } | null;
          log(`stream: server error: ${payload?.message ?? message.data}`);
          return "failed";
        }
      }
    } catch (err) {
      if (signal.aborted) return "failed";
      log(`stream: dropped (${err instanceof Error ? err.message : String(err)})`);
      return "failed";
    }
    // A clean end without a reconnect event: treat as a drop, reconnect.
    return ready ? "reconnect" : "failed";
  }

  async function pollOnce(): Promise<InboxEvent[]> {
    const org = await ctx.org();
    const events: InboxEvent[] = [];
    for (let page = 0; page < 20; page++) {
      const query: Record<string, string | number | boolean> = {
        limit: 100,
        presence: true,
      };
      if (cursor.since) query.since = cursor.since;
      if (cursor.after) query.after = cursor.after;
      if (opts.actions?.length) query.action = opts.actions.join(",");
      const page_ = await org.request<{
        notifications?: NotificationRow[];
        next_cursor?: Cursor;
      }>("GET", "/my/notifications", { query, signal });
      const rows = page_.notifications ?? [];
      for (const row of rows) {
        cursor = { since: row.created_at, after: row.id };
        events.push({ type: "row", row, cursor: { ...cursor }, source: "poll" });
      }
      if (rows.length < 100) break;
    }
    return events;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toWatchError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof ThicketError) {
    const retryable = err.retryable || err.code === "network" || err.code === "rate_limit" || (err.status ?? 0) >= 500;
    const code = err.code === "auth_required" ? "auth" : err.code === "api_error" ? "api" : err.code;
    return new CliError(code as CliError["code"], err.message, undefined, { retryable, retryAfter: err.retryAfter });
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new CliError("network", "aborted", undefined, { retryable: true });
  }
  return new CliError("network", err instanceof Error ? err.message : String(err), undefined, { retryable: true });
}
