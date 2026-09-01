// People and AI agents: membership ids (what mentions, assignees, and the
// connector all speak), kind and presence, and the agent lifecycle.
import { ThicketError } from "thicket-sdk";
import pc from "picocolors";
import type { CliContext, Person } from "../lib/context.js";
import { mentionToken } from "../lib/markdown.js";
import { CliError, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { looksLikeId, matchNamed, resolvePeople } from "../lib/resolve.js";

const PEOPLE = "People";
const AGENTS = "Agents";

export type Agent = {
  membership_id: string;
  name: string;
  role: string;
  kind: "agent";
  directable_by: "operators" | "members";
  active: boolean;
  presence_at: string | null;
  operators: { membership_id: string; name: string | null }[];
  token: { id: string; token_prefix: string; scope: string; last_used_at: string | null; created_at: string } | null;
  removed_at: string | null;
  created_at: string;
};

function withMention(p: Person) {
  return { ...p, mention: mentionToken(p.membership_id, p.name) };
}

async function people(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  let rows = await ctx.people();
  const kind = options.agents ? "agent" : options.kind ? String(options.kind) : null;
  if (kind) rows = rows.filter((p) => (p.kind ?? "person") === kind);
  if (options.active) rows = rows.filter((p) => p.active === true);
  const data = rows.map(withMention);
  return {
    data,
    summary: `${rows.length} ${kind === "agent" ? (rows.length === 1 ? "agent" : "agents") : rows.length === 1 ? "person" : "people"}`,
    ids: rows.map((p) => p.membership_id),
    human: table(
      ["NAME", "KIND", "ROLE", "ACTIVE", "EMAIL", "MEMBERSHIP"],
      rows.map((p) => [
        p.name,
        p.kind ?? "person",
        p.role,
        p.active === null || p.active === undefined ? "" : p.active ? pc.green("yes") : "no",
        p.email,
        p.membership_id,
      ]),
    ),
    breadcrumbs: [
      { action: "mention", cmd: 'thicket comment <id> "[@Name](member:<membership_id>) ..."', description: "Pin a mention by membership id" },
      { action: "agents", cmd: "thicket agents", description: "AI agents with operators and presence" },
    ],
  };
}

async function resolveAgent(ctx: CliContext, ref: string): Promise<Agent> {
  const org = await ctx.org();
  if (looksLikeId(ref)) return org.request<Agent>("GET", `/agents/${ref}`);
  const agents = await org.request<Agent[]>("GET", "/agents");
  const match = matchNamed(agents.map((a) => ({ id: a.membership_id, name: a.name })), ref, "agent");
  return agents.find((a) => a.membership_id === match.id)!;
}

function agentLines(a: Agent): string[] {
  return [
    `${pc.bold(a.name)} ${a.active ? pc.green("● listening") : pc.dim("○ offline")}`,
    pc.dim(`membership ${a.membership_id} · ${a.role} · directable by ${a.directable_by}`),
    `Operators: ${a.operators.length ? a.operators.map((o) => `${o.name ?? "?"} (${o.membership_id})`).join(", ") : "none"}`,
    a.token
      ? `Token: ${a.token.token_prefix}… (${a.token.scope}${a.token.last_used_at ? `, last used ${a.token.last_used_at.slice(0, 16)}` : ", never used"})`
      : "Token: none minted (or not visible to your role)",
    a.presence_at ? `Presence: ${a.presence_at}` : "",
    a.removed_at ? pc.yellow(`Deactivated ${a.removed_at}`) : "",
  ].filter(Boolean);
}

async function agentsList(ctx: CliContext): Promise<CommandResult> {
  const org = await ctx.org();
  const rows = await org.request<Agent[]>("GET", "/agents");
  return {
    data: rows.map((a) => ({ ...a, mention: mentionToken(a.membership_id, a.name) })),
    summary: `${rows.length} agent${rows.length === 1 ? "" : "s"}`,
    ids: rows.map((a) => a.membership_id),
    human: rows.length
      ? table(
          ["NAME", "ACTIVE", "DIRECTABLE BY", "OPERATORS", "TOKEN", "MEMBERSHIP"],
          rows.map((a) => [
            a.name,
            a.active ? pc.green("yes") : "no",
            a.directable_by,
            a.operators.map((o) => o.name ?? "?").join(", "),
            a.token ? `${a.token.token_prefix}… (${a.token.scope})` : "",
            a.membership_id,
          ]),
        )
      : ["No agents yet. Create one: thicket agents create <name>"],
    breadcrumbs: [
      { action: "show", cmd: "thicket agents show <agent>" },
      { action: "create", cmd: 'thicket agents create "Name"' },
      { action: "watch", cmd: "thicket -P <agent-profile> agent watch", description: "Run the connector under the agent's token" },
    ],
  };
}

async function agentsShow(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const agent = await resolveAgent(ctx, args[0]);
  return {
    data: { ...agent, mention: mentionToken(agent.membership_id, agent.name) },
    summary: agent.name,
    human: agentLines(agent),
    breadcrumbs: [
      { action: "operators", cmd: `thicket agents operators ${agent.membership_id} <person...>` },
      { action: "token", cmd: `thicket agents token ${agent.membership_id}` },
    ],
  };
}

async function agentsCreate(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const body: Record<string, unknown> = { name: args[0] };
  if (options.directableBy) body.directable_by = policy(options.directableBy);
  if (options.operator) {
    body.operator_ids = await resolvePeople(
      ctx,
      Array.isArray(options.operator) ? options.operator.map(String) : [String(options.operator)],
    );
  }
  const agent = await org.request<Agent>("POST", "/agents", { body });
  return {
    data: agent,
    summary: `Created agent "${agent.name}"`,
    human: [`${pc.green("Created.")} ${agent.name} (${agent.membership_id})`, ...agentLines(agent).slice(2)],
    breadcrumbs: [
      { action: "token", cmd: `thicket agents token ${agent.membership_id}`, description: "Mint its token (web app, Admin, AI agents)" },
    ],
  };
}

function policy(value: unknown): "operators" | "members" {
  const v = String(value);
  if (v !== "operators" && v !== "members") {
    throw new CliError("usage", `--directable-by must be operators or members, got "${v}"`);
  }
  return v;
}

async function agentsUpdate(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const agent = await resolveAgent(ctx, args[0]);
  const body: Record<string, unknown> = {};
  if (options.name !== undefined) body.name = String(options.name);
  if (options.directableBy !== undefined) body.directable_by = policy(options.directableBy);
  if (Object.keys(body).length === 0) throw new CliError("usage", "Nothing to update", "Pass --name or --directable-by");
  const org = await ctx.org();
  const updated = await org.request<Agent>("PATCH", `/agents/${agent.membership_id}`, { body });
  return { data: updated, summary: `Updated "${updated.name}"`, human: [`${pc.green("Updated.")} ${updated.name}`] };
}

async function agentsRename(ctx: CliContext, args: string[]): Promise<CommandResult> {
  if (!args[1]) throw new CliError("usage", "What is the new name?", 'thicket agents rename <agent> "New name"');
  return agentsUpdate(ctx, [args[0]], { name: args[1] });
}

async function agentsOperators(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const [ref, ...people] = args;
  const agent = await resolveAgent(ctx, ref);
  const org = await ctx.org();
  if (people.length === 0 && !options.add && !options.remove) {
    return {
      data: agent.operators,
      summary: `${agent.operators.length} operator${agent.operators.length === 1 ? "" : "s"} may direct ${agent.name}`,
      ids: agent.operators.map((o) => o.membership_id),
      human: table(["OPERATOR", "MEMBERSHIP"], agent.operators.map((o) => [o.name ?? "?", o.membership_id])),
    };
  }
  const set = new Set(options.add || options.remove ? agent.operators.map((o) => o.membership_id) : []);
  for (const id of await resolvePeople(ctx, people)) {
    if (options.remove) set.delete(id);
    else set.add(id);
  }
  const result = await org.request<{ operators: Agent["operators"] }>("PUT", `/agents/${agent.membership_id}/operators`, {
    body: { operator_ids: [...set] },
  });
  return {
    data: result.operators,
    summary: `${result.operators.length} operator${result.operators.length === 1 ? "" : "s"} may direct ${agent.name}`,
    ids: result.operators.map((o) => o.membership_id),
    human: [pc.green("Saved."), ...table(["OPERATOR", "MEMBERSHIP"], result.operators.map((o) => [o.name ?? "?", o.membership_id]))],
  };
}

async function agentsToken(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const agent = await resolveAgent(ctx, args[0]);
  const org = await ctx.org();
  const slug = await ctx.orgSlug();
  const mintUrl = `${ctx.settings.baseUrl}/o/${slug}/admin/agents`;
  const scope = options.scope ? String(options.scope) : "full";
  try {
    const minted = await org.request<{ token: string; id: string; token_prefix: string; scope: string; created_at: string }>(
      "POST",
      `/agents/${agent.membership_id}/token`,
      { body: { scope } },
    );
    return {
      data: { minted: true, agent_id: agent.membership_id, ...minted },
      summary: `Minted a ${minted.scope} token for ${agent.name}; shown once`,
      human: [
        `${pc.green("Minted.")} ${agent.name}'s ${minted.scope} token (shown once):`,
        minted.token,
        pc.dim(`Store it for the connector: printf '%s' "$TOKEN" | thicket -P ${slugify(agent.name)} auth login --with-token`),
      ],
    };
  } catch (err) {
    if (err instanceof ThicketError && (err.apiCode === "session_required" || err.status === 403)) {
      const explanation =
        `Tokens are minted from a signed-in browser session, never from an API token: open ${mintUrl} (Admin, AI agents), mint or rotate ${agent.name}'s token there, and store it in a profile for the connector.`;
      return {
        data: {
          minted: false,
          agent_id: agent.membership_id,
          agent_name: agent.name,
          mint_url: mintUrl,
          reason: "session_required",
          next: `printf '%s' "$TOKEN" | thicket -P ${slugify(agent.name)} auth login --with-token`,
        },
        summary: explanation,
        notice: `Not minted: ${explanation}`,
        human: [
          pc.yellow("Not minted from the CLI."),
          `Tokens are minted in the web app under Admin, AI agents: ${pc.cyan(mintUrl)}`,
          "Mint or rotate the token there (the plaintext is shown once), then store it in a profile:",
          `  printf '%s' "$TOKEN" | thicket -P ${slugify(agent.name)} auth login --with-token`,
          `  thicket -P ${slugify(agent.name)} agent watch`,
        ],
      };
    }
    throw err;
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

async function agentsDeactivate(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const agent = await resolveAgent(ctx, args[0]);
  const org = await ctx.org();
  await org.request("DELETE", `/agents/${agent.membership_id}`);
  return {
    data: { membership_id: agent.membership_id, name: agent.name, active: false },
    summary: `Deactivated ${agent.name}; its token is revoked`,
    human: [`${pc.green("Deactivated.")} ${agent.name}; its token is revoked. Reverse with: thicket agents reactivate ${agent.membership_id}`],
  };
}

async function agentsReactivate(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const agent = await resolveAgent(ctx, args[0]);
  const org = await ctx.org();
  const updated = await org.request<Agent>("PATCH", `/agents/${agent.membership_id}`, { body: { active: true } });
  return {
    data: updated,
    summary: `Reactivated ${updated.name}; mint a new token before it can act`,
    human: [`${pc.green("Reactivated.")} ${updated.name}. Mint a new token: thicket agents token ${updated.membership_id}`],
  };
}

const agentArg = { name: "agent", description: "Agent name or membership id", required: true };

export const peopleCommands: CommandSpec[] = [
  {
    path: ["people"],
    category: PEOPLE,
    summary: "The organization's people with membership ids, kind, and presence (bare shorthand)",
    flags: [
      { flag: "--agents", description: "AI agents only" },
      { flag: "--kind <kind>", description: "person or agent" },
      { flag: "--active", description: "Agents whose runtime is listening right now" },
    ],
    notes: ["membership_id is the id mentions, assignees, and the connector speak; `mention` is the paste-ready token"],
    handler: people,
  },
  {
    path: ["people", "list"],
    category: PEOPLE,
    summary: "The organization's people with membership ids, kind, and presence",
    flags: [
      { flag: "--agents", description: "AI agents only" },
      { flag: "--kind <kind>", description: "person or agent" },
      { flag: "--active", description: "Agents whose runtime is listening right now" },
    ],
    handler: people,
  },
  { path: ["agents"], category: AGENTS, summary: "List the organization's AI agents (bare shorthand for agents list)", handler: agentsList },
  { path: ["agents", "list"], category: AGENTS, summary: "List the organization's AI agents with operators and presence", handler: agentsList },
  { path: ["agents", "show"], category: AGENTS, summary: "One agent in full", args: [agentArg], handler: agentsShow },
  {
    path: ["agents", "create"],
    category: AGENTS,
    summary: "Create an AI agent (owners and admins)",
    args: [{ name: "name", description: "Agent name", required: true }],
    flags: [
      { flag: "--directable-by <policy>", description: "operators (default) or members: whose mentions and assignments are directives" },
      { flag: "--operator <person...>", description: "Its operators (default: you)" },
    ],
    notes: ["The creator becomes the first operator unless --operator is given; mint the token next (web app, Admin, AI agents)"],
    handler: agentsCreate,
  },
  {
    path: ["agents", "update"],
    category: AGENTS,
    summary: "Rename an agent or change who may direct it",
    args: [agentArg],
    flags: [
      { flag: "--name <name>", description: "New name" },
      { flag: "--directable-by <policy>", description: "operators or members" },
    ],
    handler: agentsUpdate,
  },
  {
    path: ["agents", "rename"],
    category: AGENTS,
    summary: "Rename an agent",
    args: [agentArg, { name: "name", description: "New name", required: true }],
    handler: agentsRename,
  },
  {
    path: ["agents", "operators"],
    category: AGENTS,
    summary: "Show or replace who may direct an agent",
    args: [agentArg, { name: "person", description: '"me", a name, an email, or a membership id', variadic: true }],
    flags: [
      { flag: "--add", description: "Add to the current operators instead of replacing" },
      { flag: "--remove", description: "Remove these people instead of replacing" },
    ],
    notes: ["Operators must be current non-client people; unknown ids are refused, never dropped"],
    handler: agentsOperators,
  },
  {
    path: ["agents", "token"],
    category: AGENTS,
    summary: "Mint or rotate the agent's token (needs a browser session; the CLI explains where)",
    args: [agentArg],
    flags: [{ flag: "--scope <scope>", description: "full (default) or read" }],
    notes: [
      "Token minting is session-only server-side; with an API token the command answers minted:false and the web URL (Admin, AI agents)",
      "Store the minted token in a profile: printf '%s' \"$TOKEN\" | thicket -P <agent> auth login --with-token",
    ],
    handler: agentsToken,
  },
  { path: ["agents", "deactivate"], category: AGENTS, summary: "Deactivate an agent (revokes its token; reversible)", args: [agentArg], handler: agentsDeactivate },
  { path: ["agents", "reactivate"], category: AGENTS, summary: "Reactivate a deactivated agent (mint a new token after)", args: [agentArg], handler: agentsReactivate },
];
