# Thicket CLI

`thicket` is the official command-line interface for [Thicket](https://www.thickethq.com). Manage projects, to-dos, messages, docs and files, boards, and chat from your terminal or through AI agents.

- Works standalone or with any AI agent that can run shell commands
- JSON output with breadcrumbs for easy navigation
- Browser sign-in that mints a personal access token; no password ever touches the CLI
- Ships an installable agent skill for Claude Code

## Install

```bash
npm install -g thicket-cli
```

Or run it without installing: `npx thicket-cli` (the binary is `thicket` once installed).

## Quick start

```bash
thicket auth login                 # approve in your browser; token to the OS keyring
thicket projects                   # list projects
thicket todos --in "Website"       # a project's open to-dos
thicket todo "Fix bug" --in Website --list Launch --due friday --assignee me
thicket done <id>                  # complete a to-do (works on cards too)
thicket message "Status" --content "All green." --in Website
thicket comment <id> "Done!"       # comment on anything
thicket search "launch checklist"  # search across projects
thicket assignments                # your open work
```

Bare resource commands list (`thicket projects` = `thicket projects list`); singular commands act (`thicket todo`, `thicket card`, `thicket message`, `thicket done`).

## Output formats

```bash
thicket projects              # styled in a terminal, JSON envelope when piped
thicket projects --json       # {ok, data, summary, breadcrumbs}
thicket projects --quiet      # raw data only
thicket projects --agent      # data-only JSON, structured errors, no prompts
thicket projects --ids-only   # one id per line
thicket projects --count      # integer count
```

Every success envelope can carry `breadcrumbs`, suggested next commands, so humans and agents can walk the resource graph without prior knowledge. Errors are always structured: `{ok: false, error, code, hint}` with stable exit codes (usage 2, validation 3, auth 4, forbidden 5, not_found 6, rate_limit 7, network 8, ambiguous 9, plan_limit 10).

## Authentication

`thicket auth login` opens your browser to approve the device on thickethq.com and mints a [personal access token](https://www.thickethq.com/developers/api) scoped to you. The token lands in the OS keyring (macOS Keychain, Linux Secret Service) with a chmod-600 `~/.config/thicket/credentials.json` fallback.

```bash
thicket auth login               # read-only token (the default)
thicket auth login --scope full  # full read + write
thicket auth status              # who am I, from which store
thicket auth token               # print the token for scripts
thicket auth logout              # remove the stored token from this machine
```

Headless environments: `printf '%s' "$TOKEN" | thicket auth login --with-token`, or set `THICKET_TOKEN` per process. Revoke any token from My settings, API tokens; revocation is immediate.

### Profiles and organizations

Named profiles hold separate identities: `thicket -P work ...` or `THICKET_PROFILE=work`. Each profile stores its own token and defaults. With several organizations, pass `--org <slug>` or save a default once with `thicket orgs use <slug>`. Precedence everywhere: flags > environment (`THICKET_TOKEN`, `THICKET_ORG`, `THICKET_BASE_URL`, `THICKET_PROFILE`) > profile config > defaults.

## AI agent integration

`thicket` works with any agent that can run shell commands.

- **Claude Code**: `thicket skill install` drops the skill into `~/.claude/skills/thicket-cli`.
- **Other agents**: point them at [`skills/thicket-cli/SKILL.md`](skills/thicket-cli/SKILL.md), or `thicket skill` prints it.
- **Discovery**: `thicket commands --json` returns the full catalog; every command supports `--agent --help` for structured JSON help.

Agents working from the raw API instead should read https://www.thickethq.com/thicket-SKILL.md and https://www.thickethq.com/openapi.json.

## Configuration

```
~/.config/thicket/config.json        # profiles: default org, host
~/.config/thicket/credentials.json   # token fallback when no OS keyring (0600)
```

`thicket doctor` checks node, token, API reachability, and org resolution.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The CLI is a thin presentation layer over [`thicket-sdk`](https://github.com/thicket-hq/thicket-sdk); transport, retries, and pagination live there.

## License

[MIT](LICENSE)
