// Thicket web URLs <-> ids. The web app builds every recording link with
// recording-href.ts (src/components/shell in the thicket repo); this is its
// inverse, so any command that takes a recording id also takes a link
// pasted from the browser, and `thicket url parse` shows what it sees.

export type ParsedUrl = {
  org: string;
  project_id: string | null;
  recording_id: string | null;
  /** The recording type the path implies, or the tool name for tool pages. */
  type: string | null;
  /** The id of the list/question/card the path names before the recording. */
  parent_id: string | null;
  /** From a #comment-<id> fragment. */
  comment_id: string | null;
  /** A repeating event's day, from ?occurrence=YYYY-MM-DD. */
  occurrence: string | null;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");

function isUuid(s: string | undefined): s is string {
  return !!s && UUID_RE.test(s);
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim()) || value.trim().startsWith("/o/");
}

/** Parses an app URL (or an app path starting with /o/). Null when it is not one. */
export function parseThicketUrl(value: string): ParsedUrl | null {
  let path: string;
  let hash = "";
  let search: URLSearchParams;
  try {
    if (value.trim().startsWith("/o/")) {
      const [p, h] = value.trim().split("#");
      const [pathname, query] = p.split("?");
      path = pathname;
      search = new URLSearchParams(query ?? "");
      hash = h ?? "";
    } else {
      const url = new URL(value.trim());
      path = url.pathname;
      search = url.searchParams;
      hash = url.hash.replace(/^#/, "");
    }
  } catch {
    return null;
  }
  const occurrence = search.get("occurrence");
  const segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (segs[0] !== "o" || !segs[1]) return null;
  const org = segs[1];
  const commentMatch = hash.match(new RegExp(`^comment-(${UUID})$`, "i"));
  const base: ParsedUrl = {
    org,
    project_id: null,
    recording_id: null,
    type: null,
    parent_id: null,
    comment_id: commentMatch ? commentMatch[1] : null,
    occurrence: occurrence && /^\d{4}-\d{2}-\d{2}$/.test(occurrence) ? occurrence : null,
  };
  const rest = segs.slice(2);

  // Outside projects: the account calendar and DMs.
  if (rest[0] === "calendar") {
    return {
      ...base,
      type: isUuid(rest[1]) ? "calendar_event" : "calendar",
      recording_id: isUuid(rest[1]) ? rest[1] : null,
    };
  }
  if (rest[0] === "chats") {
    return { ...base, type: isUuid(rest[1]) ? "dm" : null, recording_id: isUuid(rest[1]) ? rest[1] : null };
  }
  if (rest[0] !== "projects" || !isUuid(rest[1])) return base;
  const project_id = rest[1];
  const tool = rest[2];
  const a = rest[3];
  const b = rest[4];
  const c = rest[5];
  const withProject = { ...base, project_id };
  const rec = (type: string, id: string, parent_id: string | null = null): ParsedUrl => ({
    ...withProject,
    type,
    recording_id: id,
    parent_id,
  });
  switch (tool) {
    case undefined:
      return withProject;
    case "message-board":
      return isUuid(a) ? rec("message", a) : { ...withProject, type: "message_board" };
    case "docs":
      if (a === "files" && isUuid(b)) return rec("upload", b);
      if (a === "links" && isUuid(b)) return rec("linked_file", b);
      return isUuid(a) ? rec("document", a) : { ...withProject, type: "folder" };
    case "todos":
      if (a === "progress" && isUuid(b)) return rec("progress_update", b);
      if (isUuid(a) && isUuid(b)) return rec("todo", b, a);
      return isUuid(a) ? rec("todolist", a) : { ...withProject, type: "todos" };
    case "health":
      return isUuid(a) ? rec("health_update", a) : { ...withProject, type: "health" };
    case "timesheet":
      // The project's timesheet, or one item's (the id is the item's).
      return isUuid(a) ? rec("timesheet", a) : { ...withProject, type: "timesheet" };
    case "calendar":
      return isUuid(a) ? rec("calendar_event", a) : { ...withProject, type: "calendar" };
    case "cards":
      if (a === "columns" && isUuid(b)) return rec("column", b);
      return isUuid(a) ? rec("card", a) : { ...withProject, type: "board" };
    case "chat":
      return { ...withProject, type: "chat" };
    case "check-ins":
      if (isUuid(a) && b === "answers" && isUuid(c)) return rec("answer", c, a);
      return isUuid(a) ? rec("question", a) : { ...withProject, type: "check_ins" };
    case "clients":
      if (a === "approvals" && isUuid(b)) return rec("client_approval", b);
      if (a === "correspondence" && isUuid(b)) return rec("client_correspondence", b);
      return { ...withProject, type: "clients" };
    default:
      return withProject;
  }
}

export type Linkable = {
  id: string;
  project_id?: string | null;
  type?: string | null;
  parent_id?: string | null;
};

/** The web app path for a recording, mirroring recording-href.ts exactly. */
export function recordingPath(org: string, rec: Linkable): string {
  const projectId = rec.project_id ?? null;
  const type = rec.type ?? "";
  const parentId = rec.parent_id ?? null;
  if (projectId === null && type === "calendar_event") return `/o/${org}/calendar/${rec.id}`;
  if (projectId === null && type === "calendar") return `/o/${org}/calendar`;
  if (projectId === null) {
    const dmId = type === "dm" ? rec.id : (parentId ?? rec.id);
    return `/o/${org}/chats/${dmId}`;
  }
  const base = `/o/${org}/projects/${projectId}`;
  switch (type) {
    case "message":
      return `${base}/message-board/${rec.id}`;
    case "message_board":
      return `${base}/message-board`;
    case "document":
      return `${base}/docs/${rec.id}`;
    case "upload":
      return `${base}/docs/files/${rec.id}`;
    case "linked_file":
      return `${base}/docs/links/${rec.id}`;
    case "folder":
      return `${base}/docs`;
    case "todos":
      return `${base}/todos`;
    case "todolist":
      return `${base}/todos/${rec.id}`;
    case "todo":
      return parentId ? `${base}/todos/${parentId}/${rec.id}` : `${base}/todos`;
    case "progress_update":
      return `${base}/todos/progress/${rec.id}`;
    case "health":
      return `${base}/health`;
    case "health_update":
      return `${base}/health/${rec.id}`;
    case "timesheet":
      return `${base}/timesheet`;
    case "calendar":
      return `${base}/calendar`;
    case "calendar_event":
      return `${base}/calendar/${rec.id}`;
    case "board":
      return `${base}/cards`;
    case "step":
      return parentId ? `${base}/cards/${parentId}` : `${base}/cards`;
    case "column":
      return `${base}/cards/columns/${rec.id}`;
    case "card":
      return `${base}/cards/${rec.id}`;
    case "chat":
    case "chat_message":
      return `${base}/chat`;
    case "check_ins":
      return `${base}/check-ins`;
    case "question":
      return `${base}/check-ins/${rec.id}`;
    case "answer":
      return parentId ? `${base}/check-ins/${parentId}/answers/${rec.id}` : `${base}/check-ins`;
    case "clients":
      return `${base}/clients`;
    case "client_approval":
      return `${base}/clients/approvals/${rec.id}`;
    case "client_correspondence":
      return `${base}/clients/correspondence/${rec.id}`;
    default:
      return base;
  }
}

export function recordingUrl(baseUrl: string, org: string, rec: Linkable): string {
  return `${baseUrl.replace(/\/$/, "")}${recordingPath(org, rec)}`;
}
