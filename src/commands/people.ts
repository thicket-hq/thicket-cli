// People and their membership ids, shared by mentions and assignments.
import pc from "picocolors";
import type { CliContext, Person } from "../lib/context.js";
import { mentionToken } from "../lib/markdown.js";
import { table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";

const PEOPLE = "People";

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
    ],
  };
}

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
    notes: ["membership_id is the id mentions, assignees, use; `mention` is the paste-ready token"],
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
];
