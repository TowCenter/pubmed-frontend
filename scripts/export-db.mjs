/**
 * Build-time snapshot: export the article data from Postgres to a static CSV
 * that GitHub Pages can serve.
 *
 * Run with Node's --env-file so DB_* creds load from .env:
 *   node --env-file=.env scripts/export-db.mjs
 * (wired up as `npm run export-data`, invoked automatically by `predeploy`).
 *
 * Writes public/data-with-xy.csv — the file the production build loads.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCsv } from '../db-export.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'data-with-xy.csv');

console.error('[export-db] querying PostgreSQL…');
const t = Date.now();
const csv = await buildCsv();
fs.writeFileSync(OUT, csv);
console.error(
  `[export-db] wrote ${path.relative(process.cwd(), OUT)} ` +
  `(${csv.length} bytes, ${((Date.now() - t) / 1000).toFixed(1)}s)`
);
