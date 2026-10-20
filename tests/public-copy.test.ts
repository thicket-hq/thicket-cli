// Guard: this repository, its npm package, its Claude Code plugin and its
// Cursor plugin are public, so everything in them is product copy, code
// comments included.
// Thicket is described by what it does and never names a competitor.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Stored encoded, so the guard never spells out a name itself.
const COMPETITORS = new RegExp(
  ["YmFzZWNhbXA=", "MzdzaWduYWxz"].map((name) => atob(name)).join("|"),
  "i",
);
const ROOT = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("public copy names no competitor", () => {
  it("sources, tests, skills, hooks, plugins, plugin manifests, workflows, and docs", () => {
    const scanned = [
      ...["src", "tests", "skills", "hooks", ".claude-plugin", ".cursor-plugin", "plugins", ".github"].flatMap(
        (dir) => files(join(ROOT, dir)),
      ),
      ...["README.md", "AGENTS.md", "CLAUDE.md", "install.md", "package.json"].map((name) =>
        join(ROOT, name),
      ),
    ].filter((path) => !path.endsWith("public-copy.test.ts") && !path.endsWith(".png"));
    const hits = scanned.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => COMPETITORS.test(line))
        .map((line) => `${path.slice(ROOT.length + 1)}: ${line.trim().slice(0, 120)}`),
    );
    expect(hits).toEqual([]);
  });
});
