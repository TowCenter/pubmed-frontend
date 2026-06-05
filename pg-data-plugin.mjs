/**
 * Vite dev-server plugin: serve article data from RDS / Aurora PostgreSQL.
 *
 * Exposes:  GET /api/articles.csv
 * Returns:  CSV with the exact columns the app's CSV parser expects
 *           (x, y, date, pmid, title, abstract, authors, journal,
 *            keywords, cited_by_pmids, url) — so no client changes needed.
 *
 * Only active during `vite dev` (apply: 'serve'). The production build
 * (GitHub Pages) has no server, so point it at a static CSV there instead.
 *
 * Connection comes from .env (same names as the Python pipeline):
 *   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL_CA
 * Works for both RDS PostgreSQL and Aurora PostgreSQL.
 */

import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';

// Reconstruct the flat, denormalised shape from the relational schema.
// x/y live in article_embedding; authors/keywords/citations are join tables.
const SQL = `
  SELECT
    a.pmid,
    a.title,
    a.abstract,
    a.journal,
    a.publication_year,
    a.publication_month,
    a.publication_day,
    a.pubmed_url,
    e.x,
    e.y,
    (SELECT string_agg(au.full_name, '; ' ORDER BY aa.author_order)
       FROM article_author aa JOIN author au ON au.author_id = aa.author_id
       WHERE aa.article_id = a.article_id) AS authors,
    (SELECT string_agg(k.keyword_text, '; ')
       FROM article_keyword ak JOIN keyword k ON k.keyword_id = ak.keyword_id
       WHERE ak.article_id = a.article_id) AS keywords,
    (SELECT string_agg(c.citing_pmid, ';')
       FROM article_citation c WHERE c.article_id = a.article_id) AS cited_by_pmids,
    -- Conflict-of-interest disclosure text + the institution behind the COI
    concat_ws(' | ',
      (SELECT string_agg(DISTINCT NULLIF(btrim(co."COI_raw_text"), ''), ' | ')
         FROM author_coi co WHERE co.article_id = a.article_id),
      (SELECT string_agg(DISTINCT NULLIF(btrim(co.coi_institution), ''), ' | ')
         FROM author_coi co WHERE co.article_id = a.article_id)
    ) AS coi,
    -- Author affiliations (institution names)
    (SELECT string_agg(DISTINCT i.name, '; ')
       FROM author_affiliation af JOIN institution i ON i.institution_id = af.institution_id
       WHERE af.article_id = a.article_id) AS affiliations,
    -- Funding institutions / agencies
    (SELECT string_agg(DISTINCT i.name, '; ')
       FROM article_funding fu JOIN institution i ON i.institution_id = fu.institution_id
       WHERE fu.article_id = a.article_id) AS funding
  FROM article a
  JOIN article_embedding e ON e.article_id = a.article_id
`;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Build an ISO YYYY-MM-DD that `new Date()` parses, from messy parts. */
function isoDate(year, month, day) {
  if (year == null || `${year}`.trim() === '') return '';
  const y = parseInt(`${year}`, 10);
  if (Number.isNaN(y)) return '';
  let mo = 1;
  const m = `${month ?? ''}`.trim().toLowerCase();
  if (m) {
    if (MONTHS[m.slice(0, 3)]) mo = MONTHS[m.slice(0, 3)];
    else if (/^\d+$/.test(m)) mo = Math.min(12, Math.max(1, parseInt(m, 10)));
  }
  let da = 1;
  const d = `${day ?? ''}`.trim();
  if (/^\d+$/.test(d)) da = Math.min(31, Math.max(1, parseInt(d, 10)));
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

export default function pgDataPlugin() {
  let csvCache = null;     // cache the serialised CSV for the dev session
  let inFlight = null;     // dedupe concurrent first-requests so we query once

  async function buildCsv() {
    const { default: pg } = await import('pg');
    const caPath = process.env.DB_SSL_CA || 'global-bundle.pem';
    const ca = fs.readFileSync(path.resolve(caPath), 'utf8');

    const pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { ca, rejectUnauthorized: true }, // verify cert against RDS CA bundle
    });

    try {
      const { rows } = await pool.query(SQL);
      const out = rows.map((r) => ({
        pmid: r.pmid,
        title: r.title,
        abstract: r.abstract,
        journal: r.journal,
        authors: r.authors,
        keywords: r.keywords,
        coi: r.coi,
        affiliations: r.affiliations,
        funding: r.funding,
        cited_by_pmids: r.cited_by_pmids,
        url: r.pubmed_url,
        date: isoDate(r.publication_year, r.publication_month, r.publication_day),
        x: r.x,
        y: r.y,
      }));
      return Papa.unparse(out); // handles quoting/escaping
    } finally {
      await pool.end();
    }
  }

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
