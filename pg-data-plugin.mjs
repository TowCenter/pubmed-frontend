/**
 * Vite dev-server plugin: serve article data from RDS / Aurora PostgreSQL.
 *
 * Exposes:
 *   GET /api/collections     -> JSON array of collection names with articles
 *   GET /api/articles.csv?collection=<slug>
 *                             -> CSV for just that collection (required —
 *                                the app never fetches the full, unscoped set)
 *
 * Only active during `vite dev` (apply: 'serve'). The production build
 * (GitHub Pages) has no server — there the app loads static files exported
 * from the same queries at deploy time (see scripts/export-db.mjs, wired up
 * as the `predeploy` npm script).
 *
 * Query + connection live in ./db-export.mjs so dev and the deployed
 * snapshot can't drift.
 */

import { buildCsv, listCollections } from './db-export.mjs';
import { collectionForSlug } from './src/lib/collectionSlug.js';

export default function pgDataPlugin() {
  let collectionsCache = null; // cache the collection-name list for the dev session
  let collectionsInFlight = null;
  const csvCache = new Map();     // slug -> CSV string, one entry per collection
  const csvInFlight = new Map();  // slug -> in-flight query promise (dedupe concurrent requests)

  async function getCollections() {
    if (!collectionsCache) {
      if (!collectionsInFlight) collectionsInFlight = listCollections();
      collectionsCache = await collectionsInFlight;
    }
    return collectionsCache;
  }

  return {
    name: 'pg-article-data',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use('/api/collections', async (req, res) => {
        try {
          const collections = await getCollections();
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(collections));
        } catch (e) {
          console.error('[pg-data] error:', e.message);
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(e.message) }));
        }
      });

      server.middlewares.use('/api/articles.csv', async (req, res) => {
        try {
          const qIndex = req.url.indexOf('?');
          const params = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex) : '');
          const slug = params.get('collection') || '';
          if (!slug) throw new Error('Missing required ?collection= query param');

          const collections = await getCollections();
          const collection = collectionForSlug(collections, slug);
          if (!collection) throw new Error(`Unknown collection slug "${slug}"`);

          if (!csvCache.has(slug)) {
            if (!csvInFlight.has(slug)) {
              console.log(`[pg-data] querying PostgreSQL (${collection})…`);
              const t = Date.now();
              csvInFlight.set(
                slug,
                buildCsv({ collection }).then((csv) => {
                  console.log(`[pg-data] ready (${((Date.now() - t) / 1000).toFixed(1)}s, ${csv.length} bytes)`);
                  return csv;
                }),
              );
            }
            csvCache.set(slug, await csvInFlight.get(slug));
          }
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.writeHead(200);
          res.end(csvCache.get(slug));
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
