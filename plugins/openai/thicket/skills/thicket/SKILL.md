---
name: thicket
description: Work in Thicket through the Thicket tools. Find, read, create and update projects, to-dos, cards, messages, comments, docs, schedule entries, chat and time entries. Use for any Thicket question or action, and for any thickethq.com link.
---

# Working in Thicket

Thicket is project management software. An organization holds projects; a project holds to-do lists, a message board, docs and files, card tables, a schedule, chat and, when it is turned on, a timesheet. Every tool runs as the person who connected Thicket, with their access: an item they cannot see does not exist here.

## Find things top down

1. Call `list_organizations` first. Every other tool takes the organization slug it returns.
2. Call `list_projects` for the projects you can see, then the tool for the content you need: `list_todo_lists` and `list_todos`, `list_messages`, `list_documents`, `list_boards` and `list_cards`, `list_schedule_entries`, `list_chat_messages` (a project's Chat by `project_id`, or a private chat by `chat_id` from `list_chats`). `list_people` lists an organization's people, or with `project_id` the people on one project, with each person's role, title and company.
3. `search` finds items across an organization, and `fetch` opens one by id or by its thickethq.com link, pasted as is; every tool that takes an item id takes its link too.
4. Reports answer in one call: `list_overdue_todos` for what's overdue across projects (days late, with a lateness bucket), `list_my_assignments` for the person's own work (open, one `due` window such as `due_today`, or `completed`; Up Next first), `list_person_assignments` for someone else's, and `list_activity`, `list_project_activity` and `list_person_activity` for what happened lately, newest first, with `since` for everything after the last look.
5. Check-ins: `list_check_ins` lists a project's questions with who they ask and the day each most recently asked for; `list_answers` reads one question's answers by day or by person, and who has answered.
6. Ids from one result feed the next call. Keep them exactly as returned, and never invent people, projects or membership ids: look them up.

## Change things carefully

- Read before you update. `update_todo`, `move_todo`, `move_card`, `update_card`, `update_message`, `update_document`, `update_event`, `update_answer`, `update_card_step`, `update_timesheet_entry` and `trash_item` take the `expected_updated_at` you last read and refuse a stale one. Re-read, then retry.
- Creates and posts take an `idempotency_key`. Mint a fresh UUID for each intended action, and reuse it only to retry that same action.
- Text you post is Markdown. To mention someone, paste the `mention` token `list_people` gives for them, `[@Name](member:<membership id>)`; a bare `@First` works only when one person matches. Never invent a token.
- Writes post as the connected person and notify people immediately, and a sent notification cannot be recalled. Confirm an ambiguous target (which project, which list, which person) before posting.
- A to-do's position is its priority, top first. Rank work with `move_todo` and `reorder_todos` rather than setting due dates, which trigger reminders.
- `create_project` starts a project: invite-only with only the person on it unless `all_access` is true. Confirm the name and whether to open it to the whole team before creating it. `update_project` changes its details and dates, `set_project_status` archives, restores or trashes it (the Trash keeps it 30 days), and `set_project_access` adds or removes people by membership id; confirm before archiving, trashing or removing anyone.
- Junk or duplicate items go to the Trash with `trash_item`, never marked complete. The Trash keeps them for 30 days. Nothing here deletes permanently.
- `answer_check_in` posts the person's answer to a check-in question for a day (default today) and notifies the question's subscribers; confirm the text first. `update_answer` corrects their own answer.
- A card's steps: `fetch` the card to see them; `add_card_step`, `update_card_step`, `set_card_step_completion` and `reorder_card_steps` work them.
- `create_document` writes a document into a project's Docs & Files, at the top or in a folder (folder ids from `list_documents`), published (which notifies the project) or as a draft; `publish_draft` publishes a draft. Confirm the text before publishing.
- Private chats: `list_chats` lists the person's, `start_chat` finds or starts one with named people, and `post_chat_message` with `chat_id` posts in it; the people in it are notified.
- `create_event` adds an event to a project's Calendar (or the person's account calendar when no project is given) and `update_event` changes one; invited people are notified, so confirm the time and the invitees first.
- Time: `log_time` logs hours ("1.5" or "1:30") on an item, on the project itself or as absence, and `list_timesheet_entries` reads them. Deleting time happens in Thicket.

## Answering

- Give names, and link items with the `web_url` each result carries.
- After a write succeeds, say once what changed and where.
