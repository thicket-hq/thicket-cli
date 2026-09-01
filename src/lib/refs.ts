// Recording references and body inputs shared by every command: an id or a
// pasted app URL for the former, a literal or `-` (stdin) for the latter.
import { createInterface } from "node:readline";
import type { CliContext } from "./context.js";
import { CliError } from "./output.js";
import { looksLikeId } from "./resolve.js";
import { looksLikeUrl, parseThicketUrl } from "./urls.js";

export type RecordingRef = {
  id: string;
  /** Set when the reference was a URL naming a comment (#comment-<id>). */
  commentId: string | null;
  /** The org slug a URL named, when it did. */
  org: string | null;
  type: string | null;
  projectId: string | null;
};

/**
 * Turns `<id|url>` into a recording id. A URL naming another org than the
 * acting one switches the invocation to that org (a pasted link is the most
 * explicit scope there is), unless --org was passed and disagrees.
 */
export function resolveRecordingRef(ctx: CliContext, ref: string): RecordingRef {
  const value = ref.trim();
  if (looksLikeId(value)) {
    return { id: value, commentId: null, org: null, type: null, projectId: null };
  }
  if (looksLikeUrl(value)) {
    const parsed = parseThicketUrl(value);
    if (!parsed) {
      throw new CliError("usage", `Not a Thicket URL: ${value}`, "Expected https://www.thickethq.com/o/<org>/projects/<id>/...");
    }
    if (!parsed.recording_id) {
      throw new CliError(
        "usage",
        `That URL names ${parsed.type ? `a ${parsed.type.replace(/_/g, " ")} page` : "no recording"}, not a recording`,
        "Open the item itself and copy its link",
      );
    }
    ctx.adoptOrg(parsed.org);
    return {
      id: parsed.recording_id,
      commentId: parsed.comment_id,
      org: parsed.org,
      type: parsed.type,
      projectId: parsed.project_id,
    };
  }
  throw new CliError("usage", `Not a recording id or URL: ${value}`);
}

let stdinConsumed = false;

/** Reads the whole of stdin once; a second `-` in one invocation is a usage error. */
export async function readStdin(): Promise<string> {
  if (stdinConsumed) {
    throw new CliError("usage", "Only one argument can read from stdin (-) per invocation");
  }
  stdinConsumed = true;
  if (process.stdin.isTTY) {
    throw new CliError("usage", "- reads the body from stdin, but stdin is a terminal", "Pipe the text in, e.g. cat body.md | thicket ...");
  }
  const lines: string[] = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  // readline drops the final newline; a trailing blank line is what the
  // trailing newline trimming means here.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** For tests: forget that stdin was read. */
export function resetStdinForTests(): void {
  stdinConsumed = false;
}

/** A body value: the literal, or stdin when it is `-`. */
export async function readBody(value: unknown): Promise<string | undefined> {
  if (value === undefined || value === null || value === false) return undefined;
  const s = String(value);
  return s === "-" ? await readStdin() : s;
}
