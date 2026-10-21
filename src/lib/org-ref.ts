// Organization references, as the web resolves them (thicket
// apps/web/src/lib/org-ref.ts; docs/org-key-plan-2026-10-21.md D4, D9): a
// workspace's identity is its id or its permanent key, and a slug is only
// for building paths. A rename regenerates the slug, and every address that
// ever named the workspace keeps naming it through the key it carries.

/**
 * The key an organization reference carries: the last hyphen-separated
 * segment of a slug, or the whole reference when it has no hyphen, so
 * `un964c` names the same workspace as `sunshine-energy-llc-un964c`.
 * Nothing here says the segment IS a key; a pre-July workspace keeps a slug
 * whose suffix is not its key (`mccormack-drive-krn1H`, key `hghil6tx`).
 */
export function orgRefKey(ref: string): string {
  const at = ref.lastIndexOf("-");
  return at === -1 ? ref : ref.slice(at + 1);
}

/**
 * The organization a reference names, inside the caller's own list: the
 * exact slug, then the key the reference carries. The web also tries a
 * pre-July workspace's slug from before its rename, which /authorization
 * does not list; CliContext.membershipFor asks the server for that one.
 */
export function findOrgByRef<T extends { slug: string; key?: string }>(
  orgs: readonly T[],
  ref: string,
): T | undefined {
  const bySlug = orgs.find((o) => o.slug === ref);
  if (bySlug) return bySlug;
  const key = orgRefKey(ref);
  return orgs.find((o) => o.key !== undefined && o.key === key);
}
