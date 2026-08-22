---
name: thicket-cli
description: |
  Work in Thicket (thickethq.com) through the `thicket` CLI: projects,
  to-dos, messages, docs and files, boards, chat, search, and reports.
  Prefer this over raw API calls whenever the CLI is installed.
triggers:
  - thicket
  - /thicket
  - thickethq.com
  - my thicket to-dos
  - post to the message board
  - move the card
invocable: true
argument-hint: "[command] [args...]"
---

# /thicket-cli - Thicket CLI Skill

`thicket` is the official Thicket CLI. It works standalone or driven by an
agent: every command takes `--json` (envelope with `data`, `summary`, and
`breadcrumbs` suggesting next commands) and `--agent` (data-only JSON, no
prompts). Full API reference: https://www.thickethq.com/developers/api

## Agent invariants (MUST follow)

1. **Discover, don't guess.** `thicket commands --json` returns the whole
   catalog. Any command supports `--agent --help` for structured help
   (flags, args, notes). Walk breadcrumbs in `--json` responses.
2. **Check auth first.** `thicket auth status --json` says who is signed
   in and which organizations are reachable. If it fails, ask the user to
   run `thicket auth login` (a browser approval; NEVER ask for a password).
   A `read`-scope token cannot write; the fix is
   `thicket auth login --scope full`, again the user's call.
3. **Scope to a project with `--in`.** Content commands (todos, messages,
   docs, files, cards, chat) need `--in <project>`; names are matched
   fuzzily, ids are exact. With several organizations, add `--org <slug>`
   or set a default once: `thicket orgs use <slug>`.
4. **Everything is a recording.** `thicket show <id>` reads anything;
   `thicket comment <id> "text"` comments on anything (comments are flat,
   always on the parent, never on a comment); `thicket trash|archive|restore
   <id>` is the one lifecycle. Trash is what "delete" means: recoverable
   for 30 days. Nothing in this CLI hard-deletes.
5. **Errors are structured.** `{ok: false, error, code, hint}` with stable
   exit codes: usage 2, validation 3, auth 4, forbidden 5, not_found 6,
   rate_limit 7, network 8, ambiguous 9, plan_limit 10. On `ambiguous`,
   re-run with the exact name or id from the message. On `rate_limit`,
   wait and retry. On `plan_limit`, stop and tell the user.
6. **Writes are attributed to the signed-in user.** Act only as instructed;
   before destructive bulk work, list first and confirm with your user.

## Quick reference

```sh
thicket auth login [--scope read|full]   # browser approval; token to OS keyring
thicket auth status                      # who am I, which orgs
thicket orgs use acme                    # default organization

thicket projects                         # list projects
thicket projects show "Website"          # detail + tools
thicket todos --in "Website"             # open to-dos
thicket todo "Ship it" --in Website --list Launch --due friday --assignee me
thicket done <id>                        # complete (works on cards too)
thicket assign <id> me jane@acme.com     # replace assignees (--add / --remove / --none)

thicket messages --in Website            # message board
thicket message "Status" --content "All green." --in Website
thicket comments <id>                    # read a thread
thicket comment <id> "Done!"             # reply

thicket docs --in Website                # docs list
thicket files upload ./spec.pdf --in Website
thicket files download <id> -o spec.pdf

thicket cards columns --in Website       # board columns
thicket card "New idea" --in Website --column Triage
thicket cards move <id> --to "In progress"

thicket chat post "Standup in 5" --in Website
thicket search "launch checklist"        # cross-project search
thicket assignments                      # my open work (--due overdue)
thicket reports overdue                  # everyone's late work
thicket reports upcoming --from today --to +14
thicket activity --project Website       # what happened
```

## Dates and people

Date flags accept natural language: `today`, `tomorrow`, `friday`,
`next monday`, `+3`, `in 2 weeks`, `eow`, `eom`, or `YYYY-MM-DD`.
People flags accept `me`, a name (fuzzy), an email, or a membership id.

## Output modes

| Flag | Behavior |
|---|---|
| (none) | styled for a terminal, JSON envelope when piped |
| `--json` | `{ok, data, summary, breadcrumbs}` |
| `--quiet` | raw `data` only |
| `--agent` | data-only JSON, structured errors, no prompts |
| `--ids-only` | one id per line |
| `--count` | integer count |
