# Installing the Thicket CLI for AI agents

The CLI itself: `npm install -g thicket-cli` (Node 20+), then `thicket auth login` (OAuth browser approval; read-and-write access is shown before approval, or use `--scope read`). Everything below teaches an agent to use it.

Two skills ship in the package under `skills/`:

- `thicket-cli`: how to drive Thicket through the CLI (catalog, envelope, Markdown bodies, mentions, URLs, errors).
- `thicket-connect`: connect a named agent to a running Claude Code session, handle its requests, and reply as the agent.

## Claude Code

Recommended, the plugin (skills plus a SessionStart status hook):

```bash
thicket setup claude                 # installs both skills under ~/.claude/skills and prints the next two lines
claude plugin marketplace add thicket-hq/thicket-cli
claude plugin install thicket@thicket-hq
```

`thicket setup claude --register` runs the two `claude plugin` commands for you when the `claude` binary is on PATH. The plugin's `hooks/hooks.json` runs `thicket agent-hook session-start` at every session start, which prints one line: who is signed in and in which organizations, or how to sign in.

Skills only, no plugin:

```bash
thicket skill install                # ~/.claude/skills/thicket-cli and ~/.claude/skills/thicket-connect
thicket skill install --dir .claude/skills   # project-level instead
```

## Cursor

Cursor reads rules from `.cursor/rules/`. Save the skill as a rule:

```bash
mkdir -p .cursor/rules
thicket skill --quiet | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).skill))' > .cursor/rules/thicket.mdc
```

Or copy `skills/thicket-cli/SKILL.md` from the package (`npm root -g`/thicket-cli/skills) into `.cursor/rules/thicket.mdc` and add the frontmatter Cursor expects (`alwaysApply: false`, a description). The CLI skill covers project work and personal OAuth. The named-agent connection skill requires Claude Code background tasks and Monitor.

## Codex

Codex reads `AGENTS.md`. Add a section that points at the skill:

```markdown
## Thicket
Use the `thicket` CLI (run `thicket commands --json` for the catalog, `--agent --help` on any command).
Follow the invariants in skills/thicket-cli/SKILL.md from the thicket-cli npm package.
```

Copy the skill file next to it if you want the rules inline.

## Any other agent

- `thicket commands --json` is the machine-readable catalog; `thicket <command> --agent --help` is structured help for one command.
- `thicket skill` prints the `thicket-cli` skill; `thicket skill thicket-connect` prints the connection guide.
- Every command takes `--json` (envelope with breadcrumbs) or `--agent` (data only, no prompts), and `--jq <filter>`.
- Errors are `{ok: false, error, code, retryable, hint}` with stable exit codes.

## Connection management

Browser connections appear in My settings, Connected apps. The CLI refreshes credentials automatically. Use `thicket auth logout` to disconnect. A personal access token remains an option for scripts without a browser; revoke it separately under API tokens.

For a named agent, add it in **People > Agents** and invoke `/thicket-connect` in Claude Code. Browser pairing uses `thicket auth agent connect --profile <agent-name>`. Keep the session running; manage its projects, operators and installations in People, Agents.
