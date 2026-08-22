// Shared human renderings for recording rows.
import pc from "picocolors";
import { clip, day, table } from "./output.js";

export type RecordingRow = {
  id: string;
  type?: string;
  title?: string | null;
  content?: string | null;
  status?: string;
  completed?: boolean;
  due_on?: string | null;
  starts_on?: string | null;
  starts_at?: string | null;
  project_id?: string;
  project_name?: string;
  parent_id?: string;
  parent_title?: string;
  creator_name?: string;
  comment_count?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};

export function todoTable(rows: RecordingRow[]): string[] {
  return table(
    ["", "TITLE", "DUE", "ID"],
    rows.map((r) => [
      r.completed ? pc.green("✓") : "◯",
      clip(r.title ?? "", 60),
      day(r.due_on),
      r.id,
    ]),
  );
}

export function recordingTable(rows: RecordingRow[]): string[] {
  return table(
    ["TYPE", "TITLE", "PROJECT", "ID"],
    rows.map((r) => [
      r.type ?? "",
      clip(r.title ?? r.content ?? "", 48),
      clip(r.project_name ?? "", 24),
      r.id,
    ]),
  );
}

export function detailLines(r: RecordingRow): string[] {
  const lines = [
    `${pc.bold(r.title ?? "(untitled)")}${r.completed ? pc.green("  ✓ done") : ""}`,
    pc.dim(`${r.type ?? "recording"} · ${r.id}`),
  ];
  if (r.status && r.status !== "active") lines.push(`Status: ${r.status}`);
  if (r.project_name) lines.push(`Project: ${r.project_name}`);
  if (r.parent_title) lines.push(`In: ${r.parent_title}`);
  if (r.starts_on || r.due_on) {
    lines.push(
      `Dates: ${[day(r.starts_on), day(r.due_on)].filter(Boolean).join(" → ")}`,
    );
  }
  if (r.starts_at) lines.push(`Starts: ${r.starts_at}`);
  const assignees = (r.assignees ?? null) as { name?: string }[] | null;
  if (assignees?.length) {
    lines.push(`Assigned: ${assignees.map((a) => a.name).join(", ")}`);
  }
  if (r.creator_name) lines.push(`By: ${r.creator_name}`);
  if (typeof r.comment_count === "number" && r.comment_count > 0) {
    lines.push(`Comments: ${r.comment_count}`);
  }
  if (r.content) {
    lines.push("", clip(stripHtml(String(r.content)), 500));
  }
  return lines;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
