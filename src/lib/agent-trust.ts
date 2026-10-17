// Who may give a named agent work is decided on the agent's computer, never
// by the server: `thicket connect setup` writes the settings here, and
// `thicket connect` admits each inbox request against them. The server sends
// the agent everything addressed to it; this module is the filter.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";
import { CliError } from "./output.js";

export const TRUST_MODES = ["operator", "allowlist", "project"] as const;
export type TrustMode = (typeof TRUST_MODES)[number];

/** Other agents may wake this one at most this often: fixed, not a setting. */
export const AGENT_CAPS = { per_thread: 3, per_agent_per_day: 20 } as const;
const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DISMISS_REASONS = ["not_trusted", "not_served", "cap_reached", "completions_off", "client"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** Reasons where a person asked for something: acknowledged, and the only ones an owner's word rides on. */
const ASKS = new Set(["mentioned", "assigned", "pinged"]);

export type Named = { membership_id: string; name: string };
export type ProjectRef = { id: string; name: string };

export type ConnectSettings = {
  version: 1;
  profile: string;
  base_url: string;
  organization: string;
  agent_membership_id: string;
  agent_name: string;
  agent_type: "personal" | "shared";
  /** For a personal agent, its owner (boss); for a shared one, the person setup named. */
  operator_id: string;
  operator_name: string;
  operator_from: "owner" | "membership_id" | "profile";
  /** Whose own words are the owner's: a request is `owner` only when this person wrote it. */
  owner_id: string;
  trust: TrustMode;
  allow: Named[];
  allow_assignments_from_authorized: boolean;
  allow_agents: Named[];
  agent_caps: { per_thread: number; per_agent_per_day: number };
  serve: ProjectRef[];
  watch_completions: ProjectRef[];
  saved_at: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

export function connectDir(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "connect");
}

/** Profile names are letters, digits, - and _, so they are safe file names. */
export function settingsPath(env: NodeJS.ProcessEnv, profile: string): string {
  return join(connectDir(env), `${profile}.json`);
}

export function statePath(env: NodeJS.ProcessEnv, profile: string): string {
  return join(connectDir(env), `${profile}.state.json`);
}

/** Atomic and private: a reader never sees half a file, and nobody else reads it. */
function writePrivate(path: string, value: unknown, env: NodeJS.ProcessEnv): void {
  mkdirSync(connectDir(env), { recursive: true, mode: 0o700 });
  const scratch = `${path}.${randomUUID()}.tmp`;
  writeFileSync(scratch, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(scratch, path);
}

const isNamed = (v: unknown): v is Named =>
  !!v && typeof v === "object" && isUuid((v as Named).membership_id) && typeof (v as Named).name === "string";
const isProject = (v: unknown): v is ProjectRef =>
  !!v && typeof v === "object" && isUuid((v as ProjectRef).id) && typeof (v as ProjectRef).name === "string";

function isSettings(v: unknown): v is ConnectSettings {
  const s = v as ConnectSettings;
  return !!s && typeof s === "object" && s.version === 1 &&
    typeof s.profile === "string" && typeof s.base_url === "string" && typeof s.organization === "string" &&
    isUuid(s.agent_membership_id) && typeof s.agent_name === "string" &&
    (s.agent_type === "personal" || s.agent_type === "shared") &&
    isUuid(s.operator_id) && typeof s.operator_name === "string" &&
    ["owner", "membership_id", "profile"].includes(s.operator_from) && isUuid(s.owner_id) &&
    (TRUST_MODES as readonly string[]).includes(s.trust) &&
    Array.isArray(s.allow) && s.allow.every(isNamed) &&
    typeof s.allow_assignments_from_authorized === "boolean" &&
    Array.isArray(s.allow_agents) && s.allow_agents.every(isNamed) &&
    Array.isArray(s.serve) && s.serve.every(isProject) &&
    Array.isArray(s.watch_completions) && s.watch_completions.every(isProject) &&
    typeof s.saved_at === "string";
}

/** The agent's settings, or null when setup never ran for this profile. */
export function readConnectSettings(env: NodeJS.ProcessEnv, profile: string): ConnectSettings | null {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(env, profile), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("usage", "Could not read this agent's connect settings", `Run: thicket connect setup --profile ${profile}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!isSettings(parsed)) {
    throw new CliError("usage", "This agent's connect settings are unreadable", `Run thicket connect setup --profile ${profile} again`);
  }
  return parsed;
}

export function writeConnectSettings(env: NodeJS.ProcessEnv, profile: string, settings: ConnectSettings): string {
  const path = settingsPath(env, profile);
  writePrivate(path, settings, env);
  return path;
}

// --- Agent-to-agent caps, kept across runs so a restart never resets them ---

type Wake = { agent_id: string; thread_id: string; at: number };

export class WakeLedger {
  private constructor(private readonly path: string, private readonly env: NodeJS.ProcessEnv, private wakes: Wake[]) {}

  static load(env: NodeJS.ProcessEnv, profile: string, now: number): WakeLedger {
    const path = statePath(env, profile);
    let wakes: Wake[] = [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { agent_wakes?: { agent_id?: unknown; thread_id?: unknown; at?: unknown }[] };
      wakes = (parsed.agent_wakes ?? []).flatMap((w) =>
        typeof w.agent_id === "string" && typeof w.thread_id === "string" && typeof w.at === "string" && Number.isFinite(Date.parse(w.at))
          ? [{ agent_id: w.agent_id, thread_id: w.thread_id, at: Date.parse(w.at) }]
          : []);
    } catch {
      // No ledger yet, or an unreadable one: start counting from now.
    }
    const ledger = new WakeLedger(path, env, wakes);
    ledger.prune(now);
    return ledger;
  }

  private prune(now: number): void {
    this.wakes = this.wakes.filter((w) => now - w.at < CAP_WINDOW_MS && w.at <= now);
  }

  /** True when one more wake from this agent in this thread would pass a cap. */
  full(agentId: string, threadId: string, now: number): boolean {
    this.prune(now);
    const inThread = this.wakes.filter((w) => w.thread_id === threadId).length;
    const fromAgent = this.wakes.filter((w) => w.agent_id === agentId).length;
    return inThread >= AGENT_CAPS.per_thread || fromAgent >= AGENT_CAPS.per_agent_per_day;
  }

  record(agentId: string, threadId: string, now: number): void {
    this.prune(now);
    this.wakes.push({ agent_id: agentId, thread_id: threadId, at: now });
    writePrivate(this.path, {
      agent_wakes: this.wakes.map((w) => ({ agent_id: w.agent_id, thread_id: w.thread_id, at: new Date(w.at).toISOString() })),
    }, this.env);
  }
}

// --- Admission ---------------------------------------------------------------

export type InboxRequester = { membership_id?: string; name?: string | null; kind?: string; client?: boolean };
export type InboxSource = {
  id: string; type?: string; project_id?: string | null; parent_id?: string | null;
  title?: string | null; content?: string | null; creator_membership_id?: string | null; updated_at?: string;
};
export type InboxItem = {
  id: string;
  reason: string;
  status?: string;
  requester?: InboxRequester | null;
  requester_membership_id?: string | null;
  source?: InboxSource | null;
  subject?: { id: string; type?: string; title?: string | null } | null;
  project?: { id: string; name?: string | null } | null;
  reply_to?: unknown;
  [key: string]: unknown;
};

export type Admission =
  | { admit: true; role: "operator" | "participant"; owner: boolean; acknowledge: boolean; wake?: { agent_id: string; thread_id: string } }
  | { admit: false; reason: DismissReason };

export function requesterOf(item: InboxItem): { id: string | null; name: string | null; kind: string; client: boolean | undefined } {
  const r = item.requester ?? {};
  return {
    id: r.membership_id ?? item.requester_membership_id ?? null,
    name: r.name ?? null,
    kind: r.kind ?? "person",
    client: r.client,
  };
}

export function projectOf(item: InboxItem): string | null {
  return item.project ? item.project.id : (item.source?.project_id ?? null);
}

/** The thread a request belongs to, for the per-thread cap: what it is about. */
export function threadOf(item: InboxItem): string {
  return item.subject?.id ?? item.source?.parent_id ?? item.source?.id ?? item.id;
}

const drop = (reason: DismissReason): Admission => ({ admit: false, reason });

/**
 * One request against the settings. Fails closed: anything the settings do
 * not plainly trust is dropped, with the reason the server records.
 */
export function admit(item: InboxItem, settings: ConnectSettings, ledger: WakeLedger, now: number): Admission {
  const requester = requesterOf(item);
  if (!requester.id) return drop("not_trusted");
  if (requester.client === true) return drop("client");
  const project = projectOf(item);
  // A direct message has no project: trust alone judges it.
  if (project && !settings.serve.some((p) => p.id === project)) return drop("not_served");
  if (item.reason === "completed" && !(project && settings.watch_completions.some((p) => p.id === project))) {
    return drop("completions_off");
  }
  const acknowledge = ASKS.has(item.reason);

  if (requester.kind === "agent") {
    if (item.reason !== "mentioned") return drop("not_trusted");
    if (!settings.allow_agents.some((a) => a.membership_id === requester.id)) return drop("not_trusted");
    const thread = threadOf(item);
    if (ledger.full(requester.id, thread, now)) return drop("cap_reached");
    return { admit: true, role: "participant", owner: false, acknowledge, wake: { agent_id: requester.id, thread_id: thread } };
  }
  if (requester.kind !== "person") return drop("not_trusted");

  const isOperator = requester.id === settings.operator_id;
  const allowed = settings.trust !== "operator" && settings.allow.some((p) => p.membership_id === requester.id);
  if (item.reason === "assigned" && !(isOperator || (allowed && settings.allow_assignments_from_authorized))) {
    return drop("not_trusted");
  }
  let role: "operator" | "participant";
  if (isOperator || allowed) role = "operator";
  // A participant must be plainly not a client: an unknown flag never admits one.
  else if (settings.trust === "project" && requester.client === false) role = "participant";
  else return drop("not_trusted");

  const owner = isOperator && requester.id === settings.owner_id &&
    item.source?.creator_membership_id === requester.id && ASKS.has(item.reason);
  return { admit: true, role, owner, acknowledge };
}
