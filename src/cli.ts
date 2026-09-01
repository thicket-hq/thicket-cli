// Assembles the commander program from the declarative registry and runs
// one invocation. Kept separate from the bin entry so tests can drive it
// with injected env/fetch/streams.
import "./lib/color-init.js";
import { Command, CommanderError } from "commander";
import { agentCommands } from "./commands/agent.js";
import { apiCommands } from "./commands/api.js";
import { authCommands } from "./commands/auth.js";
import { cardCommands } from "./commands/cards.js";
import { chatCommands } from "./commands/chat.js";
import { cheerCommands } from "./commands/cheers.js";
import { fileCommands } from "./commands/files.js";
import { messageCommands } from "./commands/messages.js";
import { metaCommands } from "./commands/meta.js";
import { notificationCommands } from "./commands/notifications.js";
import { peopleCommands } from "./commands/people.js";
import { projectCommands } from "./commands/projects.js";
import { recordingCommands } from "./commands/recordings.js";
import { searchCommands } from "./commands/search.js";
import { setupCommands } from "./commands/setup.js";
import { subscriptionCommands } from "./commands/subscriptions.js";
import { todoCommands } from "./commands/todos.js";
import { urlCommands } from "./commands/url.js";
import { CliContext, VERSION } from "./lib/context.js";
import {
  renderError,
  renderSuccess,
  toCliError,
  CliError,
  type OutputMode,
  type RenderTarget,
} from "./lib/output.js";
import {
  catalogEntry,
  GLOBAL_FLAGS,
  type CommandSpec,
} from "./lib/registry.js";

export function allCommands(): CommandSpec[] {
  const base: CommandSpec[] = [
    ...authCommands,
    ...projectCommands,
    ...todoCommands,
    ...messageCommands,
    ...fileCommands,
    ...cardCommands,
    ...chatCommands,
    ...searchCommands,
    ...recordingCommands,
    ...notificationCommands,
    ...cheerCommands,
    ...subscriptionCommands,
    ...peopleCommands,
    ...agentCommands,
    ...urlCommands,
    ...apiCommands,
    ...setupCommands,
  ];
  return [...base, ...metaCommands(allCommands)];
}

export type RunOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  isTty?: boolean;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
};

function jqFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf("--jq");
  if (i !== -1) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith("--jq="));
  return inline ? inline.slice("--jq=".length) : undefined;
}

/**
 * `thicket agent watch --agent <name>` reuses the global --agent word with a
 * value. Commander would let the root boolean win and drop the value, so
 * the pair is lifted out of argv here and handed to the handler directly.
 */
function liftWatchAgent(argv: string[]): { argv: string[]; agentRef?: string } {
  const words = argv.filter((a) => !a.startsWith("-"));
  if (words[0] !== "agent" || words[1] !== "watch") return { argv };
  const out: string[] = [];
  let agentRef: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--agent=")) {
      agentRef = arg.slice("--agent=".length);
      continue;
    }
    if (arg === "--agent" && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) {
      agentRef = argv[i + 1];
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return { argv: out, agentRef };
}

function modeFromArgv(argv: string[]): OutputMode {
  if (jqFromArgv(argv) !== undefined) return "json";
  if (argv.includes("--agent")) return "agent";
  if (argv.includes("--ids-only")) return "ids";
  if (argv.includes("--count")) return "count";
  if (argv.includes("--quiet") || argv.includes("-q")) return "quiet";
  if (argv.includes("--json") || argv.includes("-j")) return "json";
  return "auto";
}

/** `--agent --help`: structured JSON help for the matched command. */
function agentHelp(
  argv: string[],
  specs: CommandSpec[],
  target: RenderTarget,
): boolean {
  if (!argv.includes("--agent")) return false;
  if (!argv.includes("--help") && !argv.includes("-h")) return false;
  const words = argv.filter((a) => !a.startsWith("-"));
  let best: CommandSpec | null = null;
  for (const spec of specs) {
    if (
      spec.path.length <= words.length &&
      spec.path.every((seg, i) => words[i] === seg) &&
      (best === null || spec.path.length > best.path.length)
    ) {
      best = spec;
    }
  }
  const payload = best
    ? {
        ...catalogEntry(best),
        global_flags: GLOBAL_FLAGS.map((f) => ({
          flag: f.flag,
          description: f.description,
        })),
      }
    : {
        cli: "thicket",
        version: VERSION,
        commands: specs.map(catalogEntry),
      };
  target.write(JSON.stringify(payload, null, 2));
  return true;
}

export async function run(
  rawArgv: string[],
  options: RunOptions = {},
): Promise<number> {
  const specs = allCommands();
  const lifted = liftWatchAgent(rawArgv);
  const argv = lifted.argv;
  const mode = modeFromArgv(argv);
  const target: RenderTarget = {
    mode,
    isTty: options.isTty ?? process.stdout.isTTY === true,
    write: options.write ?? ((line) => process.stdout.write(`${line}\n`)),
    writeErr: options.writeErr ?? ((line) => process.stderr.write(`${line}\n`)),
    jq: jqFromArgv(argv),
  };

  if (agentHelp(argv, specs, target)) return 0;

  const program = new Command("thicket");
  program
    .description("The official Thicket CLI: thickethq.com from your terminal, for humans and agents")
    .version(VERSION, "-V, --version")
    .option("--org <slug>", "Organization to act in")
    .option("-P, --profile <name>", "Named profile")
    .option("-j, --json", "JSON envelope output")
    .option("-q, --quiet", "Raw data only")
    .option("--agent", "Agent mode: data-only JSON, no prompts")
    .option("--ids-only", "One id per line")
    .option("--count", "Item count only")
    .option("--jq <filter>", "Filter the JSON envelope with jq (implies --json)")
    .option("--base-url <url>", "API host override")
    .option("--no-color", "Disable ANSI colors")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => target.write(str.replace(/\n$/, "")),
      // Swallow commander's raw error lines: every failure is rendered once,
      // in the house format, by the CommanderError catch below.
      writeErr: () => {},
    });
  program.addHelpText(
    "after",
    "\nDiscovery: thicket commands (catalog), thicket commands --json (machine-readable),\n  --agent --help on any command (structured help). Docs: https://www.thickethq.com/developers/api",
  );

  let exitCode = 0;

  // Build the command tree from the registry.
  const nodes = new Map<string, Command>();
  nodes.set("", program);
  const ensureParent = (path: string[]): Command => {
    const key = path.join(" ");
    const existing = nodes.get(key);
    if (existing) return existing;
    const parent = ensureParent(path.slice(0, -1));
    const cmd = parent
      .command(path[path.length - 1])
      .exitOverride()
      .configureOutput({
        writeOut: (str) => target.write(str.replace(/\n$/, "")),
        writeErr: () => {},
      });
    nodes.set(key, cmd);
    return cmd;
  };

  for (const spec of specs) {
    const cmd = ensureParent(spec.path);
    cmd.summary(spec.summary);
    cmd.description(spec.description ?? spec.summary);
    if (spec.aliases) for (const alias of spec.aliases) cmd.alias(alias);
    for (const arg of spec.args ?? []) {
      const inner = arg.variadic ? `${arg.name}...` : arg.name;
      cmd.argument(arg.required ? `<${inner}>` : `[${inner}]`, arg.description);
    }
    for (const flag of spec.flags ?? []) {
      cmd.option(flag.flag, flag.description, flag.default as string | boolean | undefined);
    }
    cmd.action(async (...invocation: unknown[]) => {
      invocation.pop(); // the Command instance
      invocation.pop(); // leaf options (optsWithGlobals covers them)
      const positionals = invocation
        .flat()
        .filter((v): v is string => typeof v === "string");
      const opts = cmd.optsWithGlobals();
      if (lifted.agentRef !== undefined && spec.path.join(" ") === "agent watch") {
        opts.agent = lifted.agentRef;
      }
      const ctx = new CliContext(
        {
          org: opts.org as string | undefined,
          profile: opts.profile as string | undefined,
          baseUrl: opts.baseUrl as string | undefined,
        },
        options.env,
        options.fetch,
      );
      try {
        const result = await spec.handler(ctx, positionals, opts);
        exitCode = await renderSuccess(result, target);
      } catch (err) {
        exitCode = renderError(toCliError(err), target);
      }
    });
  }

  // Parent commands without their own handler show help when invoked bare.
  for (const [key, cmd] of nodes) {
    if (key === "") continue;
    if (!specs.some((s) => s.path.join(" ") === key)) {
      cmd.action(() => {
        cmd.outputHelp();
        exitCode = 2;
      });
    }
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.help" ||
        err.code === "commander.version"
      ) {
        return 0;
      }
      return renderError(
        new CliError("usage", err.message.replace(/^error: /, ""), "See: thicket commands"),
        target,
      );
    }
    return renderError(toCliError(err), target);
  }
}
