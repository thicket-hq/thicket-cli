// One declarative command registry drives everything: the commander wiring,
// `thicket commands --json` (the agent catalog), and `--agent --help`
// (structured per-command help). Because they all read the same specs,
// catalog and reality cannot drift: that holds by construction, and a test
// asserts it anyway.
import type { CliContext } from "./context.js";
import type { CommandResult } from "./output.js";

export type ArgSpec = {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
};

export type FlagSpec = {
  /** Commander notation, e.g. "-i, --in <project>". */
  flag: string;
  description: string;
  default?: string | boolean;
};

export type CommandSpec = {
  /** Command path, e.g. ["projects", "list"] or ["todo"]. */
  path: string[];
  category: string;
  summary: string;
  description?: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  /** Domain gotchas surfaced in agent help. */
  notes?: string[];
  /** Aliases for the leaf command. */
  aliases?: string[];
  handler: (
    ctx: CliContext,
    positionals: string[],
    options: Record<string, unknown>,
  ) => Promise<CommandResult>;
};

/** Usage line for the catalog: "thicket todos add <title> [flags]". */
export function usageOf(spec: CommandSpec): string {
  const args = (spec.args ?? [])
    .map((a) => {
      const inner = a.variadic ? `${a.name}...` : a.name;
      return a.required ? `<${inner}>` : `[${inner}]`;
    })
    .join(" ");
  const flags = spec.flags?.length ? "[flags]" : "";
  return ["thicket", ...spec.path, args, flags].filter(Boolean).join(" ");
}

/** The machine-readable catalog entry. */
export function catalogEntry(spec: CommandSpec) {
  return {
    name: spec.path.join(" "),
    category: spec.category,
    summary: spec.summary,
    usage: usageOf(spec),
    ...(spec.description ? { description: spec.description } : {}),
    args: (spec.args ?? []).map((a) => ({
      name: a.name,
      required: a.required ?? false,
      variadic: a.variadic ?? false,
      description: a.description,
    })),
    flags: (spec.flags ?? []).map((f) => ({
      flag: f.flag,
      description: f.description,
      ...(f.default !== undefined ? { default: f.default } : {}),
    })),
    ...(spec.notes?.length ? { notes: spec.notes } : {}),
    ...(spec.aliases?.length ? { aliases: spec.aliases } : {}),
  };
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { flag: "--org <slug>", description: "Organization to act in (default: your only org, or the profile's saved org)" },
  { flag: "-P, --profile <name>", description: "Named profile to use (default: THICKET_PROFILE or the config default)" },
  { flag: "-j, --json", description: "JSON envelope output: {ok, data, summary, breadcrumbs}" },
  { flag: "-q, --quiet", description: "Raw data only, no envelope (errors stay structured)" },
  { flag: "--agent", description: "Agent mode: data-only JSON, structured errors, no prompts" },
  { flag: "--ids-only", description: "One id per line" },
  { flag: "--count", description: "Item count only" },
  { flag: "--base-url <url>", description: "API host override (default: https://www.thickethq.com)" },
  { flag: "--no-color", description: "Disable ANSI colors" },
];
