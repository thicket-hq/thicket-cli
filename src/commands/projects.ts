// Projects: list/show/create/update, star, lifecycle.
import pc from "picocolors";
import type { CliContext } from "../lib/context.js";
import { clip, table, type CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";
import { resolveProject } from "../lib/resolve.js";

const CATEGORY = "Projects";

type ProjectRow = {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
  all_access?: boolean;
  starred?: boolean;
  is_sample?: boolean;
};

async function list(
  ctx: CliContext,
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const status = options.archived
    ? "archived"
    : options.trashed
      ? "trashed"
      : undefined;
  const rows = (await org.projects.list(
    status ? { status } : undefined,
  )) as ProjectRow[];
  return {
    data: rows,
    summary: `${rows.length} ${status ?? "active"} project${rows.length === 1 ? "" : "s"}`,
    human: table(
      ["", "NAME", "DESCRIPTION", "ID"],
      rows.map((p) => [
        p.starred ? pc.yellow("★") : "",
        p.name,
        clip(p.description ?? "", 44),
        p.id,
      ]),
    ),
    breadcrumbs: [
      { action: "show", cmd: "thicket projects show <project>", description: "Project detail + tools" },
      { action: "todos", cmd: "thicket todos --in <project>", description: "Its to-dos" },
    ],
  };
}

async function show(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const project = await resolveProject(ctx, args[0]);
  const org = await ctx.org();
  const detail = (await org.projects.get(project.id)) as ProjectRow & {
    tools?: { tool: string; label: string; enabled: boolean; container_id: string }[];
  };
  const tools = (detail.tools ?? []).filter((t) => t.enabled);
  return {
    data: detail,
    summary: detail.name,
    human: [
      pc.bold(detail.name),
      pc.dim(detail.id),
      ...(detail.description ? [clip(detail.description, 200)] : []),
      "",
      pc.dim("Tools:"),
      ...tools.map((t) => `  ${t.label} (${t.tool}) · container ${t.container_id}`),
    ],
    breadcrumbs: [
      { action: "todos", cmd: `thicket todos --in ${detail.id}` },
      { action: "messages", cmd: `thicket messages --in ${detail.id}` },
      { action: "activity", cmd: `thicket activity --project ${detail.id}` },
    ],
  };
}

async function create(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const org = await ctx.org();
  const project = (await org.projects.create({
    name: args[0],
    ...(options.description ? { description: String(options.description) } : {}),
    ...(options.allAccess ? { all_access: true } : {}),
  })) as ProjectRow;
  return {
    data: project,
    summary: `Created project "${project.name}"`,
    human: [`${pc.green("Created.")} ${project.name} (${project.id})`],
    breadcrumbs: [
      { action: "show", cmd: `thicket projects show ${project.id}` },
    ],
  };
}

async function update(
  ctx: CliContext,
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const project = await resolveProject(ctx, args[0]);
  const body: Record<string, unknown> = {};
  if (options.name !== undefined) body.name = options.name;
  if (options.description !== undefined) body.description = options.description;
  if (options.allAccess !== undefined) body.all_access = options.allAccess;
  const org = await ctx.org();
  const updated = await org.projects.update(project.id, body);
  return {
    data: updated,
    summary: `Updated "${(updated as ProjectRow).name}"`,
    human: [`${pc.green("Updated.")} ${(updated as ProjectRow).name}`],
  };
}

function lifecycle(
  status: "archived" | "trashed" | "active",
  verb: string,
): CommandSpec["handler"] {
  return async (ctx, args) => {
    const project = await resolveProject(ctx, args[0]);
    const org = await ctx.org();
    await org.request("PUT", `/projects/${project.id}/status/${status}`);
    return {
      data: { id: project.id, status },
      summary: `${verb} "${project.name}"`,
      human: [`${pc.green(`${verb}.`)} ${project.name}`],
    };
  };
}

function star(on: boolean): CommandSpec["handler"] {
  return async (ctx, args) => {
    const project = await resolveProject(ctx, args[0]);
    const org = await ctx.org();
    await org.request(on ? "PUT" : "DELETE", `/projects/${project.id}/star`);
    return {
      data: { id: project.id, starred: on },
      summary: `${on ? "Starred" : "Unstarred"} "${project.name}"`,
      human: [`${pc.green(on ? "Starred." : "Unstarred.")} ${project.name}`],
    };
  };
}

async function people(
  ctx: CliContext,
  args: string[],
): Promise<CommandResult> {
  const project = await resolveProject(ctx, args[0]);
  const org = await ctx.org();
  type Person = {
    membership_id: string;
    name: string;
    email: string;
    role: string;
    title?: string | null;
    company_name?: string | null;
  };
  const rows = await org.request<Person[]>(
    "GET",
    `/projects/${project.id}/people`,
  );
  return {
    data: rows,
    summary: `${rows.length} people on "${project.name}"`,
    human: table(
      ["NAME", "EMAIL", "ROLE", "MEMBERSHIP"],
      rows.map((p) => [p.name, p.email, p.role, p.membership_id]),
    ),
    ids: rows.map((p) => p.membership_id),
  };
}

const projectRef = {
  name: "project",
  description: "Project name or id",
  required: true,
};

export const projectCommands: CommandSpec[] = [
  {
    path: ["projects"],
    category: CATEGORY,
    summary: "List projects (bare shorthand for projects list)",
    flags: [
      { flag: "--archived", description: "List archived projects" },
      { flag: "--trashed", description: "List trashed projects" },
    ],
    handler: list,
  },
  {
    path: ["projects", "list"],
    category: CATEGORY,
    summary: "List projects",
    flags: [
      { flag: "--archived", description: "List archived projects" },
      { flag: "--trashed", description: "List trashed projects" },
    ],
    handler: list,
  },
  {
    path: ["projects", "show"],
    category: CATEGORY,
    summary: "Project detail, including its tools and their container ids",
    args: [projectRef],
    notes: ["Content is created under a tool's container_id (see thicket todos/messages/cards)"],
    handler: show,
  },
  {
    path: ["projects", "create"],
    category: CATEGORY,
    summary: "Create a project",
    args: [{ name: "name", description: "Project name", required: true }],
    flags: [
      { flag: "-d, --description <text>", description: "Project description" },
      { flag: "--all-access", description: "Everyone on the team can see it" },
    ],
    handler: create,
  },
  {
    path: ["projects", "update"],
    category: CATEGORY,
    summary: "Update a project's name, description, or access",
    args: [projectRef],
    flags: [
      { flag: "--name <name>", description: "New name" },
      { flag: "-d, --description <text>", description: "New description" },
      { flag: "--all-access", description: "Open to the whole team" },
    ],
    handler: update,
  },
  {
    path: ["projects", "archive"],
    category: CATEGORY,
    summary: "Archive a project",
    args: [projectRef],
    handler: lifecycle("archived", "Archived"),
  },
  {
    path: ["projects", "trash"],
    category: CATEGORY,
    summary: "Move a project to the trash (recoverable for 30 days)",
    args: [projectRef],
    handler: lifecycle("trashed", "Trashed"),
  },
  {
    path: ["projects", "restore"],
    category: CATEGORY,
    summary: "Restore an archived or trashed project",
    args: [projectRef],
    handler: lifecycle("active", "Restored"),
  },
  {
    path: ["projects", "star"],
    category: CATEGORY,
    summary: "Star a project (pins it to the top of home)",
    args: [projectRef],
    handler: star(true),
  },
  {
    path: ["projects", "unstar"],
    category: CATEGORY,
    summary: "Unstar a project",
    args: [projectRef],
    handler: star(false),
  },
  {
    path: ["projects", "people"],
    category: CATEGORY,
    summary: "Who is on a project",
    args: [projectRef],
    handler: people,
  },
];
