// Organization references resolve as the web's do (thicket
// apps/web/src/lib/org-ref.ts): the exact slug, then the key a reference
// carries; never a whole-string match on anything but the current slug.
import { describe, expect, it } from "vitest";
import { findOrgByRef, orgRefKey } from "../src/lib/org-ref.js";

describe("orgRefKey", () => {
  it("is the last hyphen-separated segment, or the whole reference", () => {
    expect(orgRefKey("sunshine-energy-llc-un964c")).toBe("un964c");
    expect(orgRefKey("un964c")).toBe("un964c");
    expect(orgRefKey("mccormack-drive-krn1H")).toBe("krn1H");
  });
});

describe("findOrgByRef", () => {
  const orgs = [
    { id: "1", slug: "sunshine-energy-llc-un964c", key: "un964c" },
    { id: "2", slug: "mccormack-drive-krn1H", key: "hghil6tx" },
  ];

  it("finds a workspace by its current slug, an old slug, or the bare key", () => {
    expect(findOrgByRef(orgs, "sunshine-energy-llc-un964c")?.id).toBe("1");
    expect(findOrgByRef(orgs, "old-name-un964c")?.id).toBe("1");
    expect(findOrgByRef(orgs, "un964c")?.id).toBe("1");
  });

  it("finds a pre-July workspace by its slug and by its key, never by its slug's suffix", () => {
    expect(findOrgByRef(orgs, "mccormack-drive-krn1H")?.id).toBe("2");
    expect(findOrgByRef(orgs, "old-name-hghil6tx")?.id).toBe("2");
    expect(findOrgByRef(orgs, "hghil6tx")?.id).toBe("2");
    expect(findOrgByRef(orgs, "other-krn1H")).toBeUndefined();
  });

  it("misses a reference to no workspace in the list", () => {
    expect(findOrgByRef(orgs, "sunshine-energy-llc-zz99yy")).toBeUndefined();
    expect(findOrgByRef([{ id: "3", slug: "acme" }], "old-acme")).toBeUndefined();
  });
});
