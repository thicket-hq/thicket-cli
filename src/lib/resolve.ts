// Fuzzy name → id resolution:
// UUID passthrough, then exact match, then case-insensitive, then
// substring. Ambiguity is an error listing the candidates; a miss suggests
// near-matches. `me` resolves through /authorization's membership_id.
import type { CliContext } from "./context.js";
import { CliError } from "./output.js";
import { looksLikeUrl, parseThicketUrl } from "./urls.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(value: string): boolean {
  return UUID.test(value);
}

type Named = { id: string; name: string };

export function matchNamed(
  candidates: Named[],
  ref: string,
  kind: string,
): Named {
  if (looksLikeId(ref)) {
    const byId = candidates.find((c) => c.id === ref);
    return byId ?? { id: ref, name: ref };
  }
  const exact = candidates.filter((c) => c.name === ref);
  if (exact.length === 1) return exact[0];
  const ci = candidates.filter(
    (c) => c.name.toLowerCase() === ref.toLowerCase(),
  );
  if (ci.length === 1) return ci[0];
  const partial = candidates.filter((c) =>
    c.name.toLowerCase().includes(ref.toLowerCase()),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new CliError(
      "ambiguous",
      `"${ref}" matches ${partial.length} ${kind}s: ${partial
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}`,
      "Use the exact name or the id",
    );
  }
  const suggestions = candidates
    .map((c) => c.name)
    .filter((name) =>
      name.toLowerCase().startsWith(ref.slice(0, 3).toLowerCase()),
    )
    .slice(0, 3);
  throw new CliError(
    "not_found",
    `No ${kind} matches "${ref}"`,
    suggestions.length ? `Did you mean: ${suggestions.join(", ")}?` : undefined,
  );
}

/**
 * A project by id, name, or app URL: the project's own link or a link to
 * anything in it (which also sets the org, as every pasted link does).
 */
export async function resolveProject(
  ctx: CliContext,
  ref: string,
): Promise<{ id: string; name: string }> {
  if (looksLikeId(ref)) return { id: ref, name: ref };
  if (looksLikeUrl(ref)) {
    const parsed = parseThicketUrl(ref);
    if (!parsed?.project_id) {
      throw new CliError(
        "usage",
        `That URL names no project: ${ref}`,
        "Paste the project's link, or a link to anything in it",
      );
    }
    ctx.adoptOrg(parsed.org);
    return { id: parsed.project_id, name: parsed.project_id };
  }
  const org = await ctx.org();
  const projects = await org.projects.list();
  return matchNamed(
    projects.map((p) => ({ id: String(p.id), name: String(p.name) })),
    ref,
    "project",
  );
}

export type ToolName =
  | "message_board"
  | "todos"
  | "folder"
  | "calendar"
  | "board"
  | "chat"
  | "check_ins"
  | "clients";

const TOOL_LABELS: Record<ToolName, string> = {
  message_board: "Message board",
  todos: "To-dos",
  folder: "Docs & Files",
  calendar: "Calendar",
  board: "Board",
  chat: "Chat",
  check_ins: "Check-ins",
  clients: "Clients",
};

/** The tool's singleton container id inside a project. */
export async function resolveTool(
  ctx: CliContext,
  projectRef: string,
  tool: ToolName,
): Promise<{ containerId: string; projectId: string; projectName: string }> {
  const project = await resolveProject(ctx, projectRef);
  const org = await ctx.org();
  const tools = await org.projects.tools(project.id);
  const entry = tools.find(
    (t) => (t as { tool?: string }).tool === tool,
  ) as { tool: string; enabled?: boolean; container_id?: string } | undefined;
  if (!entry?.container_id || entry.enabled === false) {
    throw new CliError(
      "not_found",
      `${TOOL_LABELS[tool]} is not enabled on "${project.name}"`,
      `Turn it on from the project's settings in the app`,
    );
  }
  return {
    containerId: String(entry.container_id),
    projectId: project.id,
    projectName: project.name,
  };
}

/** A to-do list (or group) inside a project's to-dos tool. */
export async function resolveTodoList(
  ctx: CliContext,
  projectRef: string,
  listRef: string,
): Promise<{ id: string; title: string }> {
  if (looksLikeId(listRef)) return { id: listRef, title: listRef };
  const { containerId } = await resolveTool(ctx, projectRef, "todos");
  const org = await ctx.org();
  const lists = await org.recordings.children(containerId, {
    type: "todolist",
  });
  const match = matchNamed(
    lists.map((l) => ({ id: String(l.id), name: String(l.title ?? "") })),
    listRef,
    "to-do list",
  );
  return { id: match.id, title: match.name };
}

/** A board column inside a project's board tool. */
export async function resolveColumn(
  ctx: CliContext,
  projectRef: string,
  columnRef: string,
): Promise<{ id: string; title: string }> {
  if (looksLikeId(columnRef)) return { id: columnRef, title: columnRef };
  const { containerId } = await resolveTool(ctx, projectRef, "board");
  const org = await ctx.org();
  const columns = await org.recordings.children(containerId, {
    type: "column",
  });
  const match = matchNamed(
    columns.map((c) => ({ id: String(c.id), name: String(c.title ?? "") })),
    columnRef,
    "column",
  );
  return { id: match.id, title: match.name };
}

/**
 * People by name, email, or `me` → membership ids. Accepts a
 * comma-separated or repeated list.
 */
export async function resolvePeople(
  ctx: CliContext,
  refs: string[],
): Promise<string[]> {
  const flat = refs
    .flatMap((r) => r.split(","))
    .map((r) => r.trim())
    .filter(Boolean);
  if (flat.length === 0) return [];
  const org = await ctx.org();
  type Person = { membership_id: string; name: string; email: string };
  let people: Person[] | null = null;
  const ids: string[] = [];
  for (const ref of flat) {
    if (ref === "me") {
      ids.push(await ctx.myMembershipId());
      continue;
    }
    if (looksLikeId(ref)) {
      ids.push(ref);
      continue;
    }
    people ??= await org.request<Person[]>("GET", "/people");
    const byEmail = people.find(
      (p) => p.email.toLowerCase() === ref.toLowerCase(),
    );
    if (byEmail) {
      ids.push(byEmail.membership_id);
      continue;
    }
    const match = matchNamed(
      people.map((p) => ({ id: p.membership_id, name: p.name })),
      ref,
      "person",
    );
    ids.push(match.id);
  }
  return [...new Set(ids)];
}
