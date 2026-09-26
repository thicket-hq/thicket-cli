# thicket-cli: conventions for contributors and agents

This is the official Thicket CLI (`thicket`), a thin presentation layer over the `thicket-sdk` npm package. These rules hold for humans and for AI agents editing the repo.

## Architecture

- **One declarative registry.** Every command is a `CommandSpec` (`src/lib/registry.ts`) in a `src/commands/*.ts` module, wired in `src/cli.ts`. The commander tree, `thicket commands --json`, and `--agent --help` are all generated from the same specs, so the catalog cannot drift from reality. Never add a command outside the registry.
- **One envelope.** Success is `{ok: true, data, summary?, notice?, breadcrumbs?}`; failure is `{ok: false, error, code, retryable, hint?, retry_after?, api_code?}` with the exit codes in `src/lib/output.ts` (`api_code` is the server's own error code, when it sent one). Handlers return a `CommandResult`; they never print (long-running streams are the exception: they write NDJSON to stdout and return `silent: true`). An export (the timesheet CSV) returns its text as `raw`, which every output mode prints verbatim, with no envelope.
- **Breadcrumbs are the navigation primitive.** Every listing or detail suggests the next commands, so an agent can walk the graph without prior knowledge.
- **Endpoints the published SDK does not wrap yet** go through `org.request(...)` / `sdk.client.request(...)`, never through hand-rolled fetch (except `rawFetch` for streams and multipart).
- **Permanent deletes take `--yes`.** Trash is what delete means everywhere else. A command that destroys for good (`timesheet delete`) refuses without `--yes` before any request, with the confirming command as its hint.
- **Recording references** go through `resolveRecordingRef` (`src/lib/refs.ts`): every id argument accepts an app URL. **Bodies** go through `bodyFields` (`src/lib/markdown.ts`): Markdown to HTML with mentions, `--plain`, `--content-html`, and `-` for stdin via `readBody`.
- **The connector** (`src/lib/connector.ts`, `src/lib/inbox.ts`) corroborates every event against the API before it prints it. Trust decisions live in `trustVerdict`, a pure function with tests.

## Copy rules

- **No em dashes in anything a user reads**: summaries, hints, notices, flag descriptions, notes, README, install.md, the skills. Use commas, colons, or separate sentences. Code comments and commit messages are out of scope.
- Summaries are one line; hints say what to run next.

## Tests and gates

- `npm run typecheck`, `npm test` (vitest, mocked transport; no network, no keyring), `npm run build`. All three before a push; CI runs them again and checks the built binary answers.
- **Skill drift** (`tests/skill-drift.test.ts`): every `thicket ...` command named in code spans or fenced blocks of `skills/**/SKILL.md`, `README.md`, and `install.md` must exist in the registry. Add the command first, then document it.
- New commands need: a spec with `summary`, `args`, `flags`, `notes` where there is a gotcha; a test through `run()` with the fake fetch; a line in the README and the skill where a user would look for it.

## Skills and the plugin

- `skills/thicket-cli/SKILL.md` teaches the CLI; `skills/thicket-connect/SKILL.md` drives `thicket agent watch`. `thicket skill install` and `thicket setup claude` copy them; edit the source here, never an installed copy.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` make this repo a Claude Code plugin and its own marketplace; `hooks/hooks.json` wires `thicket agent-hook session-start`. Bump the version in both manifests with `package.json`.

## Releases

Bump `package.json` (and the plugin manifests), `npm run typecheck && npm test && npm run build`, then `npm publish` from the `codeexplorio` account. Pin new dependencies to exact versions.
