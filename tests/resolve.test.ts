import { describe, expect, it } from "vitest";
import { CliError } from "../src/lib/output.js";
import { looksLikeId, matchNamed } from "../src/lib/resolve.js";

const candidates = [
  { id: "1e6b3cbb-0000-4000-8000-000000000001", name: "Website Redesign" },
  { id: "1e6b3cbb-0000-4000-8000-000000000002", name: "Mobile App v2" },
  { id: "1e6b3cbb-0000-4000-8000-000000000003", name: "Marketing Site" },
];

describe("matchNamed", () => {
  it("uuid passthrough", () => {
    expect(looksLikeId("1e6b3cbb-0000-4000-8000-000000000009")).toBe(true);
    expect(
      matchNamed(candidates, "1e6b3cbb-0000-4000-8000-000000000009", "project").id,
    ).toBe("1e6b3cbb-0000-4000-8000-000000000009");
  });

  it("exact, case-insensitive, then substring", () => {
    expect(matchNamed(candidates, "Website Redesign", "project").id).toContain("001");
    expect(matchNamed(candidates, "website redesign", "project").id).toContain("001");
    expect(matchNamed(candidates, "mobile", "project").id).toContain("002");
  });

  it("ambiguity is an error listing candidates", () => {
    try {
      matchNamed(candidates, "M", "project");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("ambiguous");
      expect((err as CliError).message).toContain("Mobile App v2");
    }
  });

  it("a miss suggests near matches", () => {
    try {
      matchNamed(candidates, "Webzite", "project");
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).code).toBe("not_found");
      expect((err as CliError).hint).toContain("Website Redesign");
    }
  });
});
