/**
 * Shared Postgres → CSV export for the article data.
 *
 * Used by:
 *   - pg-data-plugin.mjs   (vite dev server: GET /api/articles.csv)
 *   - scripts/export-db.mjs (build-time snapshot for GitHub Pages)
 *
 * Keeping the query + flattening in one place so dev and the deployed
 * snapshot can't drift. Connection comes from env (same names as the
 * Python pipeline): DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL_CA
 */

import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';

// Reconstruct the flat, denormalised shape from the relational schema.
// x/y live in article_embedding; authors/keywords/citations are join tables.
// buildSql() below appends a WHERE clause restricting to one collection's
// articles when a collection is requested — the query otherwise looks
// identical.
const SQL_BASE = `
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
    -- Per-author breakdown: every author in order, each with their own disclosed
    -- COI organizations (null when they declared none). Lets the detail card show
    -- COIs against the specific authors that have them.
    (SELECT json_agg(json_build_object(
        'name', au.full_name,
        'coi', (SELECT array_agg(DISTINCT btrim(co.coi_institution))
                  FROM author_coi co
                  WHERE co.article_id = a.article_id
                    AND co.author_id = au.author_id
                    AND NULLIF(btrim(co.coi_institution), '') IS NOT NULL)
      ) ORDER BY aa.author_order)
       FROM article_author aa JOIN author au ON au.author_id = aa.author_id
       WHERE aa.article_id = a.article_id) AS authors_detail,
    (SELECT string_agg(k.keyword_text, '; ')
       FROM article_keyword ak JOIN keyword k ON k.keyword_id = ak.keyword_id
       WHERE ak.article_id = a.article_id) AS keywords,
    (SELECT string_agg(c.citing_pmid, ';')
       FROM article_citation c WHERE c.article_id = a.article_id) AS cited_by_pmids,
    -- Conflict-of-interest: raw disclosure text (for keyword search + detail card)
    (SELECT string_agg(DISTINCT NULLIF(btrim(co."COI_raw_text"), ''), ' | ')
       FROM author_coi co WHERE co.article_id = a.article_id) AS coi,
    -- COI organizations, clean & de-duped (';'-separated so the app can offer
    -- them as selectable categories for "highlight by COI organization")
    (SELECT string_agg(DISTINCT NULLIF(btrim(co.coi_institution), ''), '; ')
       FROM author_coi co WHERE co.article_id = a.article_id) AS coi_org,
    -- Author affiliations (institution names)
    (SELECT string_agg(DISTINCT i.name, '; ')
       FROM author_affiliation af JOIN institution i ON i.institution_id = af.institution_id
       WHERE af.article_id = a.article_id) AS affiliations,
    -- Funding institutions / agencies
    (SELECT string_agg(DISTINCT i.name, '; ')
       FROM article_funding fu JOIN institution i ON i.institution_id = fu.institution_id
       WHERE fu.article_id = a.article_id) AS funding,
    -- Collection(s) this article belongs to (e.g. "E-Cigs", "Creatine"). An
    -- article can be in more than one, so ';'-separated like the other
    -- selectable-category columns (coi_org, affiliations, funding).
    (SELECT string_agg(DISTINCT col.name, '; ' ORDER BY col.name)
       FROM article_collection ac JOIN collection col ON col.collection_id = ac.collection_id
       WHERE ac.article_id = a.article_id) AS collections
  FROM article a
  JOIN article_embedding e ON e.article_id = a.article_id
`;

/** SQL_BASE, restricted to one collection's articles when `collection` is given. */
function buildSql(collection) {
  if (!collection) return { sql: SQL_BASE, params: [] };
  return {
    sql: `${SQL_BASE}
      WHERE EXISTS (
        SELECT 1 FROM article_collection ac JOIN collection col ON col.collection_id = ac.collection_id
        WHERE ac.article_id = a.article_id AND col.name = $1
      )`,
    params: [collection],
  };
}

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

/** Open a pool for one query, run `fn(pool)`, and always close it after. */
async function withPool(fn) {
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
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Names of every collection that has at least one article, e.g. ["Creatine", "E-Cigs"]. */
export async function listCollections() {
  return withPool(async (pool) => {
    const { rows } = await pool.query(`
      SELECT col.name FROM collection col
      WHERE EXISTS (SELECT 1 FROM article_collection ac WHERE ac.collection_id = col.collection_id)
      ORDER BY col.name
    `);
    return rows.map((r) => r.name);
  });
}

/**
 * Query Postgres and return a CSV string with the columns the app expects.
 * Pass `{ collection: "Creatine" }` to restrict to just that collection's
 * articles; omit it for the full (unscoped) set.
 */
export async function buildCsv({ collection } = {}) {
  const { sql, params } = buildSql(collection);
  return withPool(async (pool) => {
    const { rows } = await pool.query(sql, params);
    const out = rows.map((r) => ({
      pmid: r.pmid,
      title: r.title,
      abstract: r.abstract,
      journal: r.journal,
      authors: r.authors,
      authors_detail: r.authors_detail ? JSON.stringify(r.authors_detail) : '',
      keywords: r.keywords,
      coi: r.coi,
      coi_org: r.coi_org,
      affiliations: r.affiliations,
      funding: r.funding,
      collections: r.collections,
      cited_by_pmids: r.cited_by_pmids,
      url: r.pubmed_url,
      date: isoDate(r.publication_year, r.publication_month, r.publication_day),
      x: r.x,
      y: r.y,
    }));
    return Papa.unparse(out); // handles quoting/escaping
  });
}
