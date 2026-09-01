// Spec fragments shared across command files, so every command that takes
// a recording or a body says so the same way.
import type { ArgSpec, FlagSpec } from "./registry.js";

export const recordingArg = (description = "Recording id, or its URL in the app"): ArgSpec => ({
  name: "id",
  description,
  required: true,
});

export const idOrUrlNote = "Accepts a thickethq.com URL anywhere an id is expected";

export const plainFlag: FlagSpec = {
  flag: "--plain",
  description: "Send the body as plain text instead of converting Markdown",
};

export const contentFlags = (what = "Body"): FlagSpec[] => [
  { flag: "-c, --content <markdown>", description: `${what} as Markdown (or - for stdin); @Name and [@Name](member:<id>) mention people` },
  { flag: "--content-html <html>", description: `${what} as raw HTML (sanitized server-side)` },
  plainFlag,
];

export const markdownNotes = [
  "Bodies are Markdown: headings, emphasis, lists, links, code, blockquotes, GFM tables; raw HTML is escaped",
  "Mention people with @Name (resolved against thicket people) or [@Name](member:<membership id>) to pin one",
  "Pass - as the body to read it from stdin; --plain sends plain text; --content-html sends raw HTML",
];
