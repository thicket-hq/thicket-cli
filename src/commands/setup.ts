// `thicket setup claude`: install the skills, point Claude Code at the
// plugin (this package is its own marketplace), and say what to run next.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { CliError, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { installSkills, packageRoot, packagedSkills } from "./meta.js";

const run = promisify(execFile);

async function claudeAvailable(): Promise<string | null> {
  try {
    const { stdout } = await run("claude", ["--version"], { timeout: 5000 });
    return stdout.trim() || "claude";
  } catch {
    return null;
  }
}

async function setupClaude(
  _ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const skillsDir = options.dir ? String(options.dir) : join(homedir(), ".claude", "skills");
  const installed = installSkills(skillsDir);
  const root = packageRoot();
  const manifest = join(root, ".claude-plugin", "plugin.json");
  const hooks = join(root, "hooks", "hooks.json");
  const marketplace = join(root, ".claude-plugin", "marketplace.json");
  const pluginOk = existsSync(manifest) && existsSync(hooks) && existsSync(marketplace);
  const claude = await claudeAvailable();
  const commands = [
    "claude plugin marketplace add thicket-hq/thicket-cli",
    "claude plugin install thicket@thicket-hq",
  ];
  let registered: { command: string; ok: boolean; output: string }[] = [];
  if (options.register) {
    if (!claude) throw new CliError("usage", "The claude binary is not on PATH; cannot --register", "Install Claude Code, or run the commands by hand");
    for (const command of commands) {
      const [bin, ...args] = command.split(" ");
      try {
        const { stdout, stderr } = await run(bin, args, { timeout: 120_000 });
        registered.push({ command, ok: true, output: (stdout + stderr).trim() });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        registered.push({ command, ok: false, output: (e.stdout ?? "") + (e.stderr ?? e.message) });
        break;
      }
    }
  }
  const human = [
    `${pc.green("Skills installed.")} ${installed.map((i) => i.path).join(", ")}`,
    pluginOk
      ? `${pc.green("Plugin manifest present.")} ${manifest} (hooks: ${hooks})`
      : pc.yellow(`Plugin manifest missing from this install (${manifest}); the skills still work on their own.`),
    "",
  ];
  if (claude) {
    human.push(`Claude Code detected (${claude}). Register the plugin so the SessionStart status line and both skills load everywhere:`);
    for (const c of commands) human.push(`  ${pc.cyan(c)}`);
    if (registered.length) {
      human.push("");
      for (const r of registered) human.push(`${r.ok ? pc.green("ran ") : pc.red("FAIL")} ${r.command}${r.output ? `\n    ${r.output.split("\n").join("\n    ")}` : ""}`);
    } else {
      human.push(pc.dim("  (or re-run with --register to run them now)"));
    }
  } else {
    human.push(pc.dim("The claude binary is not on PATH; when Claude Code is installed, register the plugin with:"));
    for (const c of commands) human.push(`  ${c}`);
  }
  human.push("", "Other agents: see install.md in the package, or point them at the skill files above.");
  return {
    data: {
      skills: installed,
      plugin: { manifest, hooks, marketplace, present: pluginOk },
      claude: { available: !!claude, version: claude, register_commands: commands, registered },
    },
    summary: `Installed ${installed.length} skill${installed.length === 1 ? "" : "s"}${claude ? "; register the plugin with the printed claude commands" : ""}`,
    human,
  };
}

export const setupCommands: CommandSpec[] = [
  {
    path: ["setup", "claude"],
    category: "Meta",
    summary: "Install the skills for Claude Code and print (or run) the plugin registration",
    flags: [
      { flag: "--dir <path>", description: "Skills directory (default ~/.claude/skills)" },
      { flag: "--register", description: "Run the claude plugin marketplace/install commands now" },
    ],
    notes: [
      `Installs ${packagedSkills().join(" and ")} under ~/.claude/skills; the plugin adds a SessionStart status hook`,
      "Registration: claude plugin marketplace add thicket-hq/thicket-cli, then claude plugin install thicket@thicket-hq",
    ],
    handler: setupClaude,
  },
];
