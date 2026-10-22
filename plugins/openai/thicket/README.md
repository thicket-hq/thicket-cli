# Thicket for ChatGPT

The plugin package behind Thicket's listing in the ChatGPT plugin directory: Thicket's hosted remote [Model Context Protocol](https://modelcontextprotocol.io/) server, built and run by Vesperion Gate, with two bundled skills (`thicket`, how to work in a Thicket project, and `setup`, the guided first run).

Find, read and update to-dos, cards, messages, comments, docs, schedule entries, chat and time entries in the Thicket organizations of the person who signs in.

## Install

Open **Plugins** in ChatGPT, search for **Thicket**, click **Install**, then sign in to Thicket and approve access. Until the listing is live, ChatGPT's Developer mode takes the same server as a custom MCP server; the steps are at https://www.thickethq.com/ai.

## Package

- `plugin.json`: the portable manifest, with ChatGPT's listing fields under `extensions.com.openai`.
- `mcp.json`: the server, `https://www.thickethq.com/api/mcp`, with OAuth 2.1 (PKCE, client identification by metadata document, dynamic registration as the fallback). No API key or client secret.
- `skills/`: the two skills ChatGPT loads with the plugin.
- `assets/`: the logo and composer icon.

Zip the `thicket` folder to upload it: `cd plugins/openai && zip -r thicket.zip thicket -x '*.DS_Store'`.

## Notes

- Tool calls run as the Thicket person who approves the connection, with that person's permissions. Changes are attributed to them.
- Trashed items stay recoverable from Thicket's Trash for 30 days. The connector never deletes anything permanently.
- Disconnect any time from **My settings, Connected apps** in Thicket. The next request is refused.

## Docs

- Thicket and AI assistants: https://www.thickethq.com/ai
- Setup, permissions and disconnecting: https://www.thickethq.com/help/mcp
- Server URL: https://www.thickethq.com/api/mcp

## License

MIT, © Vesperion Gate Inc. The Thicket name and logo are not licensed under it.
