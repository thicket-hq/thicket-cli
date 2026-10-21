import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import pc from "picocolors";
import { ThicketError, type OrgScope } from "thicket-sdk";
import {
  AGENT_CAPS, TRUST_MODES, WakeLedger, admit, isUuid, projectOf, readConnectSettings, requesterOf, settingsPath,
  writeConnectSettings, type ConnectSettings, type InboxItem, type Named, type ProjectRef, type TrustMode,
} from "../lib/agent-trust.js";
import { openBrowser } from "../lib/browser.js";
import { updateProfile } from "../lib/config.js";
import { CliContext, userAgent, type AuthorizationDoc, type AuthorizationOrg } from "../lib/context.js";
import { getStoredToken, storeToken } from "../lib/keyring.js";
import { oauthBaseUrl, parseConnectionCredential, requestAgentTokens, withCredentialLock } from "../lib/oauth.js";
import { CliError, toCliError, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { recordingUrl } from "../lib/urls.js";
import { diag, makeAbort } from "../lib/watch-io.js";

const PROFILE_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const WHERE_AGENTS_LIVE = "Admin > Manage agents (a shared agent) or My settings > My agent (your personal agent)";

function profile(ctx: CliContext) {
  if (ctx.env.THICKET_TOKEN?.trim()) throw new CliError("usage", "Unset THICKET_TOKEN: a named agent uses its own profile's connection");
  if (ctx.settings.profile === "default" || !PROFILE_RE.test(ctx.settings.profile))
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

type PersonRow = { membership_id: string; name: string; role?: string; kind?: string; boss?: Named | null };

/** A person the agent can see (itself, or someone who shares a project with it), else null. */
async function lookupPerson(org: OrgScope, id: string): Promise<PersonRow | null> {
  try {
    return await org.request<PersonRow>("GET", `/people/${id}`);
  } catch (err) {
    if (err instanceof ThicketError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

// --- thicket auth agent connect --------------------------------------------

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
  process.stderr.write(`Approve this connection in your browser: check the code, pick or create the agent, and choose its access. Code: ${start.user_code}\n${url.href}\n`);
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
      const full = connection.scope.split(/\s+/).includes("thicket.write");
      const access = full ? "full" : "read";
      const setup = `thicket connect setup --profile ${name}`;
      return {
        data: { profile: name, authentication: "agent", scope: connection.scope, access, organization: doc.organizations[0] },
        summary: full
          ? `Agent connected with Full access. Next: ${setup}`
          : `Agent connected with Read-only access. The connector needs Full access: disconnect with thicket auth logout --profile ${name}, then connect again.`,
        human: [
          `${pc.green("Agent connected.")} ${full ? "Full" : "Read-only"} access in ${doc.organizations[0].name} (${doc.organizations[0].slug}), membership ${doc.organizations[0].membership_id}.`,
          full ? `Next, say who may give it work and which projects it serves: ${pc.cyan(setup)}` : pc.yellow("The connector needs Full access to cheer and reply."),
        ],
        breadcrumbs: [
          { action: "identity", cmd: `thicket me --profile ${name}`, description: "Confirm this is the agent" },
          { action: "setup", cmd: setup, description: "Who may give it work, and which projects it serves" },
        ],
      };
    }
    throw new CliError("auth", "Agent approval expired or was cancelled");
  } catch (error) {
    if (abort.signal.aborted) throw new CliError("auth", "Agent approval cancelled");
    throw error;
  } finally { abort.dispose(); }
}

// --- thicket connect setup ---------------------------------------------------

type Check = { check: string; status: "ok" | "warn" | "fail"; detail: string };

function idList(value: unknown, flag: string): string[] | undefined {
  if (value === undefined || value === false) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim().toLowerCase());
  for (const id of list) if (!isUuid(id)) throw new CliError("usage", `${flag} takes an id, got "${id}"`, "Membership ids come from thicket people; project ids from thicket projects");
  return [...new Set(list)];
}

function boolFlag(value: unknown, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new CliError("usage", `${flag} is on or off`, `Pass ${flag}, or ${flag}=false to turn it off`);
}

const without = (list: string[], remove: string[] | undefined) => list.filter((id) => !remove?.includes(id));
const union = (a: string[], b: string[] | undefined) => [...new Set([...a, ...(b ?? [])])];

/** A person's membership id in the agent's organization, read with that person's own profile. */
async function profileMembership(ctx: CliContext, other: string, slug: string): Promise<string> {
  const peer = new CliContext({ profile: other, org: slug, baseUrl: ctx.settings.baseUrl }, ctx.env, ctx.fetch.bind(ctx));
  let row: AuthorizationOrg;
  try {
    row = await peer.whoami();
  } catch (err) {
    throw new CliError("usage", `Could not read who profile "${other}" is in ${slug}: ${toCliError(err).message}`,
      `Sign that person in with thicket auth login --profile ${other}, or pass --operator <membership-id>`);
  }
  if (row.membership_kind === "agent") throw new CliError("usage", `Profile "${other}" is an agent; the operator is a person`, "Name the operator's own profile, or pass --operator <membership-id>");
  return row.membership_id;
}

function personCheck(check: string, id: string, person: PersonRow | null, want: "person" | "agent", self: string): Check {
  if (!person) return { check, status: "fail", detail: `${id}: this agent can't see them. They must share a project with it.` };
  if (person.membership_id === self) return { check, status: "fail", detail: `${person.name} is this agent.` };
  const kind = person.kind ?? "person";
  if (want === "person" && kind === "agent") return { check, status: "fail", detail: `${person.name} is an agent. Other agents are allowed with --allow-agent.` };
  if (want === "agent" && kind !== "agent") return { check, status: "fail", detail: `${person.name} is a person, not an agent.` };
  if (want === "person" && person.role === "client") return { check, status: "fail", detail: `${person.name} is a client, and clients can't give an agent work.` };
  return { check, status: "ok", detail: person.name };
}

function trustSentence(s: Pick<ConnectSettings, "trust" | "operator_name" | "allow">): string {
  const others = s.allow.map((p) => p.name).join(", ");
  if (s.trust === "operator") return `only ${s.operator_name}`;
  if (s.trust === "allowlist") return others ? `${s.operator_name} and ${others}` : `only ${s.operator_name} (the allowlist is empty)`;
  return `${s.operator_name}${others ? `, ${others}` : ""}, and anyone on its projects who isn't a client, as a participant`;
}

function settingsLines(s: ConnectSettings): string[] {
  const list = (rows: { name: string }[]) => rows.length ? rows.map((r) => r.name).join(", ") : "none";
  return [
    `  Agent:        ${s.agent_name}, a ${s.agent_type} agent in ${s.organization}`,
    `  Operator:     ${s.operator_name}${s.agent_type === "personal" ? " (its owner)" : ""}`,
    `  Gives work:   ${trustSentence(s)}`,
    `  Assignments:  ${s.allow_assignments_from_authorized ? `${s.operator_name} and the allowlist` : `${s.operator_name} only`}`,
    `  Other agents: ${list(s.allow_agents)}${s.allow_agents.length ? ` (by mention, at most ${s.agent_caps.per_thread} per thread and ${s.agent_caps.per_agent_per_day} per agent a day)` : ""}`,
    `  Projects:     ${list(s.serve)}`,
    `  Completions:  ${list(s.watch_completions)}`,
  ];
}

async function connectSetup(ctx: CliContext, options: Record<string, unknown>): Promise<CommandResult> {
  // Every flag rule is checked before anything is read or written.
  profile(ctx);
  const name = ctx.settings.profile;
  const trustFlag = options.trust === undefined ? undefined : String(options.trust);
  if (trustFlag !== undefined && !(TRUST_MODES as readonly string[]).includes(trustFlag))
    throw new CliError("usage", `--trust is operator, allowlist or project, not "${trustFlag}"`);
  const operatorFlag = idList(options.operator, "--operator")?.[0];
  const operatorProfile = options.operatorProfile === undefined ? undefined : String(options.operatorProfile);
  if (operatorFlag && operatorProfile) throw new CliError("usage", "Pass --operator or --operator-profile, not both");
  if (operatorProfile !== undefined && (!PROFILE_RE.test(operatorProfile) || operatorProfile === name))
    throw new CliError("usage", "--operator-profile names the operator's own profile on this computer, never the agent's");
  const allowFlag = idList(options.allow, "--allow");
  const assignFlag = boolFlag(options.allowAssignmentsFromAuthorized, "--allow-assignments-from-authorized");
  const allowAgentFlag = idList(options.allowAgent, "--allow-agent");
  const disallowAgentFlag = idList(options.disallowAgent, "--disallow-agent");
  const serveFlag = idList(options.serve, "--serve");
  const unserveFlag = idList(options.unserve, "--unserve");
  const watchFlag = options.watchCompletions === false ? [] : idList(options.watchCompletions, "--watch-completions");
  if (allowAgentFlag?.some((id) => disallowAgentFlag?.includes(id))) throw new CliError("usage", "An agent can't be both allowed and disallowed in one run");
  if (serveFlag?.some((id) => unserveFlag?.includes(id))) throw new CliError("usage", "A project can't be both served and unserved in one run");
  if (trustFlag === "operator" && allowFlag?.length)
    throw new CliError("usage", "--trust operator gives work to the operator alone, so it takes no --allow", "Use --trust allowlist, or --trust project, with --allow");

  const me = await ownAgent(ctx);
  const origin = oauthBaseUrl(ctx.settings.baseUrl);
  const checks: Check[] = [];
  let previous: ConnectSettings | null = null;
  try {
    previous = readConnectSettings(ctx.env, name);
  } catch {
    checks.push({ check: "settings", status: "warn", detail: "The earlier settings file was unreadable, so this run starts fresh." });
  }
  if (previous && !writtenFor(previous, me, origin)) {
    checks.push({ check: "settings", status: "warn", detail: "The earlier settings were for another agent, so this run starts fresh." });
    previous = null;
  }

  // Who may give it work, from the flags and whatever this run keeps.
  const trust: TrustMode = (trustFlag as TrustMode | undefined) ?? previous?.trust ?? "operator";
  if (trust === "operator" && allowFlag?.length)
    throw new CliError("usage", "This agent takes work from its operator alone, so it takes no --allow", "Pass --trust allowlist, or --trust project, with --allow");
  let allowIds = trust === "operator" ? [] : (allowFlag ?? previous?.allow.map((p) => p.membership_id) ?? []);
  const assignments = trust === "operator" ? (assignFlag ?? false)
    : assignFlag ?? (allowFlag !== undefined ? false : previous?.allow_assignments_from_authorized ?? false);
  if (assignments && !allowIds.length)
    throw new CliError("usage", "--allow-assignments-from-authorized covers the allowlist, and it is empty", "Name people with --allow <membership-id> (and --trust allowlist or project)");
  const agentIds = without(union(previous?.allow_agents.map((a) => a.membership_id) ?? [], allowAgentFlag), disallowAgentFlag);
  const serveIds = without(union(previous?.serve.map((p) => p.id) ?? [], serveFlag), unserveFlag);
  if (watchFlag?.some((id) => !serveIds.includes(id)))
    throw new CliError("usage", "--watch-completions takes projects the agent serves", "Add the project with --serve <project-id> in the same run");
  const watchIds = watchFlag ?? (previous?.watch_completions.map((p) => p.id) ?? []).filter((id) => serveIds.includes(id));

  const org = await ctx.org();
  const auth = await ctx.authorization();
  const self = await lookupPerson(org, me.membership_id);
  if (!self) throw new CliError("auth", "Thicket did not answer for this agent's own profile", "Check the agent in " + WHERE_AGENTS_LIVE);
  const boss = self.boss ?? null;
  const agentType = boss ? "personal" : "shared";
  checks.unshift({ check: "identity", status: "ok", detail: `${self.name}, a ${agentType} agent${boss ? ` of ${boss.name}` : ""} in ${me.slug}` });
  checks.push(auth.scope === "full"
    ? { check: "access", status: "ok", detail: "Full access" }
    : { check: "access", status: "fail", detail: `Read-only access: the connector needs Full access to hold its session, cheer and reply. Disconnect with thicket auth logout --profile ${name}, then connect again and choose Full.` });

  // The operator: a personal agent's is its owner; a shared one's is named.
  let operatorId: string;
  let operatorFrom: ConnectSettings["operator_from"];
  const named = operatorFlag ?? (operatorProfile ? await profileMembership(ctx, operatorProfile, me.slug) : undefined);
  if (boss) {
    if (named && named !== boss.membership_id)
      throw new CliError("usage", `A personal agent's operator is its owner, ${boss.name}`, "Pass no --operator or --operator-profile");
    operatorId = boss.membership_id;
    operatorFrom = "owner";
  } else if (named) {
    operatorId = named;
    operatorFrom = operatorProfile ? "profile" : "membership_id";
  } else if (previous && previous.agent_type === "shared") {
    operatorId = previous.operator_id;
    operatorFrom = previous.operator_from;
  } else {
    throw new CliError("usage", "A shared agent needs an operator: the person whose word runs it",
      "Pass --operator-profile <their profile> if they are signed in on this computer, or --operator <membership-id>");
  }
  // A personal agent's owner is a person on its projects by definition; a named operator is checked.
  const operator: PersonRow | null = boss
    ? { membership_id: boss.membership_id, name: boss.name, kind: "person" }
    : await lookupPerson(org, operatorId);
  const operatorCheck = personCheck("operator", operatorId, operator, "person", me.membership_id);
  if (boss) operatorCheck.detail = `${boss.name}, its owner`;
  checks.push(operatorCheck);
  allowIds = allowIds.filter((id) => id !== operatorId);

  const allow: Named[] = [];
  for (const id of allowIds) {
    const person = await lookupPerson(org, id);
    const check = personCheck("allow", id, person, "person", me.membership_id);
    if (check.status === "fail" && !allowFlag) check.detail += " Run setup with --allow for the people who stay.";
    checks.push(check);
    if (person && check.status === "ok") allow.push({ membership_id: person.membership_id, name: person.name });
  }
  if (trust === "allowlist" && !allowIds.length)
    checks.push({ check: "allow", status: "warn", detail: "The allowlist is empty, so only the operator can give it work." });

  const allowAgents: Named[] = [];
  for (const id of agentIds) {
    const agent = await lookupPerson(org, id);
    const check = personCheck("allow-agent", id, agent, "agent", me.membership_id);
    if (check.status === "fail" && !allowAgentFlag?.includes(id)) check.detail += ` Remove it with --disallow-agent ${id}.`;
    checks.push(check);
    if (agent && check.status === "ok") allowAgents.push({ membership_id: agent.membership_id, name: agent.name });
  }

  const projects = (await org.projects.list()) as { id: string; name: string }[];
  const serve: ProjectRef[] = [];
  if (!projects.length) {
    checks.push({ check: "projects", status: "fail", detail: `This agent is on no projects yet. Add it to projects in ${WHERE_AGENTS_LIVE}, then run setup again.` });
  } else {
    for (const id of serveIds) {
      const project = projects.find((p) => String(p.id).toLowerCase() === id);
      if (project) {
        serve.push({ id, name: String(project.name) });
        checks.push({ check: "serve", status: "ok", detail: String(project.name) });
      } else {
        checks.push({ check: "serve", status: "fail", detail: `Project ${id}: this agent isn't on it. Add it in ${WHERE_AGENTS_LIVE}${serveFlag?.includes(id) ? "" : `, or stop serving it with --unserve ${id}`}.` });
      }
    }
    if (!serveIds.length)
      checks.push({ check: "serve", status: "warn", detail: `It serves no projects yet, so only direct messages reach it. Its projects: ${projects.map((p) => `${p.name} (${p.id})`).join(", ")}.` });
  }

  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length) {
    throw new CliError("validation", `Setup is not ready, so nothing was written. ${failed.map((c) => c.detail).join(" ")}`,
      `Fix what is named, then run thicket connect setup --profile ${name} again`);
  }

  const settings: ConnectSettings = {
    version: 1,
    profile: name,
    base_url: origin,
    organization: me.slug,
    agent_membership_id: me.membership_id,
    agent_name: self.name,
    agent_type: agentType,
    operator_id: operatorId,
    operator_name: operator!.name,
    operator_from: operatorFrom,
    owner_id: operatorId,
    trust,
    allow,
    allow_assignments_from_authorized: assignments,
    allow_agents: allowAgents,
    agent_caps: { ...AGENT_CAPS },
    serve,
    watch_completions: serve.filter((p) => watchIds.includes(p.id)),
    saved_at: new Date().toISOString(),
  };
  const path = writeConnectSettings(ctx.env, name, settings);
  const start = `thicket connect --profile ${name}`;
  return {
    data: { ready: true, written: true, path, profile: name, agent_membership_id: me.membership_id, settings, checks },
    summary: `Wrote ${path}: ${trustSentence(settings)} may give ${settings.agent_name} work in ${serve.length} project${serve.length === 1 ? "" : "s"}. Start it with: ${start}`,
    human: [
      `${pc.green("Set up.")} Wrote ${path}`,
      ...settingsLines(settings),
      "",
      ...checks.map((c) => `${c.status === "ok" ? pc.green("ok  ") : pc.yellow("warn")} ${c.check.padEnd(11)} ${c.detail}`),
    ],
    breadcrumbs: [
      { action: "start", cmd: start, description: "Run the connector in a Claude Code session with /thicket-connect" },
      { action: "status", cmd: `thicket connect status --profile ${name}` },
    ],
  };
}

// --- thicket connect ---------------------------------------------------------

type Inbox = { items: InboxItem[] };

/**
 * Whether settings were written for this agent on this host. The membership
 * id also names the workspace; the slug they record is for showing, since a
 * rename regenerates it (docs/org-key-plan-2026-10-21.md D9).
 */
function writtenFor(settings: ConnectSettings, me: AuthorizationOrg, origin: string): boolean {
  return settings.agent_membership_id === me.membership_id && settings.base_url === origin;
}

/** The settings this run admits by, or a refusal saying how to write them. */
function requireSettings(ctx: CliContext, me: AuthorizationOrg): ConnectSettings {
  const name = ctx.settings.profile;
  const settings = readConnectSettings(ctx.env, name);
  if (!settings) throw new CliError("usage", "This agent isn't set up on this computer", `Run thicket connect setup --profile ${name} first`);
  if (!writtenFor(settings, me, oauthBaseUrl(ctx.settings.baseUrl)))
    throw new CliError("usage", "This agent's settings were written for another agent", `Run thicket connect setup --profile ${name} again`);
  return settings;
}

const SESSION_CODES = new Set(["agent_session_expired", "agent_busy", "agents_unavailable", "agent_forbidden"]);

/** A refusal about one request (claimed elsewhere, changed, gone), not about the session. */
function requestRefused(err: unknown): boolean {
  return err instanceof ThicketError && err.status !== undefined && err.status >= 400 && err.status < 500 &&
    err.status !== 401 && err.status !== 429 && !SESSION_CODES.has(err.apiCode ?? "");
}

/** Worth waiting out: the network, a rate limit, a server error. */
function transient(err: unknown): boolean {
  if (err instanceof ThicketError) return err.retryable || err.code === "network" || (err.status ?? 0) >= 500;
  return err instanceof CliError && err.retryable;
}

/** The web link for what a request is about, only where the CLI can build it exactly. */
function requestUrl(baseUrl: string, org: string, item: InboxItem): string | undefined {
  const source = item.source;
  if (!source?.id) return undefined;
  const standalone = new Set(["message", "document", "upload", "linked_file", "todolist", "progress_update", "health_update",
    "calendar_event", "card", "column", "question", "client_approval", "client_correspondence", "chat_message", "dm"]);
  const withParent = new Set(["todo", "answer", "step"]);
  const project_id = source.project_id ?? null;
  if (source.type === "comment") {
    const parent = item.subject;
    if (!parent || parent.id !== source.parent_id || !standalone.has(parent.type ?? "")) return undefined;
    return `${recordingUrl(baseUrl, org, { id: parent.id, type: parent.type, project_id })}#comment-${source.id}`;
  }
  if (standalone.has(source.type ?? "") || (withParent.has(source.type ?? "") && source.parent_id))
    return recordingUrl(baseUrl, org, { id: source.id, type: source.type, project_id, parent_id: source.parent_id ?? null });
  return undefined;
}

export function requestLine(item: InboxItem, decision: { role: string; owner: boolean; acknowledge: boolean },
  run: { runtimeId: string; profile: string; organization: string; baseUrl: string }): Record<string, unknown> {
  const requester = requesterOf(item);
  const source = item.source ?? null;
  const url = requestUrl(run.baseUrl, run.organization, item);
  return {
    type: "request",
    id: item.id,
    runtime_id: run.runtimeId,
    trigger: item.reason,
    role: decision.role,
    owner: decision.owner,
    acknowledge: decision.acknowledge,
    requester_id: requester.id,
    requester_name: requester.name,
    requester_kind: requester.kind,
    recording: {
      id: source?.id ?? null,
      type: source?.type ?? null,
      title: source?.title ?? item.subject?.title ?? null,
      project_id: projectOf(item),
      project_name: item.project?.name ?? null,
      ...(url ? { url } : {}),
    },
    reply_to: item.reply_to ?? null,
    content: source?.content ?? null,
    source,
    profile: run.profile,
    organization: run.organization,
  };
}

/**
 * Holds the agent's session and admits each new inbox request against this
 * computer's settings. Several requests may run at once; each one is printed
 * once per run. Requests from before the run were closed by the server.
 */
export async function listenAgent(ctx: CliContext, signal: AbortSignal,
  emit: (line: Record<string, unknown>) => Promise<void>,
  pause: (signal: AbortSignal) => Promise<void> = (s) => delay(3000, undefined, { signal: s }),
  now: () => number = Date.now) {
  const me = await ownAgent(ctx);
  const settings = requireSettings(ctx, me);
  if ((await ctx.authorization()).scope !== "full")
    throw new CliError("auth", "This agent's connection is Read-only, and the connector needs Full access", `Disconnect with thicket auth logout --profile ${ctx.settings.profile}, then connect again and choose Full`);
  const org = await ctx.org();
  const log = diag("connect");
  const ledger = WakeLedger.load(ctx.env, ctx.settings.profile, now());
  const runtimeId = randomUUID();
  const body = { runtime_id: runtimeId };
  const run = { runtimeId, profile: ctx.settings.profile, organization: me.slug, baseUrl: ctx.settings.baseUrl };
  const handled = new Set<string>();
  await org.request("POST", "/my/agent/session", { body });
  let renewedAt = now();
  const renew = async () => {
    if (now() - renewedAt < 10_000) return;
    await org.request("POST", "/my/agent/session", { body });
    renewedAt = now();
  };
  /** One request's verdict to the server; null when Thicket refused it for that request alone. */
  const answer = async (id: string, status: "claim" | "dismissed", result?: string): Promise<{ view: InboxItem | undefined } | null> => {
    try {
      const view = await org.request<InboxItem | undefined>("POST", `/my/agent/inbox/${id}`, { body: { ...body, status, ...(result ? { result } : {}) } });
      handled.add(id);
      return { view: view ?? undefined };
    } catch (err) {
      if (!requestRefused(err)) throw err;
      handled.add(id);
      log(`Thicket refused ${status === "claim" ? "to hand over" : "to close"} request ${id}: ${(err as Error).message}`);
      return null;
    }
  };
  try {
    await emit({ type: "connected", runtime_id: runtimeId, profile: run.profile, organization: me.slug, membership_id: me.membership_id, trust: settings.trust, serve: settings.serve.map((p) => p.id) });
    while (!signal.aborted) {
      try {
        await renew();
        const pending = await org.request<Inbox>("GET", "/my/agent/inbox");
        for (const item of pending.items ?? []) {
          if (signal.aborted) break;
          if (handled.has(item.id)) continue;
          await renew();
          const decision = admit(item, settings, ledger, now());
          if (!decision.admit) {
            if (await answer(item.id, "dismissed", decision.reason))
              await emit({ type: "dismissed", id: item.id, trigger: item.reason, requester_id: requesterOf(item).id, recording_id: item.source?.id ?? null, reason: decision.reason });
            continue;
          }
          const claimed = await answer(item.id, "claim");
          if (!claimed) continue;
          if (decision.wake) ledger.record(decision.wake.agent_id, decision.wake.thread_id, now());
          await emit(requestLine({ ...item, ...claimed.view, id: item.id, reason: item.reason }, decision, run));
        }
      } catch (error) {
        if (signal.aborted || !transient(error)) throw error;
        log(`Thicket did not answer (${(error as Error).message}); trying again.`);
      }
      await pause(signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { await org.request("POST", "/my/agent/session", { body: { ...body, stop: true } }).catch(() => { log("Could not release the session; its lease will expire automatically."); }); }
}

// --- thicket connect status --------------------------------------------------

const STATUSES = ["pending", "running", "completed", "failed", "interrupted", "dismissed"] as const;

async function connectStatus(ctx: CliContext): Promise<CommandResult> {
  const me = await ownAgent(ctx);
  const org = await ctx.org();
  const self = await lookupPerson(org, me.membership_id).catch(() => null);
  const name = ctx.settings.profile;
  let settings: ConnectSettings | null = null;
  let problem: string | null = null;
  try {
    settings = readConnectSettings(ctx.env, name);
    if (settings && settings.agent_membership_id !== me.membership_id) { settings = null; problem = "written for another agent"; }
  } catch (err) { problem = (err as Error).message; }
  const counts = {} as Record<(typeof STATUSES)[number], number>;
  for (const status of STATUSES) counts[status] = ((await org.request<Inbox>("GET", "/my/agent/inbox", { query: { status } })).items ?? []).length;
  const boss = self?.boss ?? null;
  const agent = { membership_id: me.membership_id, name: self?.name ?? null, organization: me.slug, agent_type: self ? (boss ? "personal" : "shared") : null, boss };
  const tally = STATUSES.map((s) => `${counts[s]} ${s}`).join(", ");
  const setupCmd = `thicket connect setup --profile ${name}`;
  return {
    data: { agent, settings, settings_path: settingsPath(ctx.env, name), ...(problem ? { settings_problem: problem } : {}), counts },
    summary: `${agent.name ?? me.membership_id}: ${settings ? `${trustSentence(settings)} may give it work in ${settings.serve.length} project${settings.serve.length === 1 ? "" : "s"}` : "not set up on this computer"}; ${tally}.`,
    human: [
      `${pc.bold(agent.name ?? me.membership_id)} ${pc.dim(`${agent.agent_type ?? "agent"}${boss ? ` of ${boss.name}` : ""}, ${me.slug}, membership ${me.membership_id}`)}`,
      ...(settings ? settingsLines(settings) : [pc.yellow(`  Not set up on this computer${problem ? ` (${problem})` : ""}. Run: ${setupCmd}`)]),
      `  Requests:     ${tally}`,
    ],
    breadcrumbs: settings
      ? [{ action: "start", cmd: `thicket connect --profile ${name}` }, { action: "change", cmd: setupCmd }]
      : [{ action: "setup", cmd: setupCmd }],
  };
}

const category = "Agent connections";
const idsNote = "Membership ids come from thicket people (your own login), project ids from thicket projects --profile <agent>";
export const connectCommands: CommandSpec[] = [
  { path: ["auth", "agent", "connect"], category, summary: "Connect a named agent to this computer through browser approval",
    flags: [{ flag: "--no-browser", description: "Print the approval link without opening it" }, { flag: "--device-name <name>", description: "Name this connection in Thicket" }],
    notes: [
      "Use a separate --profile. In the browser you pick your personal agent (or create it), or a shared agent, and choose Full or Read-only access",
      "One connection per agent: approving a new one disconnects the earlier one. This profile is never overwritten; disconnect it first with thicket auth logout --profile <name>",
      "Personal agents are managed in My settings > My agent, shared agents in Admin > Manage agents. Next: thicket connect setup --profile <name>",
    ],
    handler: (ctx, _args, options) => pairAgent(ctx, options) },
  { path: ["connect"], category, summary: "Run the connector: hold the agent's session and print each trusted request",
    notes: [
      "Prints NDJSON: one connected line, then one request line per admitted request (dismissed lines record what was turned away). The thicket-connect skill in a running Claude Code session monitors it and handles each request",
      "Needs thicket connect setup first. One connector per agent. It starts from the present: requests from more than a minute before it started are not picked up, and nothing queues while it is stopped",
      "Several requests can run at once. Stopping marks running work interrupted; nothing is retried",
    ],
    handler: async ctx => {
      const abort = makeAbort();
      try { await listenAgent(ctx, abort.signal, async line => { if (!process.stdout.write(JSON.stringify(line) + "\n")) await once(process.stdout, "drain"); }); }
      finally { abort.dispose(); }
      return { data: {}, silent: true };
    } },
  { path: ["connect", "setup"], category, summary: "Say who may give the agent work and which projects it serves",
    flags: [
      { flag: "--trust <mode>", description: "operator (default: the operator alone), allowlist (the operator and people named with --allow), or project (also anyone on its projects who isn't a client, as a participant)" },
      { flag: "--operator <membership-id>", description: "A shared agent's operator. A personal agent's operator is always its owner" },
      { flag: "--operator-profile <profile>", description: "A shared agent's operator, read from that person's own profile on this computer" },
      { flag: "--allow <membership-id...>", description: "People who may also give it work (repeatable). Passing it replaces the list; --trust operator clears it" },
      { flag: "--allow-assignments-from-authorized [bool]", description: "Count assignments from the allowlist too, not only the operator (=false turns it off)" },
      { flag: "--allow-agent <membership-id...>", description: "Another agent that may wake it by mention, as a participant (repeatable)" },
      { flag: "--disallow-agent <membership-id...>", description: "Stop another agent from waking it (repeatable)" },
      { flag: "--serve <project-id...>", description: "A project it works in; it must be on it (repeatable)" },
      { flag: "--unserve <project-id...>", description: "Stop working in a project (repeatable)" },
      { flag: "--watch-completions <project-id...>", description: "Served projects whose completions reach it as context (repeatable; replaces the list)" },
      { flag: "--no-watch-completions", description: "Watch no completions" },
    ],
    notes: [
      "Writes <config dir>/connect/<profile>.json (private, no secrets). Every run keeps what it doesn't pass; a failure writes nothing",
      "Other agents may wake it at most 3 times per thread and 20 times per agent in 24 hours. The caps are fixed",
      "A request is the owner's word (owner: true) only when the operator wrote it themselves: their mention, assignment or direct message",
      "Restart thicket connect after a change: it reads the settings when it starts",
      idsNote,
    ],
    handler: (ctx, _args, options) => connectSetup(ctx, options) },
  { path: ["connect", "status"], category, summary: "Show the agent, its settings on this computer, and its requests by state",
    notes: ["Read-only and safe while the connector runs. Counts are pending, running, completed, failed, interrupted and dismissed"],
    handler: connectStatus },
  { path: ["connect", "settle"], category, summary: "Record completion or failure after handling an agent request",
    args: [{ name: "request-id", required: true, description: "Request id emitted by the connector" }],
    flags: [{ flag: "--runtime <id>", description: "Runtime id from the request" }, { flag: "--status <status>", description: "completed or failed" }, { flag: "--result <text>", description: "Brief outcome or link to the reply" }],
    notes: ["Needs the connector that handed the request over to still be running"],
    handler: async (ctx, [id], options) => {
      await ownAgent(ctx);
      if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(String(options.runtime)) || !["completed", "failed"].includes(String(options.status)) || !options.result)
        throw new CliError("usage", "Provide a request id, --runtime, --status completed|failed, and --result");
      const org = await ctx.org();
      const data = await org.request("POST", `/my/agent/inbox/${id}`, { body: { runtime_id: options.runtime, status: options.status, result: options.result } });
      return { data, summary: `Request ${options.status}.` };
    } },
];
