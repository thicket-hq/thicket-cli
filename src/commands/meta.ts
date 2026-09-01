// Self-description: the machine-readable catalog and the embeddable agent
// skill. These are what make the CLI agent-navigable without prior
// knowledge.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { VERSION } from "../lib/context.js";
import { CliError, table, type CommandResult } from "../lib/output.js";
import {
  catalogEntry,
  GLOBAL_FLAGS,
  type CommandSpec,
} from "../lib/registry.js";

const CATEGORY = "Meta";

/** The package root: dist/commands/meta.js → ../.. (also correct from src/ in dev). */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

/** The skills this package ships, by directory name under skills/. */
export function packagedSkills(): string[] {
  return ["thicket-cli", "thicket-connect"];
}

export function skillSourcePath(name = "thicket-cli"): string {
  return join(packageRoot(), "skills", name, "SKILL.md");
}

/** Copies every packaged skill into <dir>/<name>/SKILL.md. */
export function installSkills(dir: string, only?: string[]): { name: string; path: string }[] {
  const installed: { name: string; path: string }[] = [];
  for (const name of packagedSkills()) {
    if (only?.length && !only.includes(name)) continue;
    let text: string;
    try {
      text = readFileSync(skillSourcePath(name), "utf8");
    } catch {
      throw new CliError("api", `The packaged skill ${name} is missing from this install`);
    }
    const target = join(dir, name);
    mkdirSync(target, { recursive: true });
    const dest = join(target, "SKILL.md");
    writeFileSync(dest, text);
    installed.push({ name, path: dest });
  }
  return installed;
}

export function metaCommands(
  getAll: () => CommandSpec[],
): CommandSpec[] {
  return [
    {
      path: ["commands"],
      category: CATEGORY,
      aliases: ["cmds"],
      summary: "The full command catalog (use --json for the machine-readable form)",
      notes: [
        "Agents: run `thicket commands --json` once, then navigate by breadcrumbs",
      ],
      handler: async (): Promise<CommandResult> => {
        const specs = getAll();
        const data = {
          cli: "thicket",
          version: VERSION,
          global_flags: GLOBAL_FLAGS.map((f) => ({
            flag: f.flag,
            description: f.description,
          })),
          commands: specs.map(catalogEntry),
        };
        const byCategory = new Map<string, CommandSpec[]>();
        for (const spec of specs) {
          const list = byCategory.get(spec.category) ?? [];
          list.push(spec);
          byCategory.set(spec.category, list);
        }
        const human: string[] = [];
        for (const [category, list] of byCategory) {
          human.push(pc.bold(category));
          human.push(
            ...table(
              ["", ""],
              list.map((s) => [`  thicket ${s.path.join(" ")}`, s.summary]),
            ).slice(1),
          );
          human.push("");
        }
        human.push(pc.dim("Full detail: thicket commands --json, or --agent --help on any command"));
        return {
          data,
          summary: `${specs.length} commands`,
          human,
        };
      },
    },
    {
      path: ["skill"],
      category: CATEGORY,
      summary: "Print an agent skill this package ships (default: thicket-cli)",
      args: [{ name: "name", description: `Which skill: ${packagedSkills().join(" or ")}` }],
      notes: ["Install them for Claude Code with: thicket skill install (or thicket setup claude)"],
      handler: async (_ctx, args): Promise<CommandResult> => {
        const name = args[0] ?? "thicket-cli";
        if (!packagedSkills().includes(name)) {
          throw new CliError("usage", `No packaged skill named "${name}"`, `One of: ${packagedSkills().join(", ")}`);
        }
        const text = readFileSync(skillSourcePath(name), "utf8");
        return {
          data: { name, skill: text },
          human: [text],
        };
      },
    },
    {
      path: ["skill", "install"],
      category: CATEGORY,
      summary: "Install the packaged skills for Claude Code (~/.claude/skills/<name>)",
      flags: [
        {
          flag: "--dir <path>",
          description: "Skills directory (default: ~/.claude/skills)",
        },
        { flag: "--only <name>", description: "Install just one skill (thicket-cli or thicket-connect)" },
      ],
      handler: async (_ctx, _args, options): Promise<CommandResult> => {
        const dir = options.dir ? String(options.dir) : join(homedir(), ".claude", "skills");
        const installed = installSkills(dir, options.only ? [String(options.only)] : undefined);
        if (installed.length === 0) {
          throw new CliError("usage", `No packaged skill named "${String(options.only)}"`, `One of: ${packagedSkills().join(", ")}`);
        }
        return {
          data: { installed },
          summary: `Installed ${installed.map((i) => i.name).join(", ")} under ${dir}`,
          human: [
            ...installed.map((i) => `${pc.green("Installed.")} ${i.path}`),
            "Claude Code picks them up automatically; other agents can be pointed at the files.",
            pc.dim("For the plugin (SessionStart status hook), run: thicket setup claude"),
          ],
        };
      },
    },
  ];
}
