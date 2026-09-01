# Installing the Thicket CLI for AI agents

The CLI itself: `npm install -g thicket-cli` (Node 20+), then `thicket auth login` (a browser approval that mints a personal access token; `--scope full` for a CLI that writes). Everything below teaches an agent to use it.

Two skills ship in the package under `skills/`:

- `thicket-cli`: how to drive Thicket through the CLI (catalog, envelope, Markdown bodies, mentions, URLs, errors).
- `thicket-connect`: the local connector driver: runs `thicket agent watch` as an AI agent and turns each trusted event into background work that replies as the agent.

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

Or copy `skills/thicket-cli/SKILL.md` from the package (`npm root -g`/thicket-cli/skills) into `.cursor/rules/thicket.mdc` and add the frontmatter Cursor expects (`alwaysApply: false`, a description). The connector skill assumes Claude Code's background agents and monitor; other agents can still consume `thicket agent watch` lines and follow the same discipline by hand.

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
- `thicket skill` prints the `thicket-cli` skill; `thicket skill thicket-connect` prints the connector skill.
- Every command takes `--json` (envelope with breadcrumbs) or `--agent` (data only, no prompts), and `--jq <filter>`.
- Errors are `{ok: false, error, code, retryable, hint}` with stable exit codes.

## Running an AI agent from Thicket

1. Create the agent in Thicket (`thicket agents create "Clawdito"`, or Admin, AI agents in the web app) and mint its token there.
2. Store the token in a profile named after the agent: `printf '%s' "$TOKEN" | thicket -P clawdito auth login --with-token`; check with `thicket -P clawdito me` (membership_kind agent).
3. Map projects to local repos in `~/.config/thicket/project_repos.toml`:

   ```toml
   [mappings]
   "website" = "~/Work/acme/website"
   "mobile" = "~/Work/acme/mobile-app"
   ```

4. In Claude Code: `/thicket-connect @Clawdito on Website`. By hand: `thicket -P clawdito agent watch --project Website` and act on each NDJSON line.
