// The local connector: `thicket agent watch` reads the agent's own inbox,
// corroborates and trust-gates every row, acks directives, and prints one
// NDJSON event per line for a driver (the /thicket-connect skill) to act on.
// `agent-hook session-start` is the Claude Code plugin's status line.
import pc from "picocolors";
import { runWatch, type TrustMode } from "../lib/connector.js";
import { userAgent, type CliContext } from "../lib/context.js";
import type { Cursor } from "../lib/inbox.js";
import { CliError, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { looksLikeId, resolveProject } from "../lib/resolve.js";
import { listRuns, overlappingRun, registerRun, unregisterRun, type RunRecord } from "../lib/runs.js";
import { diag, makeAbort, ndjson } from "../lib/watch-io.js";

const CATEGORY = "Agent connector";

function many(value: unknown): string[] {
  if (value === undefined || value === null || value === false) return [];
  const list = Array.isArray(value) ? value.map(String) : [String(value)];
  return list.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

async function status(ctx: CliContext): Promise<CommandResult> {
  const runs = listRuns();
  return {
    data: runs,
    summary: runs.length ? `${runs.length} watch${runs.length === 1 ? "" : "es"} running` : "No watches running",
    ids: runs.map((r) => String(r.pid)),
    human: runs.length
      ? table(
          ["PID", "AGENT", "ORG", "PROJECTS", "TRUST", "SOURCE", "SINCE"],
          runs.map((r) => [
            String(r.pid),
            r.agent.name,
            r.org,
            r.projects.length ? r.projects.map((p) => p.name).join(", ") : "all",
            r.trust.mode + (r.trust.allow.length ? ` (+${r.trust.allow.length})` : ""),
            r.source,
            r.started_at.slice(0, 16),
          ]),
        )
      : ["No watches running on this machine."],
    breadcrumbs: [{ action: "start", cmd: `thicket -P <agent-profile> agent watch --project <project>` }],
  };
}

async function watch(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  if (options.status) return status(ctx);

  const me = await ctx.whoami();
  const slug = await ctx.orgSlug();
  if (me.membership_kind !== "agent") {
    throw new CliError(
      "usage",
      `agent watch reads the agent's own inbox, but this token belongs to a ${me.membership_kind ?? "person"} membership (${me.membership_id})`,
      "Mint the agent's token in the web app (Admin, AI agents), store it in a profile: printf '%s' \"$TOKEN\" | thicket -P <agent> auth login --with-token, then run thicket -P <agent> agent watch",
    );
  }
  const org = await ctx.org();
  type AgentRow = { membership_id: string; name: string; directable_by: string; operators: { membership_id: string; name: string | null }[] };
  const agentRow = await org.request<AgentRow>("GET", `/agents/${me.membership_id}`).catch(() => null);
  const agentName = agentRow?.name ?? "agent";
  if (options.agent) {
    const ref = String(options.agent).replace(/^@/, "");
    const matches = looksLikeId(ref)
      ? ref.toLowerCase() === me.membership_id.toLowerCase()
      : ref.toLowerCase() === agentName.toLowerCase();
    if (!matches) {
      throw new CliError(
        "usage",
        `This token is ${agentName} (${me.membership_id}), not "${ref}"`,
        "Run the watch under that agent's own profile: thicket -P <agent> agent watch",
      );
    }
  }

  const projects: { id: string; name: string }[] = [];
  for (const ref of many(options.project)) {
    const project = await resolveProject(ctx, ref);
    if (project.name === project.id) {
      const detail = (await org.projects.get(project.id).catch(() => null)) as { name?: string } | null;
      project.name = detail?.name ?? project.id;
    }
    if (!projects.some((p) => p.id === project.id)) projects.push(project);
  }

  const allow = many(options.allow);
  for (const id of allow) {
    if (!looksLikeId(id)) throw new CliError("usage", `--allow takes membership ids, got "${id}"`, "Find them with: thicket people");
  }
  let mode = String(options.trust ?? (allow.length ? "allowlist" : "operator")) as TrustMode;
  if (!["operator", "allowlist", "members"].includes(mode)) {
    throw new CliError("usage", `--trust must be operator, allowlist, or members, got "${mode}"`);
  }
  if (mode === "allowlist" && allow.length === 0) {
    throw new CliError("usage", "--trust allowlist needs at least one --allow <membership-id>");
  }
  if (allow.length && mode !== "allowlist") {
    throw new CliError("usage", `--allow only applies under --trust allowlist (got --trust ${mode})`);
  }

  const cursor: Cursor = { since: null, after: null };
  if (options.since) {
    if (Number.isNaN(Date.parse(String(options.since)))) throw new CliError("usage", "--since needs an ISO 8601 instant");
    cursor.since = new Date(String(options.since)).toISOString();
  }
  if (options.after) {
    if (!looksLikeId(String(options.after))) throw new CliError("usage", "--after needs a notification id");
    cursor.after = String(options.after);
  }
  const pollSeconds = options.poll ? Math.max(2, Number(options.poll)) : 10;
  const ack = options.ack === false ? false : String(options.ack ?? "On it!");

  const dup = overlappingRun(me.membership_id, projects.map((p) => p.id));
  if (dup && !options.allowDuplicate) {
    throw new CliError(
      "usage",
      `A watch for ${dup.agent.name} already covers ${dup.projects.length ? dup.projects.map((p) => p.name).join(", ") : "every project"} (pid ${dup.pid}); a second one would ack and dispatch every directive twice`,
      "Stop it first, or pass --allow-duplicate if you really mean it",
    );
  }

  const log = diag("watch");
  const { signal, dispose } = makeAbort();
  const record: RunRecord = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    org: slug,
    agent: { membership_id: me.membership_id, name: agentName },
    projects,
    trust: { mode, allow },
    source: options.pollOnly ? "poll" : "sse",
    argv: process.argv.slice(2),
  };
  registerRun(record);
  log(
    `listening as ${agentName} (agent ${me.membership_id}) in ${slug}; projects: ${projects.length ? projects.map((p) => p.name).join(", ") : "all"}; trust: ${mode}${allow.length ? ` (+${allow.join(", ")})` : ""}; ack: ${ack === false ? "off" : JSON.stringify(ack)}; cheers: ${options.cheers === false ? "off" : "polled every 60s"}`,
  );
  if (agentRow) {
    log(`policy: directable by ${agentRow.directable_by}; operators: ${agentRow.operators.map((o) => o.name ?? o.membership_id).join(", ") || "none"}`);
  }
  try {
    await runWatch({
      ctx,
      baseUrl: ctx.settings.baseUrl,
      org: slug,
      agent: { membership_id: me.membership_id, name: agentName },
      projects,
      trust: { mode, allow },
      cursor,
      pollSeconds,
      cheers: options.cheers !== false,
      cheerPollSeconds: 60,
      ack,
      pollOnly: options.pollOnly === true,
      signal,
      log,
      emit: ndjson,
    });
  } finally {
    unregisterRun(process.pid);
    dispose();
    log("stopped");
  }
  return { data: null, silent: true };
}

/** The plugin's SessionStart hook: one line, never a failure. */
async function sessionStart(ctx: CliContext): Promise<CommandResult> {
  let line: string;
  try {
    const creds = await ctx.credentials();
    if (!creds) {
      line = "Thicket CLI: not signed in; run `thicket auth login` (a browser approval) before using thicket commands.";
    } else {
      const response = await fetch(`${ctx.settings.baseUrl}/api/v1/authorization`, {
        headers: { authorization: `Bearer ${creds.token}`, "user-agent": userAgent() },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) {
        line = `Thicket CLI: the stored token was refused (HTTP ${response.status}); run \`thicket auth login\`.`;
      } else {
        const doc = (await response.json()) as {
          scope: string;
          organizations: { slug: string; name: string; membership_id: string; membership_kind?: string; role: string }[];
        };
        const acting = ctx.settings.org ?? (doc.organizations.length === 1 ? doc.organizations[0].slug : null);
        const org = doc.organizations.find((o) => o.slug === acting) ?? doc.organizations[0];
        let who = org ? `membership ${org.membership_id}` : "no organization";
        if (org) {
          try {
            const people = await fetch(`${ctx.settings.baseUrl}/api/v1/${org.slug}/people`, {
              headers: { authorization: `Bearer ${creds.token}`, "user-agent": userAgent() },
              signal: AbortSignal.timeout(4000),
            });
            if (people.ok) {
              const rows = (await people.json()) as { membership_id: string; name: string }[];
              const mine = rows.find((p) => p.membership_id === org.membership_id);
              if (mine) who = `${mine.name} (${org.membership_kind ?? "person"}, ${org.role})`;
            }
          } catch {
            // Best effort; the membership id already says who.
          }
        }
        line = `Thicket CLI: signed in as ${who} in ${doc.organizations.map((o) => o.slug).join(", ") || "no orgs"}${acting ? ` (acting in ${acting})` : doc.organizations.length > 1 ? " (no default org: pass --org or run thicket orgs use <slug>)" : ""}, ${doc.scope} scope. Skill: /thicket-cli; catalog: thicket commands --json.`;
      }
    }
  } catch (err) {
    line = `Thicket CLI: could not reach ${ctx.settings.baseUrl} (${err instanceof Error ? err.message : String(err)}); thicket commands may fail until it is back.`;
  }
  process.stdout.write(`${line}\n`);
  return { data: { line }, silent: true };
}

export const agentCommands: CommandSpec[] = [
  {
    path: ["agent", "watch"],
    category: CATEGORY,
    summary: "Run the local connector: trusted, corroborated agent events as NDJSON (until Ctrl-C)",
    description:
      "Reads the signed-in agent's inbox (the SSE stream, or polling with presence when the stream is unavailable), re-fetches every recording to corroborate the claim, applies the trust mode, acks directives with a cheer, and prints one JSON object per line: {event_id, kind, created_at, actor, recording, comment, cheer, instruction, trigger, ack, cursor}. Diagnostics go to stderr. Runs under the agent's own token.",
    flags: [
      { flag: "--agent <name-or-id>", description: "The agent this token must belong to (default: the signed-in agent)" },
      { flag: "--project <project...>", description: "Only these projects (name or id; repeatable). Default: all" },
      { flag: "--trust <mode>", description: "operator (default: server directive verdicts only), allowlist (+ --allow), or members (any non-client member)" },
      { flag: "--allow <membership-id...>", description: "Membership ids allowed to direct the agent under --trust allowlist (repeatable)" },
      { flag: "--since <iso>", description: "Resume cursor: rows after this instant (default: now, never history)" },
      { flag: "--after <id>", description: "Resume cursor tie-breaker: the last notification id handled" },
      { flag: "--poll <seconds>", description: "Poll interval when the stream is unavailable (default 10)" },
      { flag: "--poll-only", description: "Never open the stream; poll with presence instead" },
      { flag: "--no-cheers", description: "Skip the received-cheers trigger (otherwise polled every 60s)" },
      { flag: "--ack <text>", description: 'Cheer each directive with this the moment it is emitted (default "On it!")', default: "On it!" },
      { flag: "--no-ack", description: "Do not ack directives" },
      { flag: "--status", description: "List the watches running on this machine and exit" },
      { flag: "--allow-duplicate", description: "Start even if a running watch already covers this agent and projects" },
    ],
    notes: [
      "kind is one of mentioned, assigned, commented, cheered, card_added, todo_added, chatted; only mentioned and assigned are directives (acked, worked)",
      "Every event is corroborated against GET /recordings/{id} (mentioned_membership_ids, assignee_ids), the subscription, or /my/cheers before it is printed",
      "The agent's own activity and client authors never trigger, in every trust mode",
      "Reply on recording.id as the agent (thicket comment <id> ...); comment.id is the comment that carried the mention",
      "Stop with Ctrl-C (SIGINT/SIGTERM); the run record in ~/.config/thicket/runs is removed on exit",
    ],
    handler: watch,
  },
  {
    path: ["agent-hook", "session-start"],
    category: CATEGORY,
    summary: "Claude Code SessionStart hook: one status line (signed in as X in orgs Y, or how to sign in)",
    notes: ["Always exits 0 and prints exactly one line; wired by hooks/hooks.json in the plugin"],
    handler: sessionStart,
  },
];
