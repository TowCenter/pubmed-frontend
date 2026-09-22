// Pure graph-shaping functions for the COI network: combining merged variant
// nodes, and narrowing the node/link set down to a subset of papers (by
// collection, or by whatever the Semantic map currently has active). All
// operate on plain { nodes, links } arrays — no Svelte/component state.
import { ALL_COLLECTIONS } from "../stores/collectionFilter.js";

// --- apply merges: collapse member nodes into one canonical node ------------
export function applyMerges(nodesIn, linksIn, groups) {
  if (!groups.length) return { nodes: nodesIn, links: linksIn };
  const memberToGroup = new Map();
  for (const g of groups) for (const m of g.members) memberToGroup.set(m, g);
  const canon = (id) => memberToGroup.get(id)?.id ?? id;
  const byId = new Map(nodesIn.map((n) => [n.id, n]));

  const out = new Map();
  for (const n of nodesIn) {
    if (memberToGroup.has(n.id)) continue; // folded into a canonical node
    out.set(n.id, { ...n }); // clone — positions get relaxed in the canvas
  }
  for (const g of groups) {
    const members = g.members.map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const label = members[0].label;
    const cx = members.reduce((s, m) => s + (m.x || 0), 0) / members.length;
    const cy = members.reduce((s, m) => s + (m.y || 0), 0) / members.length;
    const node = { id: g.id, label, name: g.name, x: cx, y: cy, degree: 0, merged: members.length };
    if (label === "Author") {
      // citations is a baked per-name total; take the max across variants
      // (same person, so summing would double-count). papers/coiOrgs/coiPapers
      // are recomputed from the merged, deduped edges below (so shared papers
      // across variants are counted once).
      node.citations = Math.max(0, ...members.map((m) => m.citations || 0));
      node.papers = 0;
      node.coiOrgs = 0;
      node.coiPapers = 0;
    } else if (label === "Paper") {
      node.title = members[0].title;
    }
    out.set(g.id, node);
  }

  // Remap + dedupe links (sum COI weights, OR the disclosed flag, drop
  // self-loops from the merge).
  const lmap = new Map();
  for (const l of linksIn) {
    const s = canon(l.source),
      t = canon(l.target);
    if (s === t) continue;
    const key = l.rel + "|" + s + "|" + t;
    const ex = lmap.get(key);
    if (ex) {
      if (l.rel === "DISCLOSED_COI") ex.weight = (ex.weight || 0) + (l.weight || 0);
      if (l.rel === "AUTHORED" && l.coi) ex.coi = true;
    } else {
      lmap.set(key, {
        source: s,
        target: t,
        rel: l.rel,
        ...(l.rel === "DISCLOSED_COI" ? { weight: l.weight || 0 } : {}),
        ...(l.rel === "AUTHORED" ? { coi: !!l.coi } : {}),
      });
    }
  }
  const links = [...lmap.values()];

  // Merging changes neighbors' edge counts (deduped variants), so recompute
  // all edge-derived fields from scratch — reset to 0 first, otherwise the
  // cloned non-merged nodes would double-count on top of their baked values.
  for (const n of out.values()) {
    n.degree = 0;
    if (n.label === "Author") {
      n.coiOrgs = 0;
      n.coiPapers = 0;
    }
  }
  for (const l of links) {
    const s = out.get(l.source),
      t = out.get(l.target);
    if (s) s.degree++;
    if (t) t.degree++;
    if (l.rel === "DISCLOSED_COI" && s && s.label === "Author") s.coiOrgs++;
    if (l.rel === "AUTHORED" && t && t.label === "Author") {
      // total papers is only recomputed for merged authors (a co-author's
      // baked DB total can exceed their in-graph papers); coiPapers counts
      // only papers the author actually disclosed on.
      if (t.merged) t.papers++;
      if (l.coi) t.coiPapers++;
    }
  }
  return { nodes: [...out.values()], links };
}

// --- narrow to a subset of papers ---------------------------------------
// Shared machinery for both the collection scope and the map's filters
// below: given a predicate over Paper nodes, keep those papers, the authors
// who wrote any of them (with their full COI-org disclosures, same "full
// authorship" scope the unfiltered graph already uses), and the orgs those
// authors disclosed. Positions stay baked (no re-layout); degree and COI
// counts are recomputed from the surviving edges, same approach as
// applyMerges above.
export function filterGraphByPapers(nodesIn, linksIn, keepPaper) {
  const keepPaperIds = new Set(
    nodesIn.filter((n) => n.label === "Paper" && keepPaper(n)).map((n) => n.id),
  );
  // AUTHORED: source = paper, target = author.
  const authored = linksIn.filter((l) => l.rel === "AUTHORED" && keepPaperIds.has(l.source));
  const authorIds = new Set(authored.map((l) => l.target));
  // DISCLOSED_COI: source = author, target = org.
  const disclosed = linksIn.filter((l) => l.rel === "DISCLOSED_COI" && authorIds.has(l.source));
  const orgIds = new Set(disclosed.map((l) => l.target));

  const links = [...authored, ...disclosed];
  const nodes = nodesIn
    .filter(
      (n) =>
        (n.label === "Paper" && keepPaperIds.has(n.id)) ||
        (n.label === "Author" && authorIds.has(n.id)) ||
        (n.label === "Org" && orgIds.has(n.id)),
    )
    .map((n) => ({
      ...n,
      degree: 0,
      ...(n.label === "Author" ? { coiOrgs: 0, coiPapers: 0 } : {}),
    }));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    const s = byId.get(l.source),
      t = byId.get(l.target);
    if (s) s.degree++;
    if (t) t.degree++;
    if (l.rel === "DISCLOSED_COI" && s && s.label === "Author") s.coiOrgs++;
    if (l.rel === "AUTHORED" && l.coi && t && t.label === "Author") t.coiPapers++;
  }
  return { nodes, links };
}

export function applyCollectionFilter(nodesIn, linksIn, collection) {
  if (collection === ALL_COLLECTIONS) return { nodes: nodesIn, links: linksIn };
  return filterGraphByPapers(nodesIn, linksIn, (n) => (n.collections || []).includes(collection));
}

// Restrict to papers currently passing the Semantic map's date range /
// "Highlight by value" / search filters (activePmids — set by MapView; null
// before it's computed, meaning no restriction). Deliberately doesn't fold in
// the linked Author/Org/PMID selection — that's shared separately and already
// drives the focus/expand-depth view instead of a hard filter, so applying it
// here too would double it up and break that.
export function applyMapFilter(nodesIn, linksIn, activePmids) {
  if (!activePmids) return { nodes: nodesIn, links: linksIn };
  return filterGraphByPapers(nodesIn, linksIn, (n) => activePmids.has(n.name));
}
