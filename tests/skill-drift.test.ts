// Skill drift: every `thicket ...` command named in code spans or fenced
// blocks of the skills, README, and install.md must exist in the registry.
// Documenting a command that does not exist is the drift this catches.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allCommands } from "../src/cli.js";

const ROOT = join(__dirname, "..");

function skillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...skillFiles(path));
    else if (entry === "SKILL.md") out.push(path);
  }
  return out;
}

const DOCS = [join(ROOT, "README.md"), join(ROOT, "install.md"), ...skillFiles(join(ROOT, "skills"))];

/** Code spans and fenced blocks: commands are always in code, prose never counts. */
function codeSegments(markdown: string): string[] {
  const segments: string[] = [];
  const fenced = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(markdown))) segments.push(m[1]);
  const withoutFences = markdown.replace(fenced, "");
  const spans = /`([^`\n]+)`/g;
  while ((m = spans.exec(withoutFences))) segments.push(m[1]);
  return segments;
}


/** Command words after `thicket` in one code segment: ["comments", "thread"]. */
function commandWords(segment: string): string[][] {
  const found: string[][] = [];
  for (const line of segment.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "thicket") continue;
      // Must be the start of a command: line start, or after a shell separator.
      const prev = tokens[i - 1];
      if (prev !== undefined && !/^(\||&&|;|\$\(|if|then|do|out=\$\(|\(|-)$/.test(prev) && !prev.endsWith("=$(") && !prev.endsWith("(")) continue;
      const words: string[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (/^[#|&;><]/.test(t)) break; // a comment or the next shell stage
        if (t.startsWith("-")) {
          // A flag's value (when it has one) is never a command word.
          if (tokens[j + 1] !== undefined && !/^[-#|&;><]/.test(tokens[j + 1])) j += 1;
          continue;
        }
        if (/^[a-z][a-z0-9-]*$/.test(t)) words.push(t);
        else break;
      }
      if (words.length) found.push(words);
    }
  }
  return found;
}

describe("skill drift", () => {
  const registered = allCommands();
  // Aliases are commands too: `thicket inbox` is `thicket notifications`.
  const specs = registered.flatMap((s) => [
    s,
    ...(s.aliases ?? []).map((alias) => ({ ...s, path: [...s.path.slice(0, -1), alias] })),
  ]);

  it("scans the docs and finds commands", () => {
    const total = DOCS.flatMap((f) => codeSegments(readFileSync(f, "utf8"))).flatMap(commandWords);
    expect(total.length).toBeGreaterThan(40);
  });

  for (const file of DOCS) {
    it(`${file.replace(ROOT, "")}: every thicket command exists`, () => {
      const markdown = readFileSync(file, "utf8");
      const problems: string[] = [];
      for (const segment of codeSegments(markdown)) {
        for (const words of commandWords(segment)) {
          // The longest registered path that prefixes the words.
          let best: (typeof specs)[number] | null = null;
          for (const spec of specs) {
            if (spec.path.every((seg, i) => words[i] === seg) && (!best || spec.path.length > best.path.length)) best = spec;
          }
          if (!best) {
            problems.push(`thicket ${words.join(" ")}`);
            continue;
          }
          const extra = words.slice(best.path.length);
          // A parent named bare is not a command; extra words must be positional args.
          if (extra.length && !(best.args?.length)) problems.push(`thicket ${words.join(" ")} (no such subcommand of "${best.path.join(" ")}")`);
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});
