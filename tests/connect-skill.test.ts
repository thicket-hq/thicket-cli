// Guard: the thicket-connect skill teaches the connect, setup and run flow,
// and nothing anywhere still teaches the removed listener or the retired
// People > Agents screen.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SKILL = join(ROOT, "skills", "thicket-connect");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const read = (path: string) => readFileSync(path, "utf8");
const frontmatter = (text: string) => text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";

describe("the thicket-connect skill", () => {
  const skill = read(join(SKILL, "SKILL.md"));
  const subagent = read(join(SKILL, "subagent.md"));

  it("its description names the real commands and never the removed listener", () => {
    const head = frontmatter(skill);
    expect(head).toMatch(/^name: thicket-connect$/m);
    expect(head).not.toMatch(/agent watch/);
    for (const command of ["thicket auth agent connect", "thicket connect setup", "thicket connect"]) expect(head).toContain(command);
  });

  it("teaches connect, identity, the three trust modes, setup, and running under a monitor", () => {
    for (const words of [
      "thicket auth agent connect --profile '<profile>'",
      "thicket me --profile '<profile>' --json",
      "**operator**", "**allowlist**", "**project**",
      "thicket connect setup --profile '<profile>'",
      "thicket connect --profile '<profile>'",
      `grep --line-buffered -F '"type":"request"'`,
      "persistent: true",
      "more than a minute",
      "subagent.md",
      "`owner`",
      "My settings > My agent",
      "Admin > Manage agents",
    ]) expect(skill, words).toContain(words);
  });

  it("the subagent guide replies at reply_to as the agent, keeps mentions out of chat, and settles", () => {
    for (const words of ["reply_to", "--profile '<profile>'", "thicket connect settle", "never\n  mention anyone", "default to silence", "**`assigned`**", "**`cheered`**"])
      expect(subagent, words).toContain(words);
  });

  it("the skill, README and install.md say the connector needs Full access, and what Read-only can't do", () => {
    for (const path of [join(SKILL, "SKILL.md"), join(ROOT, "README.md"), join(ROOT, "install.md")]) {
      const text = read(path).replace(/\s+/g, " ");
      expect(text, path).toContain("connector needs Full access");
      expect(text, path).toMatch(/Read-only connection can read through the CLI[^.]*can't[^.]*(listen|never listens)[^.]*repl/);
    }
  });

  it("nothing in the package teaches the removed listener or the retired agents screen, and the copy has no em dashes", () => {
    const scanned = [
      ...["src", "skills", "hooks", ".claude-plugin"].flatMap((dir) => files(join(ROOT, dir))),
      ...["README.md", "install.md", "AGENTS.md"].map((name) => join(ROOT, name)),
    ];
    const stale = scanned.flatMap((path) => read(path).split("\n")
      .filter((line) => /agent watch|People\s*[>›,]\s*Agents/.test(line))
      .map((line) => `${path.slice(ROOT.length + 1)}: ${line.trim()}`));
    expect(stale).toEqual([]);
    const copy = [...files(join(ROOT, "skills")), join(ROOT, "README.md"), join(ROOT, "install.md")];
    const dashes = copy.filter((path) => read(path).includes("—")).map((path) => path.slice(ROOT.length + 1));
    expect(dashes).toEqual([]);
  });
});
