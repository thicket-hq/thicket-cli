import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { openBrowser } from "../lib/browser.js";
import { updateProfile } from "../lib/config.js";
import { userAgent, type CliContext, type AuthorizationDoc } from "../lib/context.js";
import { getStoredToken, storeToken } from "../lib/keyring.js";
import { oauthBaseUrl, parseConnectionCredential, requestAgentTokens, withCredentialLock } from "../lib/oauth.js";
import { CliError, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { makeAbort, diag } from "../lib/watch-io.js";

function profile(ctx: CliContext) {
  if (ctx.env.THICKET_TOKEN?.trim()) throw new CliError("usage", "Unset THICKET_TOKEN before connecting a named agent");
  if (ctx.settings.profile === "default" || !/^[a-zA-Z0-9_-]{1,80}$/.test(ctx.settings.profile))
    throw new CliError("usage", "Use a separate named profile for the agent", "Pass --profile <agent-name>");
}

async function ownAgent(ctx: CliContext) {
  profile(ctx);
  const stored = await getStoredToken(ctx.settings.profile, ctx.env);
  if (!stored || parseConnectionCredential(stored.token)?.kind !== "agent")
    throw new CliError("auth", "This profile is not connected as a named agent", "Run: thicket auth agent connect --profile <agent-name>");
  const me = await ctx.whoami();
  if (me.membership_kind !== "agent") throw new CliError("auth", "This connection is not an agent identity");
  return me;
}

export async function pairAgent(ctx: CliContext, options: Record<string, unknown>): Promise<CommandResult> {
  profile(ctx);
  const { profile: name } = ctx.settings;
  if (await getStoredToken(name, ctx.env)) throw new CliError("auth", "This profile already has a connection", "Use another profile, or disconnect it with: thicket auth logout --profile <name>");
  const origin = oauthBaseUrl(ctx.settings.baseUrl);
  async function exchange(body: Record<string, string>) {
    const response = await ctx.fetch(`${origin}/api/oauth/agent-connections`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": userAgent() },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!data || (!response.ok && data.error !== "authorization_pending"))
      throw new CliError("auth", `Agent approval failed (HTTP ${response.status})`, "Start a new connection and approve it in your browser");
    return data;
  }
  const start = await exchange({ device_name: String(options.deviceName ?? hostname()).slice(0, 80) });
  if (typeof start.device_code !== "string" || typeof start.user_code !== "string" ||
      typeof start.verification_uri_complete !== "string" || typeof start.expires_in !== "number")
    throw new CliError("auth", "Invalid connection approval response");
  const url = new URL(start.verification_uri_complete);
  if (url.origin !== origin || url.pathname !== "/oauth/agent" || url.username || url.password)
    throw new CliError("auth", "Thicket returned an unexpected approval URL");
  process.stderr.write(`Approve this connection in your browser. Check the code: ${start.user_code}\n${url.href}\n`);
  if (options.browser !== false) await openBrowser(url.href);
  const abort = makeAbort();
  const expires = Date.now() + Math.min(start.expires_in, 600) * 1000;
  try {
    while (!abort.signal.aborted && Date.now() < expires) {
      const result = await exchange({ device_code: start.device_code });
      if (result.error === "authorization_pending") { await delay(5000, undefined, { signal: abort.signal }); continue; }
      if (typeof result.client_id !== "string" || !result.client_id.startsWith("thicket_agent_") || typeof result.client_secret !== "string")
        throw new CliError("auth", "Agent connection was not approved");
      const connection = await requestAgentTokens(origin, result.client_id, result.client_secret, userAgent(), ctx.fetch.bind(ctx));
      const probe = await ctx.fetch(`${origin}/api/v1/authorization`, { headers: { authorization: `Bearer ${connection.token}`, "user-agent": userAgent() }, signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!probe.ok) throw new CliError("auth", "Could not verify the approved agent");
      const doc = await probe.json() as AuthorizationDoc;
      if (doc.organizations.length !== 1 || doc.organizations[0].membership_kind !== "agent")
        throw new CliError("auth", "The approved connection is not a single-organization agent");
      await withCredentialLock(ctx.env, async () => {
        if (await getStoredToken(name, ctx.env)) throw new CliError("auth", "This profile was connected by another process. Use another profile.");
        await storeToken(name, JSON.stringify(connection), ctx.env);
        updateProfile(name, { base_url: origin, org: doc.organizations[0].slug }, ctx.env);
      });
      return { data: { profile: name, authentication: "agent", organization: doc.organizations[0] },
        summary: `Agent connected. Keep Claude Code running with /thicket-connect to respond to work.` };
    }
    throw new CliError("auth", "Agent approval expired or was cancelled");
  } catch (error) {
    if (abort.signal.aborted) throw new CliError("auth", "Agent approval cancelled");
    throw error;
  } finally { abort.dispose(); }
}

type Inbox = { items: { id: string; status: string; [key: string]: unknown }[] };
/** One in-flight job at a time avoids competing edits to the same workspace. */
export async function listenAgent(ctx: CliContext, signal: AbortSignal,
  emit: (line: Record<string, unknown>) => Promise<void>,
  pause: (signal: AbortSignal) => Promise<void> = signal => delay(3000, undefined, { signal })) {
  const me = await ownAgent(ctx);
  const org = await ctx.org();
  const runtimeId = randomUUID();
  const body = { runtime_id: runtimeId };
  await org.request("POST", "/my/agent/session", { body });
  try {
    await emit({ type: "connected", runtime_id: runtimeId, profile: ctx.settings.profile, organization: me.slug, membership_id: me.membership_id });
    let renewedAt = Date.now();
    while (!signal.aborted) {
      if (Date.now() - renewedAt >= 10_000) {
        await org.request("POST", "/my/agent/session", { body }); renewedAt = Date.now();
      }
      const running = await org.request<Inbox>("GET", "/my/agent/inbox?status=running");
      if (!running.items.length) {
        const pending = await org.request<Inbox>("GET", "/my/agent/inbox");
        const next = pending.items[0];
        if (next) {
          const request = await org.request<Record<string, unknown>>("POST", `/my/agent/inbox/${next.id}`, { body: { ...body, status: "claim" } });
          await emit({ type: "request", ...request, profile: ctx.settings.profile, organization: me.slug });
        }
      }
      await pause(signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { await org.request("POST", "/my/agent/session", { body: { ...body, stop: true } }).catch(() => { diag("connect")("Could not release the session; its lease will expire automatically."); }); }
}

const category = "Agent connections";
export const connectCommands: CommandSpec[] = [
  { path: ["auth", "agent", "connect"], category, summary: "Connect a named agent through browser approval",
    flags: [{ flag: "--no-browser", description: "Print the approval link without opening it" }, { flag: "--device-name <name>", description: "Name this connection in Thicket" }],
    notes: ["Use a separate --profile. Credentials belong to the agent, not its operator. Manage operators and projects in People, Agents."],
    handler: (ctx, _args, options) => pairAgent(ctx, options) },
  { path: ["connect"], category, summary: "Listen for agent requests in a running Claude Code session",
    notes: ["Prints NDJSON. The Claude Code thicket-connect skill must monitor this process and handle each request. One active listener per agent; unfinished work needs review before retry."],
    handler: async ctx => {
      const abort = makeAbort();
      try { await listenAgent(ctx, abort.signal, async line => { if (!process.stdout.write(JSON.stringify(line) + "\n")) await once(process.stdout, "drain"); }); }
      finally { abort.dispose(); }
      return { data: {}, silent: true };
    } },
  { path: ["connect", "status"], category, summary: "Show the agent identity and outstanding requests",
    handler: async ctx => {
      const agent = await ownAgent(ctx); const org = await ctx.org();
      const inbox: Record<string, Inbox["items"]> = {};
      for (const status of ["pending", "running", "failed", "interrupted"]) inbox[status] = (await org.request<Inbox>("GET", `/my/agent/inbox?status=${status}`)).items;
      return { data: { agent, inbox }, summary: `${inbox.pending.length} pending; ${inbox.running.length} running; ${inbox.failed.length + inbox.interrupted.length} need review.` };
    } },
  { path: ["connect", "settle"], category, summary: "Record completion or failure after handling an agent request",
    args: [{ name: "request-id", required: true, description: "Request id emitted by the listener" }],
    flags: [{ flag: "--runtime <id>", description: "Runtime id from the request" }, { flag: "--status <status>", description: "completed or failed" }, { flag: "--result <text>", description: "Brief outcome or link to the reply" }],
    handler: async (ctx, [id], options) => {
      await ownAgent(ctx);
      if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(String(options.runtime)) || !["completed", "failed"].includes(String(options.status)) || !options.result)
        throw new CliError("usage", "Provide a request id, --runtime, --status completed|failed, and --result");
      const org = await ctx.org();
      const data = await org.request("POST", `/my/agent/inbox/${id}`, { body: { runtime_id: options.runtime, status: options.status, result: options.result } });
      return { data, summary: `Request ${options.status}.` };
    } },
];
