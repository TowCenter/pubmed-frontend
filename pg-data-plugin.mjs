/**
 * Vite dev-server plugin: serve article data from RDS / Aurora PostgreSQL.
 *
 * Exposes:  GET /api/articles.csv
 * Returns:  CSV with the exact columns the app's CSV parser expects.
 *
 * Only active during `vite dev` (apply: 'serve'). The production build
 * (GitHub Pages) has no server — there the app loads a static CSV that's
 * exported from the same query at deploy time (see scripts/export-db.mjs,
 * wired up as the `predeploy` npm script).
 *
 * Query + connection live in ./db-export.mjs so dev and the deployed
 * snapshot can't drift.
 */

import { buildCsv } from './db-export.mjs';

export default function pgDataPlugin() {
  let csvCache = null;     // cache the serialised CSV for the dev session
  let inFlight = null;     // dedupe concurrent first-requests so we query once

  return {
    name: 'pg-article-data',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use('/api/articles.csv', async (req, res) => {
        try {
          if (!csvCache) {
            if (!inFlight) {
              console.log('[pg-data] querying PostgreSQL…');
              const t = Date.now();
              inFlight = buildCsv().then((csv) => {
                console.log(`[pg-data] ready (${((Date.now() - t) / 1000).toFixed(1)}s, ${csv.length} bytes)`);
                return csv;
              });
            }
            csvCache = await inFlight;
          }
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.writeHead(200);
          res.end(csvCache);
        } catch (e) {
          console.error('[pg-data] error:', e.message);
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(e.message) }));
        }
      });
    },
  };
}
