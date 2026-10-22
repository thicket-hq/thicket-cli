---
name: thicket
description: Work in Thicket through the Thicket tools. Find, read, create and update projects, to-dos, cards, messages, comments, docs, schedule entries, chat and time entries. Use for any Thicket question or action, and for any thickethq.com link.
---

# Working in Thicket

Thicket is project management software. An organization holds projects; a project holds to-do lists, a message board, docs and files, card tables, a schedule, chat and, when it is turned on, a timesheet. Every tool runs as the person who connected Thicket, with their access: an item they cannot see does not exist here.

## Find things top down

1. Call `list_organizations` first. Every other tool takes the organization slug it returns.
2. Call `list_projects` for the projects you can see, then the tool for the content you need: `list_todo_lists` and `list_todos`, `list_messages`, `list_documents`, `list_boards` and `list_cards`, `list_schedule_entries`, `list_chat_messages`, `list_people`.
3. `search` finds items across an organization, and `fetch` opens one by id. A thickethq.com link's path holds the organization slug and the item id.
4. Ids from one result feed the next call. Keep them exactly as returned, and never invent people, projects or membership ids: look them up.

## Change things carefully

- Read before you update. `update_todo`, `move_todo`, `move_card`, `update_card`, `update_message`, `update_document`, `update_timesheet_entry` and `trash_item` take the `expected_updated_at` you last read and refuse a stale one. Re-read, then retry.
- Creates and posts take an `idempotency_key`. Mint a fresh UUID for each intended action, and reuse it only to retry that same action.
- Writes post as the connected person and notify people immediately, and a sent notification cannot be recalled. Confirm an ambiguous target (which project, which list, which person) before posting.
- A to-do's position is its priority, top first. Rank work with `move_todo` and `reorder_todos` rather than setting due dates, which trigger reminders.
- Junk or duplicate items go to the Trash with `trash_item`, never marked complete. The Trash keeps them for 30 days. Nothing here deletes permanently.
- Time: `log_time` logs hours ("1.5" or "1:30") on an item, on the project itself or as absence, and `list_timesheet_entries` reads them. Deleting time happens in Thicket.

## Answering

- Give names, and link items with the `web_url` each result carries.
- After a write succeeds, say once what changed and where.
