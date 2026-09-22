import { slugify } from "./collectionSlug.js";

/**
 * Resolve the article CSV's URL — always scoped to one collection, since the
 * app never fetches the full, unscoped set. Query params (url | filename
 * [+ bucket]) are explicit escape hatches for pointing at arbitrary data and
 * bypass collection scoping entirely; the default path (dev's live query
 * endpoint, or prod's static per-collection export) is scoped by `collection`.
 * Pure — `search` and `env` are passed in explicitly (callers pass
 * `window.location.search` / `import.meta.env`) rather than read from
 * globals here, so this stays trivially testable.
 */
export function resolveDataUrl(search, env, collection) {
  try {
    const params = new URLSearchParams(search);
    const directUrl = params.get("url");
    const filename = params.get("filename");
    const bucket = params.get("bucket");

    // Highest priority: full URL provided
    if (directUrl && /^https?:\/\//i.test(directUrl)) return directUrl;

    // Build from filename and (optional) bucket
    if (filename) {
      // Determine base from bucket param or env
      let base = "";
      if (bucket) {
        if (/^https?:\/\//i.test(bucket)) {
          base = bucket;
        } else if (bucket.includes(".")) {
          // Looks like a host (e.g. my-bucket.s3.amazonaws.com or custom domain)
          base = `https://${bucket}`;
        } else {
          // Treat as bare S3 bucket name
          base = `https://${bucket}.s3.amazonaws.com`;
        }
      } else {
        // Env-configured default base (e.g. https://my-bucket.s3.amazonaws.com/)
        base = env.VITE_S3_BASE_URL || env.VITE_DATA_BASE_URL || "https://pink-slime-public.s3.amazonaws.com/";
      }
      if (base && !base.endsWith("/")) base += "/";
      return base ? base + filename : filename;
    }

    const slug = slugify(collection);
    // Dev: the live-query endpoint, scoped via a query param.
    if (env.VITE_DATA_URL) return `${env.VITE_DATA_URL}?collection=${slug}`;
    // Prod: the static per-collection export (use root path so it works with base path).
    return `${env.BASE_URL || "/"}data-with-xy-${slug}.csv`;
  } catch (e) {
    console.warn("Failed to resolve data URL from query params:", e);
    const slug = slugify(collection);
    return env.VITE_DATA_URL
      ? `${env.VITE_DATA_URL}?collection=${slug}`
      : `${env.BASE_URL || "/"}data-with-xy-${slug}.csv`;
  }
}

/** Resolve the lightweight collections-list URL (dev API, or prod static JSON). */
export function resolveCollectionsUrl(env) {
  return env.VITE_COLLECTIONS_URL || `${env.BASE_URL || "/"}collections.json`;
}
