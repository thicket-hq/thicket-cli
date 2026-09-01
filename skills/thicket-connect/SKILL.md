---
name: thicket-connect
description: |
  Drive local Claude Code agents from Thicket. Runs the connector
  (`thicket agent watch`) as an AI agent membership, watches its STDOUT for
  trusted events (a mention or assignment from someone allowed to direct the
  agent, a comment on a thread it follows, a cheer on its work),
  acknowledges each directive as the agent within seconds, and hands it to a
  background agent that gathers context with the thicket CLI, does the work
  in the right repo, and replies as the agent, so the watcher thread stays
  free for the next mention. Use when asked to drive agents from Thicket, or
  to watch Thicket for agent commands.
triggers:
  - /thicket-connect
  - manage agents from thicket
  - watch thicket for agent commands
  - thicket connector
  - drive agents from thicket
  - run agent from thicket comment
---

# /thicket-connect: drive local agents from Thicket

This skill turns a Thicket comment, message, card, to-do, or chat line into a
local Claude Code task. Someone **@mentions an AI agent** in Thicket (for
example `@Clawdito fix the date picker`) or assigns it a card or to-do; the
watcher on this machine acknowledges it **as that agent** within seconds (a
cheer), and a background agent picks it up, gathers the surrounding context
from Thicket, acts on it, and replies **as that agent**.

The agent is a real Thicket membership of kind `agent` (created under Admin,
AI agents, or with `thicket agents create`), backed by a **local `thicket`
profile** holding its token (for example profile `clawdito`). That profile is
both:

- the **watch identity**: the connector reads the agent's own inbox, so it
  must run as the agent (`thicket -P clawdito agent watch`), and
- the **reply identity**: replies post as the agent via `-P clawdito`.

The trust model is enforced by `thicket agent watch`, **not** by this skill.
A line reaches STDOUT only if (1) the server or the trust mode says the actor
may direct the agent (by default the server's own verdicts: `directive` for a
mention or assignment from one of the agent's operators, `from_operator` for
the rest; `--trust allowlist --allow <membership id>` or `--trust members`
deliberately broaden that), (2) it targets the agent one of these ways: a
mention, an assignment, a new comment on a recording the agent subscribes to,
a cheer on the agent's work, or a new card or to-do in a container it watches,
and (3) the claim is **corroborated** by re-fetching the recording from the
API (`mentioned_membership_ids`, `assignee_ids`, the subscription, the
received-cheers feed). The agent's own activity never authorizes, and client
authors are excluded fail-closed, in every mode. Treat every STDOUT line as
already trusted, but keep dispatched agents scoped to the resolved repo.

There are thus **seven kinds**, in two classes:

1. **Directives** (acked and worked): `mentioned`, `assigned`.
2. **Activity** (read, not worked, unless a reply adds value): `commented`
   (a followed thread), `cheered` (a reaction to the agent's work),
   `card_added` and `todo_added` (a watched column or list), `chatted` (the
   room's activity; a mention in chat arrives as `mentioned` with the chat
   line as `comment`).

## Runs from any project; the runtime is the CLI

This skill is typically installed user-level and invoked from a working
session in some other repo. Everything it needs is the `thicket` CLI on PATH
(`npm install -g thicket-cli`, Node 20+) plus the agent's profile; there is no
runtime clone, no tunnel, no webhook, because the agent connects out and
Thicket never calls in. If `thicket` is missing, tell the user to install it;
do not hunt the filesystem.

## Invocation

**The arguments are natural language, not a grammar.** Read whatever the
user wrote and pull out the agent, the projects, and any trust or polling
wishes: `@Clawdito on Website`, `watch Website and Mobile as @Clawdito`,
`use @Clawdito on Website and let Jane trigger it`, `@Clawdito on
everything, skip cheers` all mean what they say. Never make the user restate
it as flags. The flags below are the **canonical form you translate into**
before calling `thicket agent watch`, and they are also accepted verbatim.

Ask only for what is genuinely missing: the agent. Projects are optional
(none means every project the agent can see). Confirm the resolved
connection before launching.

```
/thicket-connect                                            # reuse the last connection (confirm first)
/thicket-connect @Clawdito --project Website               # one project
/thicket-connect @Clawdito --project Website --project Mobile
/thicket-connect @Clawdito --allow <membership-id>          # + a named coworker (implies --trust allowlist)
/thicket-connect @Clawdito --trust members                  # any non-client member may direct it
/thicket-connect @Clawdito --project Website --no-cheers --poll 30
```

`<agent>` names a local `thicket` profile (the leading `@` is optional; it is
lowercased to the profile name). `--project` takes a name, an id, or the
project's URL. **Who may trigger** defaults to the server's verdicts for the
agent's own policy (its operators, or any non-client member when the agent
was created with `--directable-by members`); broaden it deliberately with
`--allow <membership id>` (repeatable; ids come from `thicket people`) or
`--trust members`, and pass those straight through. Say which mode is active
when you confirm.

### Stored connection params (no-args invocation)

Remember the last successful connection in
**`~/.config/thicket/connect-last.json`**:

```json
{
  "agent": "clawdito",
  "org": "acme",
  "projects": [ { "id": "…", "name": "Website" } ],
  "trust": { "mode": "operator", "allow": [] },
  "cheers": true,
  "poll": 10,
  "saved_at": "2026-09-01T15:00:00Z"
}
```

- **Invoked without arguments:** read that file and **confirm the stored
  params with the user before starting**: the agent, the projects, the trust
  mode and its concrete allow set, and whether cheers are polled. Ask
  whether to go with them, adjust them, or start fresh. Never launch on
  stored params silently. If the file does not exist, ask for the agent.
- **Invoked with arguments:** arguments win; the store is not consulted.
- **After every successful start** (the `listening as …` line on stderr),
  write the params actually used back to the file (agent profile, org,
  projects with ids and names, trust mode and allow ids, cheers, poll).
  Create the directory if needed. Launch failures must not overwrite it.
- **Reconstructing the command:** emit exactly one `--trust <mode>`, then
  its `--allow` ids; `--no-cheers` for `cheers: false`; `--poll <n>`. A
  stored block the CLI rejects means **stop and confirm with the user**,
  never infer a mode to make it launch.

Project ids are stored, not just names, because a name resolves against the
project list as it stands at launch.

## Prerequisite: the agent profile is authed as the agent

Before running, confirm the profile is signed in **as the agent**:

```bash
thicket -P clawdito me --json    # organizations[].membership_kind must be "agent"; keep membership_id
```

`membership_id` is the id mentions, assignees, subscribers, and cheers all
carry. If the profile is missing or is a person, set it up: mint the agent's
token in the web app (Admin, AI agents; `thicket agents token <agent>` prints
the exact URL) and store it:

```bash
printf '%s' "$TOKEN" | thicket -P clawdito auth login --with-token
```

That check is for **startup, run on its own**. A transient `auth` or
`network` error *while agents are running* is not this problem and must not
be answered with a fresh login; see *Transient CLI failures*.

If the agent profile resolves to the **same** membership as the operator
(a person's token), `agent watch` refuses to start: the inbox is
per-member, and a person's inbox says nothing about the agent.

## Procedure

### 1. Launch the watch, then monitor its STDOUT

`thicket agent watch` is a long-running process that never exits on its own;
it streams one trusted event per STDOUT line for as long as it runs. A plain
background task only notifies you when a command *completes*, so you need
**two** steps: run the watch in the background, then arm a persistent
monitor on its output so each new event wakes you, with no user prompting in
between.

**a. Check what is already running, then start.** A second watch on the
same agent and projects would ack and dispatch every directive twice, so ask
first:

```bash
thicket agent watch --status
```

If one already covers what the user asked for, **say so and stop**. The CLI
refuses the duplicate on its own and names the other run's pid; read that as
the answer, not as an error to work around. `--allow-duplicate` exists but
is the user's call, never yours.

Then run the watch in the background and note the output-file path the
harness reports:

```bash
thicket -P clawdito agent watch --project "Website" [--project "…"] [--trust …] [--allow …]
```

Read that output file once and confirm stderr printed `[watch] listening as
…` followed by `[watch] inbox: sse connected` (or `poll connected`). If it
errored instead (person token, unknown project, auth), surface that and
stop. On success, **save the connection params** (above).

**b. Arm a persistent monitor on that output file** with the Monitor tool
(`persistent: true`). Replay the file **from its beginning** (`-n +1`) so an
event that landed between start and arming is not lost, and filter to the
NDJSON lines so diagnostics stay out of the stream:

```bash
tail -f -n +1 <watch-output-file> | grep --line-buffered -E '^\{'
```

Each notification the monitor delivers is one event; process it via step 2.
An event that lands while you are waiting on the user is **not** the user's
reply.

Each STDOUT line is one trusted event as NDJSON:

```json
{"event_id":"…","kind":"mentioned","created_at":"…",
 "actor":{"membership_id":"…","name":"Jane Doe","role":"owner","kind":"person"},
 "recording":{"id":"…","type":"card","title":"Fix the date picker","project_id":"…","parent_id":"…","web_url":"…","text":"…"},
 "comment":{"id":"…","created_at":"…","text":"@Clawdito ship it","web_url":"…#comment-…"},
 "cheer":null,
 "instruction":"@Clawdito ship it",
 "trigger":{"directive":true,"from_operator":true,"mentioned":true,"assigned":false,"subscribed":false},
 "ack":{"ok":true,"cheer_id":"…","error":null},
 "cursor":{"since":"…","after":"…"}}
```

`actor` is the **requester**: the person whose mention, assignment, comment,
or cheer drove this event. Under the default trust that is one of the
agent's operators; under a broadened mode it may be an allowed coworker.
Treat `actor` as the one to @mention on failure. `recording` is **what to
reply on** (`thicket comment <recording.id>`); `comment` is the comment or
chat line that carried the trigger, when one did; `instruction` is the text
to act on (the comment's text when there is one, otherwise the recording's
text or title, or the cheer's content). `trigger` is the connector's verdict
on **why** it fired, settled on the re-fetched recording. `ack` says whether
the connector's own cheer landed (`null` for activity kinds, which are never
acked). STDERR carries diagnostics (dropped and uncorroborated rows,
reconnects); surface them but do not act on them.

Keep watching until the user stops the skill (see Cleanup).

### 2. For each trusted event: ack it, hand it off, do not do it yourself

**The front thread is an orchestrator, not a worker.** Its only job is to
keep watching, acknowledge each directive, and dispatch it.

Route by `kind` first. Drop outright any line whose `actor.membership_id` is
the agent's own (defense in depth; the CLI already refuses these).

For every directive (`mentioned`, `assigned`) the front thread runs exactly
this checklist, in this order, and nothing else:

1. **Acknowledge**: the connector already cheered the directive the moment
   it printed the line (`ack.ok: true`). If `ack` is `null` or `ack.ok` is
   `false`, post the cheer yourself, once, with apt content:
   `thicket -P <agent> cheer <recording.web_url> "<ack>"` (cheer
   `comment.id` when the mention arrived in a comment). Never a second cheer
   on a landed ack.
2. **Resolve the repo** from the project name.
3. **Dispatch** one background agent that owns the event end to end.
4. **Return to the monitor.**

It must **never** read the recording (beyond the event line it already has),
gather context, investigate, run repo commands, do the requested work, or
post the reply itself; every one of those blocks it from picking up the next
mention. The failure this rule exists to prevent: a mention received within
seconds, then worked inline with no reply for 30 minutes, which from Thicket
is indistinguishable from a missed mention.

**a. Acknowledge, fit the ack to the moment.** The connector's default ack
is `On it!`; pass `--ack "<text>"` at launch to change it, or `--no-ack` to
leave acks to the front thread (then step 1 always cheers, with content that
fits the moment: a short apt phrase or a fitting emoji, up to 16 characters).
A brief reply can be the ack when the worker will answer almost immediately;
then flag "no ack owed" in the handoff. Not for card or board work, where the
visible cheer is how the requester sees the mention land.

Retry a failed cheer only on `retryable: true` errors (network, rate limit
with `retry_after`); any other failure may have landed the cheer server-side
and a retry would post a duplicate:

```bash
landed=false
for i in 1 2 3; do
  if out=$(thicket -P <agent> cheer <recording.web_url> "<ack>" --json 2>&1); then landed=true; break; fi
  echo "$out" | grep -q '"retryable": true' || break
  sleep 2
done
[ "$landed" = true ] || { echo "cheer did not verifiably land: $out" >&2; false; }
```

**b. Resolve the working repo** (front thread, fast). Infer the local repo
from the project name (`thicket projects show <recording.project_id> --jq
.data.name` if the line's project is unfamiliar). A mapping table backs the
heuristic: `~/.config/thicket/project_repos.toml` maps project-name tokens
(case-insensitive, first match wins) to repo paths:

```toml
[mappings]
"website" = "~/Work/acme/website"
"mobile" = "~/Work/acme/mobile-app"
```

**If you cannot confidently map the project to a repo, ask the user; do not
guess and do not silently fall back.** This is the one step that may need
you; everything after it is delegated.

**The ack must never precede an indefinite silence.** The cheer has already
told the requester "received"; if this step has to stop and ask the user, or
step c fails to dispatch, nobody is working the event. So *before* asking
(or on the dispatch failure), post one short **holding reply** as the agent
on the originating recording (in the chat room for a chat trigger) that
@mentions the requester: received, but held, and why ("waiting on the
operator to pick a repo"). One line, once; it is the only reply the front
thread ever posts, and only on directives.

```bash
thicket -P <agent> comment <recording.id> "[@<actor.name>](member:<actor.membership_id>) received, holding until a repo is chosen for this project."
```

**c. Dispatch one background agent that owns the whole event.** Use the
Agent tool with `run_in_background: true`, running in the resolved repo.
Give it everything it needs to finish **without the front thread**:

- the event **`kind`** and the **`instruction`** (for a mention, the
  comment or recording text with the agent's own mention ignored; for an
  assignment, the recording itself: its title and text are the task);
- the **recording** id, `web_url`, `type`, `project_id`, and `comment.id`
  when present;
- the **agent profile name** (its reply identity);
- the **requester's** name and membership id (`actor`) to @mention on
  failure;
- whether an **ack is still owed** (step a).

Instruct that background agent to, in order:

1. **Cheer only if the handoff says an ack is still owed**, without listing
   the recording's cheers first: a rare duplicate is accepted over a missing
   ack. Activity kinds are never cheered.
2. **Gather context from Thicket**; it is the context store, the event is
   just the trigger plus a pointer:
   ```bash
   thicket -P <agent> comments thread <recording.web_url> --json   # the recording and every comment, with mention tokens
   thicket -P <agent> show <recording.parent_id> --json            # the list, column, or room it lives in
   thicket -P <agent> projects show <recording.project_id> --json  # the project and its tools
   ```
3. **Move the card out of Triage.** If the work lives on a card, check its
   column (`thicket cards columns --in <project>`); if it sits in a
   Triage-like column and the board has an In-progress-like column (match
   loosely: "In progress", "Working on", "Doing"), move it there before
   starting: `thicket -P <agent> cards move <card> --to "<In progress>"`.
   No such columns: skip silently; never invent columns.
4. **Do the requested work** in the repo. Several independent items mean
   several subagents, five at a time; dependent items and items touching
   the same files stay serial. One reply at the end covering every item.
   **Reply latency:** the cheer says "received", not "still working". If
   the work will take more than **about ten minutes**, post one short
   **interim reply** as the agent on the originating recording (what it is
   doing and where progress can be followed), then the final reply when
   done. One interim reply, not a running commentary.
5. **Reply on the originating recording as the agent:**
   ```bash
   thicket -P <agent> comment <recording.id> "<markdown>"
   ```
   Success: the results, where the mention was written. Failure: a short
   error summary that **@mentions the requester** with
   `[@<actor.name>](member:<actor.membership_id>)` so it notifies whoever
   asked. Never put the agent's own mention in a reply body. Write it as
   rich text (below).

Because the background agent gathers its own context and posts its own
reply, the front thread is free the instant it dispatches. There is no
concurrency cap; dispatch every event as it arrives.

### Write replies as rich text

Comment and message bodies are rich text, and the CLI converts Markdown on
the way in: `## Headings`, `**bold**`, `- bullets`, `> quotes`, fenced code
blocks, and GFM pipe tables all render. Diffs, commands, and error output
belong in a fenced block. Lead with the answer in the first line; whoever
reads only the notification preview should still know where it landed.

**Links carry a title, not a URL.** Write
`[Skip the ack when the reply is immediate](https://github.com/acme/website/pull/1234)`,
never a bare URL. Anything in another app gets its full URL: `#1234`,
`SENTRY-4F`, and `abc123f` are dead text in Thicket. Thicket links too:
`thicket url of <id>` prints a titled Markdown link for any recording.

**Use tables when the content is a grid.** Keep them simple, one line per
cell. **No hand-written HTML**: raw tags are escaped and land as visible
text. The `[@Name](member:<id>)` mention token is the only non-Markdown
markup the CLI understands; a bare `@Name` is resolved when it is
unambiguous.

### When the agent is assigned a card or to-do

`kind: "assigned"`: someone assigned the agent the recording; there is no
mention to strip, **the recording itself is the task** (`instruction` is its
text or title). Same checklist as a mention: ack (the connector already
cheered), move the card out of Triage, do the work, reply on the same
recording; on failure, @mention the requester.

### When the mention arrives in chat

A mention posted in a project chat room arrives as `kind: "mentioned"` with
`recording.type: "chat_message"` (the line) and `comment: null`, or with
`recording.type: "chat"` (the room) and the line in `comment`. Chat is
conversational and realtime, so dispatch the same way with these
differences:

- **Context**: `thicket -P <agent> chat line <line id> --json` for the line,
  `thicket -P <agent> chat history --in <project> -n 25 --json` for the
  conversation.
- **Ack**: the connector cheered the line; nothing more.
- **No card moves**: there is no board.
- **Reply in the chat as the agent**, not with a comment:
  `thicket -P <agent> chat post "<markdown>" --in <recording.project_id>`.
  Chat is small: bold, bullets, and titled links, no headings. Spill long
  results into a doc or a message-board comment and link them. On failure,
  @mention the requester with the mention token.

### When a comment lands on a thread the agent follows

`kind: "commented"` (`trigger.subscribed: true`): the connector fired because
the agent subscribes to the commented-on recording, not because it was
addressed. Treat this as *activity on a followed thread*, not a directive:

1. **Read for context**: `comment.text`, and as needed the thread
   (`thicket comments thread <recording.id>`). Same non-blocking dispatch;
   the front thread returns to the monitor immediately.
2. **Respond only if a response adds value**: a question the agent can
   answer, a problem it can act on, a change it should make. Reply on the
   same recording as the agent, exactly like a mention reply. **Default to
   staying silent**: a followed thread is not an instruction, and replying
   to every comment is noise.
3. **No cheer, no card moves, no interim reply** unless the agent actually
   takes the thread on.

### When someone cheers the agent's work

`kind: "cheered"`: `actor` is the cheerer, `recording` is the agent's own
work, and `cheer.content` is the reaction (at most 16 characters, a
*signal*, not an instruction: `👍`, `🔥`, `redo`, `wrong`).

1. **Read the signal in context**: the cheer plus the recording and its
   thread. Same non-blocking dispatch.
2. **Judge the valence.** An approving cheer needs **no action and no
   reply**; answering applause is noise. A corrective cheer (`redo`,
   `wrong`, `👎`, `🤔`) means the work needs another look: re-read the
   thread for what to fix; when the signal is too terse to act on
   confidently, reply on the recording as the agent asking one concrete
   question.
3. **No cheer back, no card moves, no interim reply** unless the agent
   actually resumes work.

### When a card or to-do lands in a watched container

`kind: "card_added"` or `"todo_added"`: someone added an item to a column or
list the agent subscribes to (`trigger.subscribed`). Activity, not a
directive: read it, and only pick it up when the item plainly addresses the
agent (its text mentions it, or it is assigned; both arrive as their own
directives anyway). No cheer.

### Transient CLI failures under concurrent agents

With several agents running at once, a `thicket` call can fail with a
`network` or `rate_limit` error (`retryable: true`), or the keyring can
answer late. **Retry the call** two or three times with a short pause, and
only then treat it as a real failure. Retry only when the envelope says
`retryable: true`; any other error is a verdict, and a retried write posts
twice. **Never run `thicket auth login`** in response: an interactive login
cannot complete from a background agent, and re-authing a profile that is
not broken risks clobbering good credentials. Never report a mid-run
transient as "the agent profile is missing"; the startup check is the
authority on that.

### Validate a finished body of work (in the background)

Whenever a coherent body of work is finished, run the repo's test gate in the
background before reporting done, once at the end rather than after every
edit, and fix anything it flags before the reply says "done".

### When the task results in a pull request

**Do not report the work done until the branch is green:**

1. Work in a fresh worktree off `main` so `main` stays clean.
2. Green locally first; never push red.
3. Push and open the PR.
4. Green remotely (`gh pr checks <n> --watch --fail-fast`); fix and re-watch
   until every check passes.
5. Only now reply "done" on Thicket, with the PR linked by its title. The
   interim reply may link the PR early as "in progress", never "done". If
   it cannot be made green after a reasonable effort, reply with what is
   failing and @mention the requester.

## Cleanup and lifecycle: always stop the watch

`thicket agent watch` exposes nothing and registers nothing server-side; the
only thing it holds is the agent's presence lease (which lapses 90 seconds
after the process stops) and its run record. So the rule is simple:
**whenever you stop watching, for any reason, stop the process** (TaskStop
or SIGTERM). Its exit removes the run record, and presence lapses on its
own.

After stopping, verify:

```bash
thicket agent watch --status     # expect this run gone
```

A run killed with SIGKILL leaves its record behind; `--status` prunes
records whose process is gone, so the normal answer to a leftover is "run
`--status` again", not a manual delete.

## Notes

- One watch = one agent inbox, any number of projects. Re-running resumes
  from now (or from `--since`/`--after`); history is never replayed as new.
- The connector never trusts a row's claim: the recording is re-fetched
  before a line is printed, and the fetched copy is what the line carries.
- **Reply loop (defense in depth):** replies are posted as the agent, a
  distinct membership, and the connector refuses agent-authored rows in
  every trust mode, so agent replies are never re-ingested; still keep the
  agent's own mention out of reply bodies.
