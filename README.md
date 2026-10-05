# Thicket CLI

`thicket` is the official command-line interface for [Thicket](https://www.thickethq.com). Manage projects, to-dos, messages, docs and files, boards, chat, timesheets, notifications, and cheers from your terminal or through AI agents.

- Works standalone or with any AI agent that can run shell commands
- JSON envelope with breadcrumbs, `--jq` filtering, structured errors with stable exit codes and a `retryable` flag
- Markdown bodies everywhere, with `@mentions` resolved to people
- Accepts a thickethq.com link anywhere an id is expected
- OAuth browser approval with automatic refresh; connections use your existing account permissions
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
thicket timesheet log <id> --hours 1.5   # log time on a to-do (or any item)
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

Errors are always structured: `{ok: false, error, code, retryable, hint, api_code}` with stable exit codes (usage 2, validation 3, auth 4, forbidden 5, not_found 6, rate_limit 7, network 8, ambiguous 9, plan_limit 10). `retryable` is true for network failures, timeouts, 429 (with `retry_after` seconds when the server said) and 5xx; every other code is a verdict, and repeating the call repeats the answer. `api_code` is the server's own code when it sent one, for branching on a specific refusal (`daily_cap`, `approvals_off`, `week_state`).

## Authentication

`thicket auth login` opens Thicket in your browser to review and approve access. OAuth credentials are stored in the system keyring (macOS Keychain or Linux Secret Service), with a private credentials-file fallback. Access tokens refresh automatically, including when multiple CLI processes share the connection.

```sh
thicket auth login               # approve read-and-write access
thicket auth login --scope read  # request read-only access
thicket auth status              # check identity, access, and organizations
thicket auth token               # print the current access token for a script
thicket auth logout              # disconnect OAuth and remove saved credentials
```

Review and disconnect browser connections in **My settings > Connected apps**. Changes appear under your name and follow your current project permissions.

Headless automation can use a personal token: `printf '%s' "$THICKET_TOKEN" | thicket auth login --with-token`, or set `THICKET_TOKEN` per process. `THICKET_TOKEN_STORE=file` uses the private credentials file instead of the system keyring. Revoke personal tokens separately in **My settings > API tokens**; signing out only removes those tokens locally.

Existing personal tokens from older CLI versions keep working. Update the CLI and run `thicket auth login` to switch to OAuth, then revoke the old personal token when it is no longer needed.

Named profiles hold separate connections: `thicket -P work ...` or `THICKET_PROFILE=work`. Each OAuth connection is bound to the host where it was approved. With several organizations, pass `--org <slug>` or save a default with `thicket orgs use <slug>`.

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

Anything that takes a recording id also takes the item's link from the app (`https://www.thickethq.com/o/<org>/projects/<id>/cards/<id>`, and every other shape the app builds). A link names its organization, so it also sets `--org` for that call. `thicket url parse <url>` shows what a link points at (`{org, project_id, recording_id, type, parent_id, comment_id, occurrence}`; `occurrence` is a repeating event's day from `?occurrence=`), `thicket url of <id>` gives the link (and a titled Markdown link) for an id, and `thicket show` responses carry `web_url`.

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

## Timesheets

```bash
thicket timesheet                          # your week: hours per row and day, the total, the approval status
thicket timesheet log <id|url> --hours 1.5 # time on a to-do, message, doc, file, card or event (today by default)
thicket timesheet log <event-url> --occurrence 2026-09-22 --hours 1   # one day of a repeating event
thicket timesheet log --project Website --hours 0.5 --date yesterday --notes "Planning"
thicket timesheet log --absence Vacation --hours 8 --date 2026-10-02
thicket timesheet edit <entry-id> --hours 1:45        # also --date, --notes ("" clears), --person
thicket timesheet delete <entry-id> --yes             # permanent: an entry has no trash
thicket timesheet report --from 2026-09-01 --to 2026-09-30 --project Website
thicket timesheet report --csv > timesheet.csv        # the export itself (default range: the last month)
thicket timesheet absence-types                       # Vacation, Sick leave, ... (--all adds archived ones)

thicket timesheet submit --week 2026-09-24            # submit the week holding that day for approval
thicket timesheet approvals                           # owners and admins: the week, and every week waiting on you
thicket timesheet approve <person> <week-start>
thicket timesheet reject <person> <week-start> --reason "Tuesday is missing the client call"
```

Hours are `1.5` or `1:30`, and nobody logs more than 24 hours on one day (the refusal carries `api_code: daily_cap`). Owners and admins log, edit, and submit for someone else with `--person`. A project's Timesheet has to be switched on in its settings, and timesheets are team only: clients get `not_found` from every one of these commands. `--csv` prints the report's export itself (`Date,Person,Hours,Project,Item,Notes,Created`, plus `Status` while approvals are on) in every output mode, with no envelope around it; errors stay structured on stderr.

Approvals are an admin setting, off by default. While they are on, `submit` records a week, and an owner or admin approves it or rejects it with a reason that reaches the person. Nothing ever locks: a change after submitting or approving reads Changed until the week is resubmitted or approved again, and the report shows approved hours unless `--status` says otherwise.

## People

```sh
thicket people
thicket people list
```

Membership ids identify assignees and mentions. Your coding agent operates through your own connection. Dedicated agent creation and background mention watchers are retired; older command spellings return a connection hint.

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
