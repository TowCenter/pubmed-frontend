/**
 * ETL — load the PMID <> author <> organization graph into Neo4j Aura,
 * straight from the source-of-truth Postgres (RDS/Aurora). No CSV involved.
 *
 * Reads the normalized relational schema directly (same DB the app/dev server
 * use) and bulk-writes to Neo4j with batched UNWIND/MERGE, so it's idempotent
 * and safe to re-run.
 *
 * Graph model:
 *   (:Paper  {pmid, title, journal, date, url})
 *   (:Author {name})
 *   (:Org    {name})
 *   (:Author)-[:AUTHORED]->(:Paper)
 *   (:Author)-[:DISCLOSED_COI {papers, pmids}]->(:Org)
 *   (:Paper)-[:FUNDED_BY]->(:Org)
 *   (:Paper)-[:CITES]->(:Paper)        // only between papers in this dataset
 *
 * Env (from .env):
 *   Postgres:  DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL_CA
 *   Neo4j:     NEO4J_URI NEO4J_USERNAME NEO4J_PASSWORD
 * Run:   npm run load-neo4j            (clears + reloads)
 *        node --env-file=.env scripts/load-neo4j.mjs --keep   (no wipe)
 */
import fs from "node:fs";
import path from "node:path";
import neo4j from "neo4j-driver";

const BATCH = 1000;
const WIPE = !process.argv.includes("--keep");

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
if (!NEO4J_URI || !NEO4J_PASSWORD) {
  console.error(
    "Missing NEO4J_URI / NEO4J_PASSWORD. Paste your Aura credentials into .env, " +
      "then run with: npm run load-neo4j",
  );
  process.exit(1);
}
if (!process.env.DB_HOST) {
  console.error("Missing DB_* Postgres credentials in .env.");
  process.exit(1);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Build an ISO YYYY-MM-DD from messy parts (mirrors db-export.mjs). */
function isoDate(year, month, day) {
  if (year == null || `${year}`.trim() === "") return "";
  const y = parseInt(`${year}`, 10);
  if (Number.isNaN(y)) return "";
  let mo = 1;
  const m = `${month ?? ""}`.trim().toLowerCase();
  if (m) {
    if (MONTHS[m.slice(0, 3)]) mo = MONTHS[m.slice(0, 3)];
    else if (/^\d+$/.test(m)) mo = Math.min(12, Math.max(1, parseInt(m, 10)));
  }
  let da = 1;
  const d = `${day ?? ""}`.trim();
  if (/^\d+$/.test(d)) da = Math.min(31, Math.max(1, parseInt(d, 10)));
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

/** Query Postgres for every slice of the graph. */
async function readPostgres() {
  const { default: pg } = await import("pg");
  const caPath = process.env.DB_SSL_CA || "global-bundle.pem";
  const ca = fs.readFileSync(path.resolve(caPath), "utf8");
  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { ca, rejectUnauthorized: true },
  });

  try {
    const q = (sql) => pool.query(sql).then((r) => r.rows);

    const [paperRows, authorRows, authored, coi, funded, citesRaw] = await Promise.all([
      q(`SELECT a.pmid, a.title, a.journal, a.pubmed_url AS url,
                a.publication_year AS y, a.publication_month AS m, a.publication_day AS d
           FROM article a`),
      q(`SELECT DISTINCT btrim(full_name) AS name FROM author
           WHERE NULLIF(btrim(full_name), '') IS NOT NULL`),
      q(`SELECT btrim(au.full_name) AS name, a.pmid
           FROM article_author aa
           JOIN author au ON au.author_id = aa.author_id
           JOIN article a ON a.article_id = aa.article_id
          WHERE NULLIF(btrim(au.full_name), '') IS NOT NULL`),
      // coi_institution is often a ';'-packed list ("Pfizer; J&J"); split it so
      // each organization becomes its own atomic Org node.
      q(`SELECT name, org,
                array_agg(DISTINCT pmid) AS pmids, count(DISTINCT pmid)::int AS papers
           FROM (
             SELECT btrim(au.full_name) AS name,
                    btrim(org_part)     AS org,
                    a.pmid              AS pmid
               FROM author_coi co
               JOIN author au ON au.author_id = co.author_id
               JOIN article a ON a.article_id = co.article_id
               CROSS JOIN LATERAL unnest(string_to_array(co.coi_institution, ';')) AS org_part
              WHERE NULLIF(btrim(au.full_name), '') IS NOT NULL
           ) s
          WHERE NULLIF(s.org, '') IS NOT NULL
          GROUP BY name, org`),
      q(`SELECT a.pmid, btrim(org_part) AS org
           FROM article_funding fu
           JOIN institution i ON i.institution_id = fu.institution_id
           JOIN article a ON a.article_id = fu.article_id
           CROSS JOIN LATERAL unnest(string_to_array(i.name, ';')) AS org_part
          WHERE NULLIF(btrim(org_part), '') IS NOT NULL`),
      q(`SELECT btrim(c.citing_pmid) AS citing, a.pmid
           FROM article_citation c
           JOIN article a ON a.article_id = c.article_id
          WHERE NULLIF(btrim(c.citing_pmid), '') IS NOT NULL`),
    ]);

    const papers = paperRows.map((r) => ({
      pmid: String(r.pmid),
      title: r.title || "",
      journal: r.journal || "",
      url: r.url || "",
      date: isoDate(r.y, r.m, r.d),
    }));

    // Orgs come from both COI disclosures and funding.
    const orgNames = new Set();
    for (const r of coi) orgNames.add(r.org);
    for (const r of funded) orgNames.add(r.org);

    // CITES only between papers we actually have (no external stub nodes).
    const known = new Set(papers.map((p) => p.pmid));
    const cites = citesRaw
      .map((r) => ({ citing: String(r.citing), pmid: String(r.pmid) }))
      .filter((r) => known.has(r.citing) && known.has(r.pmid));

    return {
      papers,
      authors: authorRows.map((r) => ({ name: r.name })),
      orgs: [...orgNames].map((name) => ({ name })),
      authored: authored.map((r) => ({ name: r.name, pmid: String(r.pmid) })),
      coi: coi.map((r) => ({ name: r.name, org: r.org, papers: r.papers, pmids: r.pmids.map(String) })),
      funded: funded.map((r) => ({ pmid: String(r.pmid), org: r.org })),
      cites,
    };
  } finally {
    await pool.end();
  }
}

/** Write `rows` to Neo4j in batches using the given UNWIND statement. */
async function loadBatched(session, label, rows, cypher) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await session.run(cypher, { batch: rows.slice(i, i + BATCH) });
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}   `);
  }
  if (rows.length) process.stdout.write("\n");
  else console.log(`  ${label}: 0`);
}

async function main() {
  console.log("Querying Postgres…");
  const g = await readPostgres();
  console.log(
    `  ${g.papers.length} papers, ${g.authors.length} authors, ${g.orgs.length} orgs | ` +
      `${g.authored.length} AUTHORED, ${g.coi.length} DISCLOSED_COI, ` +
      `${g.funded.length} FUNDED_BY, ${g.cites.length} CITES`,
  );

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME || "neo4j", NEO4J_PASSWORD));
  const session = driver.session();
  try {
    await driver.getServerInfo();
    console.log(`Connected to ${NEO4J_URI}`);

    if (WIPE) {
      console.log("Wiping existing graph (--keep to skip)…");
      let deleted;
      do {
        const res = await session.run(
          "MATCH (n) WITH n LIMIT 10000 DETACH DELETE n RETURN count(n) AS c",
        );
        deleted = res.records[0].get("c").toNumber();
      } while (deleted > 0);
    }

    console.log("Creating constraints…");
    await session.run("CREATE CONSTRAINT paper_pmid IF NOT EXISTS FOR (p:Paper) REQUIRE p.pmid IS UNIQUE");
    await session.run("CREATE CONSTRAINT author_name IF NOT EXISTS FOR (a:Author) REQUIRE a.name IS UNIQUE");
    await session.run("CREATE CONSTRAINT org_name IF NOT EXISTS FOR (o:Org) REQUIRE o.name IS UNIQUE");

    console.log("Loading nodes…");
    await loadBatched(session, "Paper", g.papers,
      `UNWIND $batch AS r
       MERGE (p:Paper {pmid: r.pmid})
       SET p.title = r.title, p.journal = r.journal, p.date = r.date, p.url = r.url`);
    await loadBatched(session, "Author", g.authors,
      `UNWIND $batch AS r MERGE (:Author {name: r.name})`);
    await loadBatched(session, "Org", g.orgs,
      `UNWIND $batch AS r MERGE (:Org {name: r.name})`);

    console.log("Loading relationships…");
    await loadBatched(session, "AUTHORED", g.authored,
      `UNWIND $batch AS r
       MATCH (a:Author {name: r.name}), (p:Paper {pmid: r.pmid})
       MERGE (a)-[:AUTHORED]->(p)`);
    await loadBatched(session, "DISCLOSED_COI", g.coi,
      `UNWIND $batch AS r
       MATCH (a:Author {name: r.name}), (o:Org {name: r.org})
       MERGE (a)-[c:DISCLOSED_COI]->(o)
       SET c.papers = r.papers, c.pmids = r.pmids`);
    await loadBatched(session, "FUNDED_BY", g.funded,
      `UNWIND $batch AS r
       MATCH (p:Paper {pmid: r.pmid}), (o:Org {name: r.org})
       MERGE (p)-[:FUNDED_BY]->(o)`);
    await loadBatched(session, "CITES", g.cites,
      `UNWIND $batch AS r
       MATCH (c:Paper {pmid: r.citing}), (p:Paper {pmid: r.pmid})
       MERGE (c)-[:CITES]->(p)`);

    console.log("Done.");
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("\nLoad failed:", err.message);
  process.exit(1);
});
