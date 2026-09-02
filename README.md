# Thicket CLI

`thicket` is the official command-line interface for [Thicket](https://www.thickethq.com). Manage projects, to-dos, messages, docs and files, boards, chat, notifications, and cheers from your terminal or through AI agents, and run the local agent connector that turns an @mention in Thicket into work on your machine.

- Works standalone or with any AI agent that can run shell commands
- JSON envelope with breadcrumbs, `--jq` filtering, structured errors with stable exit codes and a `retryable` flag
- Markdown bodies everywhere, with `@mentions` resolved to people
- Accepts a thickethq.com link anywhere an id is expected
- Browser sign-in that mints a personal access token; no password ever touches the CLI
- Ships two Claude Code skills and a plugin (SessionStart status line); this repo is its own plugin marketplace

## Install

```bash
npm install -g thicket-cli
```

Needs Node 20 or newer. Or run it without installing: `npx thicket-cli` (the binary is `thicket` once installed).

## Quick start

```bash
thicket auth login                 # approve in your browser; token to the OS keyring
thicket projects                   # list projects
thicket todos --in "Website"       # a project's open to-dos
thicket todo "Fix bug" --in Website --list Launch --due friday --assignee me
thicket done <id>                  # complete a to-do (works on cards too)
thicket message "Status" --content "All **green**." --in Website
thicket comment <id> "Done, @Jane"  # comment on anything (Markdown, mentions)
thicket show https://www.thickethq.com/o/acme/projects/<id>/cards/<id>
thicket search "launch checklist"  # search across projects
thicket assignments                # your open work
thicket inbox --unread             # your notifications
```

Bare resource commands list (`thicket projects` = `thicket projects list`); singular commands act (`thicket todo`, `thicket card`, `thicket message`, `thicket done`, `thicket cheer`).

## Output formats

```bash
thicket projects              # styled in a terminal, JSON envelope when piped
thicket projects --json       # {ok, data, summary, breadcrumbs}
thicket projects --quiet      # raw data only
thicket projects --agent      # data-only JSON, structured errors, no prompts
thicket projects --ids-only   # one id per line
thicket projects --count      # integer count
thicket projects --jq '.data[].name'   # filter the envelope with jq (strings print raw)
```

Every success envelope can carry `breadcrumbs`, suggested next commands, so humans and agents can walk the resource graph without prior knowledge. `--jq` runs real jq (jq 1.8 compiled to WebAssembly, no native dependency) over the envelope and implies `--json`; each output is one line, strings raw, everything else compact JSON.

Errors are always structured: `{ok: false, error, code, retryable, hint}` with stable exit codes (usage 2, validation 3, auth 4, forbidden 5, not_found 6, rate_limit 7, network 8, ambiguous 9, plan_limit 10). `retryable` is true for network failures, timeouts, 429 (with `retry_after` seconds when the server said) and 5xx; every other code is a verdict, and repeating the call repeats the answer.

## Authentication

`thicket auth login` opens your browser to approve the device on thickethq.com and mints a [personal access token](https://www.thickethq.com/developers/api) scoped to you. The token lands in the OS keyring (macOS Keychain, Linux Secret Service) with a chmod-600 `~/.config/thicket/credentials.json` fallback.

```bash
thicket auth login               # read-only token (the default)
thicket auth login --scope full  # full read + write
thicket auth status              # who am I, from which store
thicket auth token               # print the token for scripts
thicket auth logout              # remove the stored token from this machine
```

Headless environments: `printf '%s' "$TOKEN" | thicket auth login --with-token`, or set `THICKET_TOKEN` per process. Set `THICKET_TOKEN_STORE=file` to keep stored tokens in the config directory's chmod-600 `credentials.json` instead of the OS keyring (containers, CI, sandboxed runs). Revoke any token from My settings, API tokens; revocation is immediate.

### Profiles and organizations

Named profiles hold separate identities: `thicket -P work ...` or `THICKET_PROFILE=work`. Each profile stores its own token and defaults; an AI agent's token lives in its own profile (`thicket -P clawdito ...`). With several organizations, pass `--org <slug>` or save a default once with `thicket orgs use <slug>`. Precedence everywhere: flags > environment (`THICKET_TOKEN`, `THICKET_ORG`, `THICKET_BASE_URL`, `THICKET_PROFILE`) > profile config > defaults.

## Rich text and mentions

Every body flag and argument takes Markdown and ships HTML (`content_html`, sanitized server-side): `--content` on messages, docs, and cards, `--notes` on to-dos and lists, the text of `thicket comment` and `thicket chat post`. Headings, emphasis, lists, links, code spans and fenced blocks, blockquotes, and GFM tables convert; raw HTML tags are escaped and land as visible text.

Mentions are the one non-Markdown construct:

- `[@Jane Doe](member:<membership id>)` pins a person by membership id (the id `thicket people` lists; `thicket comments thread` prints a paste-ready token per author).
- A bare `@Jane` or `@Jane.Doe` is resolved against `thicket people`: exact name, then `First.Last`, then first name, then a loose match. An ambiguous name is an `ambiguous` error naming the candidates with their tokens; a name that matches nobody stays plain text. Emails are never treated as mentions.

Opt out per call with `--plain` (send plain text; the server paragraphs it) or `--content-html` / `--html` (send raw HTML, the escape hatch). Any body may be `-` to read it from stdin (one per invocation; the trailing newline is trimmed):

```bash
cat report.md | thicket comment <id> -
thicket docs create "Spec" --content - --in Website < spec.md
```

## URLs

Anything that takes a recording id also takes the item's link from the app (`https://www.thickethq.com/o/<org>/projects/<id>/cards/<id>`, and every other shape the app builds). A link names its organization, so it also sets `--org` for that call. `thicket url parse <url>` shows what a link points at (`{org, project_id, recording_id, type, parent_id, comment_id}`), `thicket url of <id>` gives the link (and a titled Markdown link) for an id, and `thicket show` responses carry `web_url`.

## Notifications and cheers

```bash
thicket inbox                              # your tray, newest first (alias of thicket notifications)
thicket notifications --unread --action mentioned,assigned
thicket notifications --since <iso> --after <id>   # cursor reads, oldest first; next_cursor in the response
thicket notifications --watch              # the live stream: one NDJSON row per line
thicket notifications read <id>            # mark read (--all for every row)

thicket cheer <id|url> "On it!"            # a short reaction (16 chars); --event <id> cheers a change-log row
thicket cheers --since <iso>               # cheers you received and gave
thicket cheers on <id|url>                 # the cheers on a recording
thicket subscriptions show|add|remove <id|url>   # follow a thread, watch a column, ring the chat bell
```

Notification rows carry `actor_membership_id`, `actor_role`, `actor_kind`, and for agent recipients the server's trust verdicts `from_operator` and `directive`. `--watch` consumes the Server-Sent Events stream, ignores pings, reconnects with backoff on `event: reconnect` or a dropped connection using the last cursor, falls back to polling (with `presence=true`) when the stream is not offered, and stops cleanly on Ctrl-C. `thicket comments thread <id|url>` prints a whole thread (the recording's text plus every comment, oldest first) with each author's membership id and mention token.

## People and AI agents

```bash
thicket people                     # membership ids, kind (person or agent), presence
thicket people --agents
thicket agents                     # agents with operators, policy, token summary
thicket agents create "Clawdito" --operator me
thicket agents operators Clawdito jane@acme.com --add
thicket agents update Clawdito --directable-by members
thicket agents token Clawdito      # explains where tokens are minted (web app: Admin, AI agents)
thicket agents deactivate|reactivate Clawdito
```

An agent is a member without a seat or a sign-in: mention it, assign it, cheer it like a person. It acts only on directives from whoever may direct it (its operators by default, or any non-client member). Token minting needs a signed-in browser session, so `thicket agents token` prints the admin URL unless the API call succeeds; store the minted token in a profile: `printf '%s' "$TOKEN" | thicket -P clawdito auth login --with-token`.

## The local connector: `thicket agent watch`

The agent connects out; Thicket never calls in. There is no endpoint to expose, no webhook to register, nothing to tear down when the process dies.

```bash
thicket -P clawdito agent watch --project "Website" --project "Mobile"
thicket -P clawdito agent watch --trust allowlist --allow <membership-id>
thicket -P clawdito agent watch --since 2026-09-01T10:00:00Z --after <notification-id>
thicket agent watch --status       # what is running on this machine
```

It runs under the agent's own token, reads the agent's inbox (the SSE stream, or polling with presence when the stream is unavailable), and for every row: dedupes by id, corroborates the claim against the API (a mention: the re-fetched recording or one of its comments lists the agent in `mentioned_membership_ids` and was written by the row's actor; an assignment: the agent is among `assignee_ids`; a followed-thread comment: the agent's subscription; a cheer: the agent's received-cheers feed), applies the trust mode, acks directives with a cheer, and prints one JSON object per line to stdout. Diagnostics go to stderr. Rate limits back off on `Retry-After`. Presence is renewed by the stream, or by `presence=true` on every poll.

| Flag | Meaning | Default |
|---|---|---|
| `--agent <name-or-id>` | The agent this token must belong to | the signed-in agent |
| `--project <project>` | Only these projects (repeatable; name or id) | all |
| `--trust <mode>` | `operator`: the server's `directive`/`from_operator` verdicts only; `allowlist`: those plus `--allow` ids; `members`: any non-client member | `operator` |
| `--allow <membership-id>` | Who may direct the agent under `allowlist` (repeatable) | |
| `--since <iso>`, `--after <id>` | Resume cursor | now (history is never replayed) |
| `--poll <seconds>` | Poll interval when the stream is unavailable | 10 |
| `--no-cheers` | Skip the received-cheers trigger (otherwise polled every 60s) | polling on |
| `--ack <text>`, `--no-ack` | Cheer each directive with this the moment it is emitted | `On it!` |
| `--status` | List running watches (from `~/.config/thicket/runs/<pid>.json`) | |
| `--allow-duplicate` | Start beside a watch that already covers this agent and projects | refused |

Each line:

```json
{"event_id":"…","kind":"mentioned","created_at":"…",
 "actor":{"membership_id":"…","name":"Jane Doe","role":"owner","kind":"person"},
 "recording":{"id":"…","type":"card","title":"Fix the date picker","project_id":"…","parent_id":"…","web_url":"https://www.thickethq.com/o/acme/projects/…/cards/…","text":"…"},
 "comment":{"id":"…","created_at":"…","text":"@Clawdito ship it","web_url":"…#comment-…"},
 "cheer":null,
 "instruction":"@Clawdito ship it",
 "trigger":{"directive":true,"from_operator":true,"mentioned":true,"assigned":false,"subscribed":false},
 "ack":{"ok":true,"cheer_id":"…","error":null},
 "cursor":{"since":"…","after":"…"}}
```

`kind` is one of `mentioned`, `assigned`, `commented`, `cheered`, `card_added`, `todo_added`, `chatted`; only the first two are directives. `recording` is what to reply on (`thicket comment <recording.id> ...`); `comment` is the comment or chat line that carried the trigger, when one did; `instruction` is the text to act on. The agent's own activity and client authors never trigger, in every trust mode. The `/thicket-connect` skill (below) is the driver that turns these lines into background work and replies as the agent.

## AI agent integration

`thicket` works with any agent that can run shell commands.

- **Claude Code**: `thicket setup claude` installs both skills (`thicket-cli`, `thicket-connect`) under `~/.claude/skills` and prints the plugin registration; the plugin adds a SessionStart hook (`thicket agent-hook session-start`) that tells Claude who is signed in. This repo is its own marketplace: `claude plugin marketplace add thicket-hq/thicket-cli` then `claude plugin install thicket@thicket-hq`.
- **Other agents**: [install.md](install.md) covers Cursor, Codex, and anything else; `thicket skill` prints a skill, `thicket skill install` copies them.
- **Discovery**: `thicket commands --json` returns the full catalog; every command supports `--agent --help` for structured JSON help.
- **Raw API**: `thicket api GET my/notifications` calls any route in the envelope (org-relative paths by default; `/authorization` for `/api/v1`-relative). Agents working from the raw API instead should read https://www.thickethq.com/thicket-SKILL.md and https://www.thickethq.com/openapi.json.

## Configuration

```
~/.config/thicket/config.json        # profiles: default org, host
~/.config/thicket/credentials.json   # token fallback when no OS keyring (0600)
~/.config/thicket/runs/<pid>.json    # live agent watches (removed on exit)
~/.config/thicket/project_repos.toml # project -> local repo, read by the /thicket-connect skill
```

`thicket doctor` checks node, token, API reachability, org resolution, and who you are (`--json` adds `whoami` with `membership_kind`).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The CLI is a thin presentation layer over [`thicket-sdk`](https://github.com/thicket-hq/thicket-sdk); transport, retries, and pagination live there. Endpoints the published SDK does not wrap yet are called through its `request` escape hatch. Conventions for contributors and agents: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
