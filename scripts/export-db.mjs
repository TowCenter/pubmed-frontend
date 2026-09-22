/**
 * Build-time snapshot: export the article data from Postgres to static files
 * that GitHub Pages can serve. The app never fetches an unscoped, all-
 * collections file — so this writes one CSV per collection, plus the
 * lightweight list of collection names the picker/gate reads before any of
 * that data loads.
 *
 * Run with Node's --env-file so DB_* creds load from .env:
 *   node --env-file=.env scripts/export-db.mjs
 * (wired up as `npm run export-data`, invoked automatically by `predeploy`).
 *
 * Writes:
 *   public/collections.json                  — ["Creatine", "E-Cigs", ...]
 *   public/data-with-xy-<slug>.csv (per collection) — the files MapView loads
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCsv, listCollections } from '../db-export.mjs';
import { slugify } from '../src/lib/collectionSlug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public');

console.error('[export-db] querying collection list…');
const collections = await listCollections();
fs.writeFileSync(path.join(OUT_DIR, 'collections.json'), JSON.stringify(collections));
console.error(`[export-db] wrote collections.json (${collections.length} collections)`);

for (const name of collections) {
  console.error(`[export-db] querying PostgreSQL (${name})…`);
  const t = Date.now();
  const csv = await buildCsv({ collection: name });
  const out = path.join(OUT_DIR, `data-with-xy-${slugify(name)}.csv`);
  fs.writeFileSync(out, csv);
  console.error(
    `[export-db] wrote ${path.relative(process.cwd(), out)} ` +
    `(${csv.length} bytes, ${((Date.now() - t) / 1000).toFixed(1)}s)`
  );
}
