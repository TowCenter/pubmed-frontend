// Pure collection-name <-> URL-slug helpers. No Svelte imports, so both the
// frontend (via src/stores/collectionFilter.js, which re-exports these) and
// the Node build scripts (scripts/export-db.mjs) can use the exact same
// slugging logic without the scripts needing to resolve svelte/store.

/**
 * URL-safe slug for a collection name, used as the path segment:
 * "Creatine" -> "creatine", "E-Cigs" -> "e-cigs",
 * "Hydration + Performance, Fatigue, Sport" -> "hydration-performance-fatigue-sport".
 */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Find the collection (from `list`) whose slug matches, or null. */
export function collectionForSlug(list, slug) {
  if (!slug) return null;
  return list.find((c) => slugify(c) === slug) || null;
}
