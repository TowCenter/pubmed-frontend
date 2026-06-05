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

/** Query Postgres and return a CSV string with the columns the app expects. */
export async function buildCsv() {
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
