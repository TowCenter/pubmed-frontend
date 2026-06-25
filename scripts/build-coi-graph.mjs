/**
 * Build-time precompute for the static COI network shown in the graph tab.
 *
 * Tripartite graph  PMID -> author -> org, restricted to the COI subgraph:
 * only authors who disclosed a conflict of interest, the papers those
 * disclosures appear on, and the organizations disclosed.
 *
 * Queries Postgres (source of truth), runs the d3-force layout ONCE here
 * (offline), and bakes x/y into each node — like the map bakes embeddings.
 * The frontend just loads the JSON and renders it (no live sim, no Neo4j).
 *
 * Writes public/coi-graph.json:
 *   nodes: [{ id, label:'Paper'|'Author'|'Org', name, title?, x, y, degree, papers? }]
 *   links: [{ source, target, rel:'AUTHORED'|'DISCLOSED_COI', weight? }]
 *
 * Run:  node --env-file=.env scripts/build-coi-graph.mjs   (npm run build-coi-graph)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide,
} from "d3-force";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "public", "coi-graph.json");

if (!process.env.DB_HOST) {
  console.error("Missing DB_* Postgres credentials in .env.");
  process.exit(1);
}

async function readData() {
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
    const [coi, authorship, authorPapers, authorCites, papers] = await Promise.all([
      // author -> org COI on a specific paper, ';'-split into atomic orgs.
      q(`SELECT name, org, pmid
           FROM (
             SELECT btrim(au.full_name) AS name, btrim(org_part) AS org, a.pmid AS pmid
               FROM author_coi co
               JOIN author au ON au.author_id = co.author_id
               JOIN article a ON a.article_id = co.article_id
               CROSS JOIN LATERAL unnest(string_to_array(co.coi_institution, ';')) AS org_part
              WHERE NULLIF(btrim(au.full_name), '') IS NOT NULL
           ) s
          WHERE NULLIF(s.org, '') IS NOT NULL`),
      // Full authorship (paper -> author) for EVERY paper written by a
      // COI-disclosing author — including that paper's non-COI co-authors. This
      // is the "COI authors' full output" scope: all their papers + co-authors,
      // not just the COI-disclosed ones.
      q(`WITH coi_authors AS (
            SELECT DISTINCT author_id FROM author_coi
          ),
          coi_articles AS (
            SELECT DISTINCT aa.article_id
              FROM article_author aa
              JOIN coi_authors ca ON ca.author_id = aa.author_id
          )
          SELECT a.pmid AS pmid, btrim(au.full_name) AS name
            FROM article_author aa
            JOIN author au ON au.author_id = aa.author_id
            JOIN article a ON a.article_id = aa.article_id
            JOIN coi_articles ca ON ca.article_id = aa.article_id
           WHERE NULLIF(btrim(au.full_name), '') IS NOT NULL`),
      q(`SELECT btrim(au.full_name) AS name, count(DISTINCT aa.article_id)::int AS papers
           FROM article_author aa
           JOIN author au ON au.author_id = aa.author_id
          WHERE NULLIF(btrim(au.full_name), '') IS NOT NULL
          GROUP BY btrim(au.full_name)`),
      // total in-dataset citations to each author's papers
      q(`SELECT btrim(au.full_name) AS name, count(*)::int AS citations
           FROM article_author aa
           JOIN author au ON au.author_id = aa.author_id
           JOIN article_citation c ON c.article_id = aa.article_id
          WHERE NULLIF(btrim(au.full_name), '') IS NOT NULL
          GROUP BY btrim(au.full_name)`),
      q(`SELECT pmid, title FROM article`),
    ]);
    return {
      coi,
      authorship,
      papersByAuthor: new Map(authorPapers.map((r) => [r.name, r.papers])),
      citesByAuthor: new Map(authorCites.map((r) => [r.name, r.citations])),
      titleByPmid: new Map(papers.map((r) => [String(r.pmid), r.title || ""])),
    };
  } finally {
    await pool.end();
  }
}

function buildGraph({ coi, authorship, papersByAuthor, citesByAuthor, titleByPmid }) {
  const aId = (n) => "a:" + n;
  const oId = (n) => "o:" + n;
  const pId = (n) => "p:" + n;
  const nodes = new Map();
  const links = [];
  const coiPair = new Set();    // author|org dedupe (with running weight)
  const coiWeight = new Map();  // author|org -> # papers
  const authored = new Set();   // author|pmid dedupe

  // Which names/pmids carry an actual COI disclosure (vs. plain co-authors and
  // their non-disclosed papers). Used to flag nodes so the UI can distinguish.
  const coiAuthorNames = new Set(coi.map((r) => r.name));
  const coiPmids = new Set(coi.map((r) => String(r.pmid)));
  // (author, paper) pairs where the author actually disclosed a COI on that
  // paper. Marks the AUTHORED edge so the UI can recount COI papers after merges
  // (the graph otherwise can't tell a disclosed paper from a plain co-authorship).
  const disclosedPair = new Set(coi.map((r) => aId(r.name) + "|" + pId(String(r.pmid))));

  const ensureAuthor = (name) => {
    const id = aId(name);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, label: "Author", name,
        papers: papersByAuthor.get(name) || 0, citations: citesByAuthor.get(name) || 0,
        coiOrgs: 0, coiPapers: 0, degree: 0, coi: coiAuthorNames.has(name),
      });
    }
    return nodes.get(id);
  };
  const ensureOrg = (name) => {
    const id = oId(name);
    if (!nodes.has(id)) nodes.set(id, { id, label: "Org", name, degree: 0 });
    return nodes.get(id);
  };
  const ensurePaper = (pmid) => {
    const id = pId(pmid);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, label: "Paper", name: pmid, title: titleByPmid.get(pmid) || "",
        degree: 0, coi: coiPmids.has(pmid),
      });
    }
    return nodes.get(id);
  };

  // 1) Full authorship: paper -> author for every paper by a COI author,
  //    including non-COI co-authors.
  for (const r of authorship) {
    const pmid = String(r.pmid);
    const author = ensureAuthor(r.name);
    const paper = ensurePaper(pmid);
    const aKey = author.id + "|" + paper.id;
    if (!authored.has(aKey)) {
      authored.add(aKey);
      links.push({ source: paper.id, target: author.id, rel: "AUTHORED", coi: disclosedPair.has(aKey) });
      author.degree += 1;
      paper.degree += 1;
    }
  }

  // 2) COI disclosures: author -> org (weighted), plus per-author COI paper count.
  const coiPapersByAuthor = new Map(); // name -> Set(pmid)
  for (const r of coi) {
    const pmid = String(r.pmid);
    const author = ensureAuthor(r.name);
    const org = ensureOrg(r.org);
    ensurePaper(pmid); // normally already created above

    const pairKey = author.id + "|" + org.id;
    coiWeight.set(pairKey, (coiWeight.get(pairKey) || 0) + 1);
    if (!coiPair.has(pairKey)) {
      coiPair.add(pairKey);
      links.push({ source: author.id, target: org.id, rel: "DISCLOSED_COI", weight: 0, _pk: pairKey });
      author.degree += 1;
      author.coiOrgs += 1;
      org.degree += 1;
    }
    if (!coiPapersByAuthor.has(r.name)) coiPapersByAuthor.set(r.name, new Set());
    coiPapersByAuthor.get(r.name).add(pmid);
  }
  for (const [name, set] of coiPapersByAuthor) {
    const a = nodes.get(aId(name));
    if (a) a.coiPapers = set.size;
  }

  for (const l of links) if (l.rel === "DISCLOSED_COI" && l._pk) { l.weight = coiWeight.get(l._pk); delete l._pk; }

  return { nodes: [...nodes.values()], links };
}

function layout(nodes, links) {
  const radius = (n) => 2 + Math.sqrt(n.degree || 1);
  const sim = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-70).theta(0.9))
    .force("link", forceLink(links).id((d) => d.id).distance(30).strength(0.4))
    .force("center", forceCenter(0, 0))
    // collide keeps nodes from overlapping (radius + generous padding)
    .force("collide", forceCollide().radius((d) => radius(d) + 4).iterations(3))
    .stop();
  const ticks = 400;
  for (let i = 0; i < ticks; i++) {
    sim.tick();
    if (i % 40 === 0) process.stdout.write(`\r  layout: ${i}/${ticks}   `);
  }
  process.stdout.write(`\r  layout: ${ticks}/${ticks}   \n`);
}

async function main() {
  console.log("Querying Postgres…");
  const data = await readData();
  const { nodes, links } = buildGraph(data);
  const count = (l) => nodes.filter((n) => n.label === l).length;
  console.log(
    `  ${count("Paper")} papers, ${count("Author")} authors, ${count("Org")} orgs, ${links.length} edges`,
  );

  console.log("Running force layout (offline)…");
  layout(nodes, links);

  const outNodes = nodes.map((n) => ({
    id: n.id, label: n.label, name: n.name, degree: n.degree,
    ...(n.label === "Author" ? { papers: n.papers, citations: n.citations, coiOrgs: n.coiOrgs, coiPapers: n.coiPapers, coi: n.coi } : {}),
    ...(n.label === "Paper" ? { title: n.title, coi: n.coi } : {}),
    x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10,
  }));
  const outLinks = links.map((l) => ({
    source: typeof l.source === "object" ? l.source.id : l.source,
    target: typeof l.target === "object" ? l.target.id : l.target,
    rel: l.rel,
    ...(l.rel === "DISCLOSED_COI" ? { weight: l.weight } : {}),
    ...(l.rel === "AUTHORED" && l.coi ? { coi: true } : {}),
  }));

  fs.writeFileSync(OUT, JSON.stringify({ nodes: outNodes, links: outLinks }));
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
