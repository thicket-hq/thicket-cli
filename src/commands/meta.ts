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

function skillSourcePath(): string {
  // dist/commands/meta.js → ../../skills/thicket-cli/SKILL.md (also correct
  // from src/ in dev).
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "skills", "thicket-cli", "SKILL.md");
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
      summary: "Print the agent skill that teaches this CLI",
      notes: ["Install it for Claude Code with: thicket skill install"],
      handler: async (): Promise<CommandResult> => {
        const text = readFileSync(skillSourcePath(), "utf8");
        return {
          data: { skill: text },
          human: [text],
        };
      },
    },
    {
      path: ["skill", "install"],
      category: CATEGORY,
      summary: "Install the agent skill for Claude Code (~/.claude/skills)",
      flags: [
        {
          flag: "--dir <path>",
          description: "Install somewhere else (default: ~/.claude/skills/thicket-cli)",
        },
      ],
      handler: async (_ctx, _args, options): Promise<CommandResult> => {
        let text: string;
        try {
          text = readFileSync(skillSourcePath(), "utf8");
        } catch {
          throw new CliError("api", "The packaged skill file is missing from this install");
        }
        const dir = options.dir
          ? String(options.dir)
          : join(homedir(), ".claude", "skills", "thicket-cli");
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, "SKILL.md");
        writeFileSync(dest, text);
        return {
          data: { installed: dest },
          summary: `Skill installed at ${dest}`,
          human: [
            `${pc.green("Installed.")} ${dest}`,
            "Claude Code picks it up automatically; other agents can be pointed at the file.",
          ],
        };
      },
    },
  ];
}
