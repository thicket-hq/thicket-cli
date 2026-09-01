// Raw passthrough: any /api/v1 route, in the envelope.
import type { CliContext } from "../lib/context.js";
import { readBody } from "../lib/refs.js";
import { CliError, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

async function api(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const method = args[0].toUpperCase();
  if (!METHODS.has(method)) throw new CliError("usage", `Unknown method ${args[0]}`, `One of: ${[...METHODS].join(", ")}`);
  let path = args[1];
  if (!path) throw new CliError("usage", "Which path?", "e.g. thicket api GET my/notifications");
  if (path.startsWith("/api/v1")) {
    // absolute
  } else if (path.startsWith("/")) {
    path = `/api/v1${path}`;
  } else {
    path = `/api/v1/${await ctx.orgSlug()}/${path}`;
  }
  const query: Record<string, string> = {};
  const qs = Array.isArray(options.query) ? options.query.map(String) : options.query ? [String(options.query)] : [];
  for (const pair of qs) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new CliError("usage", `--query needs key=value, got "${pair}"`);
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  let body: unknown;
  const raw = await readBody(options.body);
  if (raw !== undefined) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new CliError("usage", "--body must be JSON (or - for JSON on stdin)");
    }
  }
  const sdk = await ctx.sdk();
  const data = await sdk.client.request<unknown>(method, path, { query, ...(body !== undefined ? { body } : {}) });
  const count = Array.isArray(data) ? data.length : null;
  return {
    data: data ?? null,
    summary: `${method} ${path}${count !== null ? ` (${count} item${count === 1 ? "" : "s"})` : ""}`,
  };
}

export const apiCommands: CommandSpec[] = [
  {
    path: ["api"],
    category: "Meta",
    summary: "Call any API route directly, in the envelope",
    args: [
      { name: "method", description: "GET, POST, PUT, PATCH, or DELETE", required: true },
      { name: "path", description: "Route: org-relative (my/notifications), /api/v1-relative (/authorization), or absolute (/api/v1/...)", required: true },
    ],
    flags: [
      { flag: "--body <json>", description: "JSON request body (or - for stdin)" },
      { flag: "--query <k=v...>", description: "Query parameters (repeatable)" },
    ],
    notes: [
      "A path without a leading slash is scoped to the acting org: recordings/<id>, my/cheers, agents",
      "Spec: https://www.thickethq.com/openapi.json",
    ],
    handler: api,
  },
];
