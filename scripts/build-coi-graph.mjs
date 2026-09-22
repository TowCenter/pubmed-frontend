/**
 * Build-time precompute for the static COI network shown in the graph tab.
 *
 * Tripartite graph  PMID -> author -> org, covering every paper/author in the
 * database (the entire universe, not just the COI-connected subset) plus the
 * organizations disclosed. Paper/Author nodes carry `coi: true|false` marking
 * whether they actually carry a disclosure, so the frontend can still tell
 * disclosed from plain co-authorship — it just no longer hides the latter.
 *
 * Queries Postgres (source of truth), runs the d3-force layout ONCE here
 * (offline), and bakes x/y into each node — like the map bakes embeddings.
 * The frontend just loads the JSON and renders it (no live sim, no Neo4j).
 *
 * Writes two files instead of one big one, so the frontend's first paint only
 * has to fetch/parse the small one:
 *   public/coi-graph-core.json     — the COI-disclosing subgraph (the part
 *     that's actually force-laid-out below, and the only part the default
 *     overview renders). A few MB.
 *   public/coi-graph-extended.json — everyone else: the much larger
 *     non-disclosing long tail, positioned with a random seed (never force-
 *     laid-out) since it's only ever a starting point for search/focus, not
 *     something shown by default. Tens of MB — fetched lazily by GraphView
 *     in the background after the core has already rendered.
 * Both share the same shape:
 *   nodes: [{ id, label:'Paper'|'Author'|'Org', name, title?, x, y, degree, papers?, collections? }]
 *   links: [{ source, target, rel:'AUTHORED'|'DISCLOSED_COI', weight? }]
 * `collections` (Paper nodes only) lists which collection(s) — e.g. "E-Cigs",
 * "Creatine" — that paper belongs to, so the frontend can filter the graph
 * down to one collection at a time.
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
const OUT_CORE = path.resolve(__dirname, "..", "public", "coi-graph-core.json");
const OUT_EXTENDED = path.resolve(__dirname, "..", "public", "coi-graph-extended.json");

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
    const [coi, authorship, authorPapers, authorCites, papers, articleCollections] = await Promise.all([
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
      // Full authorship (paper -> author) for EVERY paper in the database —
      // the entire universe of PMIDs/authors, not just the ones connected to a
      // COI disclosure. DISCLOSED_COI edges (below) still only exist where an
      // actual disclosure was made; this just makes sure every paper/author is
      // present as a node so the graph isn't silently missing anyone.
      q(`SELECT a.pmid AS pmid, btrim(au.full_name) AS name
           FROM article_author aa
           JOIN author au ON au.author_id = aa.author_id
           JOIN article a ON a.article_id = aa.article_id
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
      // Which collection(s) (e.g. "E-Cigs", "Creatine") each paper belongs to —
      // lets the frontend filter the graph down to one collection at a time.
      q(`SELECT a.pmid AS pmid, col.name AS collection
           FROM article_collection ac
           JOIN article a ON a.article_id = ac.article_id
           JOIN collection col ON col.collection_id = ac.collection_id`),
    ]);
    const collectionsByPmid = new Map();
    for (const r of articleCollections) {
      const pmid = String(r.pmid);
      if (!collectionsByPmid.has(pmid)) collectionsByPmid.set(pmid, []);
      collectionsByPmid.get(pmid).push(r.collection);
    }
    return {
      coi,
      authorship,
      papersByAuthor: new Map(authorPapers.map((r) => [r.name, r.papers])),
      citesByAuthor: new Map(authorCites.map((r) => [r.name, r.citations])),
      titleByPmid: new Map(papers.map((r) => [String(r.pmid), r.title || ""])),
      collectionsByPmid,
    };
  } finally {
    await pool.end();
  }
}

function buildGraph({ coi, authorship, papersByAuthor, citesByAuthor, titleByPmid, collectionsByPmid }) {
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
        degree: 0, coi: coiPmids.has(pmid), collections: collectionsByPmid.get(pmid) || [],
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

// Layout collision footprint per node (degree-scaled). The renderer sizes the
// drawn dots from this exact radius so they can never overlap on screen.
export const collideRadius = (n) => 6 + 2.2 * Math.sqrt(n.degree || 1);

function layout(nodes, links) {
  // Collision-dominated pack: modest repulsion + a strong, many-iteration
  // collide force so nodes settle into a tight, non-overlapping arrangement
  // (rather than a sparse cloud where fit-to-screen makes dots invisible).
  const sim = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-90).theta(0.9).distanceMax(1500))
    .force("link", forceLink(links).id((d) => d.id).distance(36).strength(0.5))
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide().radius((d) => collideRadius(d) + 2).iterations(8))
    .stop();
  const ticks = 600;
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

  // The overview emphasizes the COI-dense core (and the focus view re-runs its
  // own layout when you select a node), so lay out just the COI-disclosing
  // nodes here — otherwise the much larger non-COI universe would pull them
  // into a single central blob. Non-COI nodes get a small random seed (their
  // position is only ever a starting point for focus/search, not final layout).
  console.log("Running force layout for the COI overview (offline)…");
  const coreIds = new Set(nodes.filter((n) => n.coi !== false).map((n) => n.id));
  const coreNodes = nodes.filter((n) => coreIds.has(n.id));
  // Partition BEFORE layout(), not after: forceLink() (inside layout) mutates
  // each link object's source/target from an id string into a node object
  // reference, in place. coreLinks/extendedLinks are just filtered views over
  // the same underlying link objects, so if extendedLinks were computed after
  // layout(), every core link's now-mutated (object, not string) source/target
  // would silently fail the `coreIds.has(...)` check and get re-included in
  // "extended" too — duplicating ~38k edges across both files. Computing both
  // partitions here, while every source/target is still a plain string, keeps
  // them genuinely disjoint.
  const coreLinks = links.filter((l) => coreIds.has(l.source) && coreIds.has(l.target));
  const extendedLinks = links.filter((l) => !coreIds.has(l.source) || !coreIds.has(l.target));
  layout(coreNodes, coreLinks);
  for (const n of nodes) {
    if (coreIds.has(n.id)) continue;
    n.x = (Math.random() - 0.5) * 50;
    n.y = (Math.random() - 0.5) * 50;
  }

  const toOutNode = (n) => ({
    id: n.id, label: n.label, name: n.name, degree: n.degree,
    ...(n.label === "Author" ? { papers: n.papers, citations: n.citations, coiOrgs: n.coiOrgs, coiPapers: n.coiPapers, coi: n.coi } : {}),
    ...(n.label === "Paper" ? { title: n.title, coi: n.coi, collections: n.collections } : {}),
    x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10,
  });
  const toOutLink = (l) => ({
    source: typeof l.source === "object" ? l.source.id : l.source,
    target: typeof l.target === "object" ? l.target.id : l.target,
    rel: l.rel,
    ...(l.rel === "DISCLOSED_COI" ? { weight: l.weight } : {}),
    ...(l.rel === "AUTHORED" && l.coi ? { coi: true } : {}),
  });

  // Partition nodes/links into core (COI-disclosing, force-laid-out above)
  // and extended (everyone else). A link goes to "core" only if BOTH ends are
  // core (exactly `coreLinks` above); every other link — including ones that
  // bridge a core node to a non-core one — goes to "extended". That's a clean
  // partition (each link in exactly one file), so concatenating
  // core.nodes+extended.nodes and core.links+extended.links reconstructs the
  // exact same full graph as the old single-file output, with no duplication.
  const write = (file, obj) => {
    fs.writeFileSync(file, JSON.stringify(obj));
    console.log(`Wrote ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  };
  write(OUT_CORE, { nodes: coreNodes.map(toOutNode), links: coreLinks.map(toOutLink) });
  write(OUT_EXTENDED, {
    nodes: nodes.filter((n) => !coreIds.has(n.id)).map(toOutNode),
    links: extendedLinks.map(toOutLink),
  });
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
