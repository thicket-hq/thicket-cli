// Guard: CLAUDE.md imports AGENTS.md. Claude Code reads AGENTS.md only as a
// fallback when it finds no CLAUDE.md, so a CLAUDE.md elsewhere on the path,
// such as a workspace one, can leave the rules here unread. A one-line
// `@AGENTS.md` CLAUDE.md loads them whatever the fallback does.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("agent instructions", () => {
  it("CLAUDE.md imports AGENTS.md", () => {
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(ROOT, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(ROOT, "CLAUDE.md"), "utf8")).toMatch(/^@AGENTS\.md$/m);
  });
});
