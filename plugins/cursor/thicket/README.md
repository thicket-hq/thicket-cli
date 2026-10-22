# Thicket

Cursor plugin that connects agents to [Thicket](https://www.thickethq.com) through Thicket's hosted remote [Model Context Protocol](https://modelcontextprotocol.io/) server, built and run by Vesperion Gate. It works in Cursor and in Grok Bot.

Find, read and update to-dos, cards, messages, docs and chat in the Thicket organizations of the person who signs in.

## Install

**Cursor:** open **Cursor Settings → Plugins**, search for **Thicket**, click **Install**, then sign in to Thicket and approve access. Or run `/add-plugin thicket` in chat.

**Grok Bot:** open **Connect apps**, find **Thicket** and add it, then sign in to Thicket in your browser and approve access.

## MCP

```json
{
  "mcpServers": {
    "thicket": {
      "type": "http",
      "url": "https://www.thickethq.com/api/mcp",
      "placement": "server"
    }
  }
}
```

Sign-in is OAuth 2.1 with PKCE. Cursor registers itself with Thicket and opens Thicket's approval screen in your browser, so there's no API key or client ID to set up. The approval screen shows what was asked for, reading only or reading and making changes, and the organizations the connection covers.

## What agents can do

| Area | Tools |
| --- | --- |
| Organizations, projects and people | List the organizations and projects you can see, start a project, change its details, archive or trash it, add and remove people, and see who is on a project and in an organization |
| To-dos | List, create, update, complete, move and reorder to-dos, subtasks, to-do lists and groups |
| Boards | List boards and cards; create, update and move cards; add, change, check off and reorder a card's steps |
| Messages, comments and docs | Read and post messages under a category, pin them, read and post comments; read, write and update docs, publish a draft |
| Chat | Read and post in a project's chat; list, start and post in private chats |
| Check-ins | Read a project's questions and everyone's answers, answer yours, correct an answer |
| Schedule and time | Read schedule entries, add and change events; read, log and update time |
| Reports and activity | What's overdue across projects, your assignments and anyone's, and what happened lately in a project, for one person or everywhere |
| Notifications and follows | Read notifications and mark them read, follow and unfollow items, cheer |
| Search | `search` across an organization and `fetch` for any item by its id |

## Notes

- Tool calls run as the Thicket person who approves the connection, with that person's permissions. Changes are attributed to them.
- Trashed items stay recoverable from Thicket's Trash for 30 days. The connector never deletes anything permanently.
- Disconnect any time from **My settings → Connected apps** in Thicket. The next request is refused.

## Docs

- Thicket and AI assistants: https://www.thickethq.com/ai
- Setup, permissions and disconnecting: https://www.thickethq.com/help/mcp
- Server URL: https://www.thickethq.com/api/mcp
- Thicket CLI and agent skills: https://github.com/thicket-hq/thicket-cli

## License

MIT, © Vesperion Gate Inc. The Thicket name and logo are not licensed under it.
