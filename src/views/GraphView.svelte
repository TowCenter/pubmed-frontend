<script>
  // Tab 2 — COI network. Left: focused PMID->author->org graph (relationships).
  // Right: population scatter of all COI authors (impact vs everyone). Both are
  // driven by the same Author / Org / PMID filters. Static data, no Neo4j.
  import { onMount } from "svelte";
  import CoiNetwork from "../components/CoiNetwork.svelte";
  import AuthorScatter from "../components/AuthorScatter.svelte";
  import MultiSelect from "../components/MultiSelect.svelte";
  // Author/Org/PMID selection is shared with the Semantic map view, so picking
  // a node here also highlights the matching articles there (and vice versa).
  import { selAuthors, selOrgs, selPmids, clearSharedFilters } from "../stores/sharedFilters.js";
  // Node merges live in a shared store so the Semantic map view sees them too.
  import { mergeGroups } from "../stores/merges.js";

  // Raw graph as loaded; the *rendered* graph is derived by applying the user's
  // merges (variant org/author names combined into a single node).
  let rawNodes = [];
  let rawLinks = [];
  let loading = true;
  let error = "";
  let selected = null;

  // --- node merging: combine variants (e.g. the 14 JUUL spellings) into one ---
  // mergeGroups is the shared store: [{ id, name, label, members, memberNames }]
  // "Combine" panel UI state
  let showCombine = false;
  let mergeMode = "Org"; // pick variants from orgs or authors
  let mergePick = []; // names currently staged to combine
  let mergeName = ""; // canonical name (blank → highest-degree member's name)

  // scatter y-axis metric
  const Y_METRICS = [
    { key: "coiOrgs", label: "COI organizations" },
    { key: "citations", label: "Citations" },
  ];
  let yKey = "coiOrgs";
  $: yLabel = Y_METRICS.find((m) => m.key === yKey).label;

  const DATA_URL = (import.meta.env.BASE_URL || "/") + "coi-graph.json";

  onMount(async () => {
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`Could not load ${DATA_URL} (${res.status})`);
      const g = await res.json();
      rawNodes = g.nodes;
      rawLinks = g.links;
    } catch (e) {
      error = e.message || String(e);
    } finally {
      loading = false;
    }
  });

  // Members are stored as raw node ids, so look-ups happen against the raw set.
  $: rawById = new Map(rawNodes.map((n) => [n.id, n]));

  // Backfill memberNames on any legacy group saved before that field existed,
  // so the map can resolve variants → canonical without loading the graph.
  $: if (rawNodes.length && $mergeGroups.some((g) => !g.memberNames)) {
    $mergeGroups = $mergeGroups.map((g) =>
      g.memberNames
        ? g
        : { ...g, memberNames: g.members.map((id) => rawById.get(id)?.name).filter(Boolean) },
    );
  }

  // --- apply merges: collapse member nodes into one canonical node ------------
  function applyMerges(nodesIn, linksIn, groups) {
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
      const s = canon(l.source), t = canon(l.target);
      if (s === t) continue;
      const key = l.rel + "|" + s + "|" + t;
      const ex = lmap.get(key);
      if (ex) {
        if (l.rel === "DISCLOSED_COI") ex.weight = (ex.weight || 0) + (l.weight || 0);
        if (l.rel === "AUTHORED" && l.coi) ex.coi = true;
      } else {
        lmap.set(key, {
          source: s, target: t, rel: l.rel,
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
      if (n.label === "Author") { n.coiOrgs = 0; n.coiPapers = 0; }
    }
    for (const l of links) {
      const s = out.get(l.source), t = out.get(l.target);
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

  let nodes = [], links = [];
  $: ({ nodes, links } = applyMerges(rawNodes, rawLinks, $mergeGroups));

  // Indices rebuilt whenever the merged graph changes.
  let authorsList = [], authorNames = [], orgNames = [], pmidList = [];
  let authorIdByName = new Map(), orgIdByName = new Map(), paperIdByPmid = new Map();
  let authorIdSet = new Set(), adjacency = new Map();
  $: {
    const aMap = new Map(), oMap = new Map(), pMap = new Map(), aSet = new Set();
    for (const n of nodes) {
      if (n.label === "Author") { aMap.set(n.name, n.id); aSet.add(n.id); }
      else if (n.label === "Org") oMap.set(n.name, n.id);
      else if (n.label === "Paper") pMap.set(n.name, n.id);
    }
    const adj = new Map();
    for (const l of links) {
      if (!adj.has(l.source)) adj.set(l.source, new Set());
      if (!adj.has(l.target)) adj.set(l.target, new Set());
      adj.get(l.source).add(l.target);
      adj.get(l.target).add(l.source);
    }
    authorIdByName = aMap; orgIdByName = oMap; paperIdByPmid = pMap;
    authorIdSet = aSet; adjacency = adj;
    // Scatter + pickers default to COI-disclosing authors/papers; the co-authors
    // and their non-COI papers are surfaced only when you drill into a node.
    // (n.coi !== false keeps older data, which has no `coi` field, working.)
    authorsList = nodes.filter((n) => n.label === "Author" && n.coi !== false);
    authorNames = authorsList.map((n) => n.name).sort();
    orgNames = [...oMap.keys()].sort();
    pmidList = nodes.filter((n) => n.label === "Paper" && n.coi !== false).map((n) => n.name).sort();
  }

  // directly-selected node ids (drives the graph's focus)
  $: highlightIds = (() => {
    const s = new Set();
    for (const name of $selAuthors) { const id = authorIdByName.get(name); if (id) s.add(id); }
    for (const name of $selOrgs) { const id = orgIdByName.get(name); if (id) s.add(id); }
    for (const pmid of $selPmids) { const id = paperIdByPmid.get(pmid); if (id) s.add(id); }
    return s;
  })();

  // author ids to highlight in the scatter = selected authors + author-neighbors
  // of selected orgs/papers.
  $: activeAuthorIds = (() => {
    const s = new Set();
    for (const id of highlightIds) {
      if (authorIdSet.has(id)) s.add(id);
      for (const nb of adjacency.get(id) || []) if (authorIdSet.has(nb)) s.add(nb);
    }
    return s;
  })();

  $: hasFilter = $selAuthors.length || $selOrgs.length || $selPmids.length;
  $: authorCount = authorsList.length;
  $: orgCount = nodes.filter((n) => n.label === "Org").length;
  $: paperCount = nodes.filter((n) => n.label === "Paper" && n.coi !== false).length;

  function clearAll() { clearSharedFilters(); }
  function addAuthor(name) { $selAuthors = [...new Set([...$selAuthors, name])]; }
  function addFromDetail(n) {
    if (n.label === "Author") addAuthor(n.name);
    else if (n.label === "Org") $selOrgs = [...new Set([...$selOrgs, n.name])];
    else if (n.label === "Paper") $selPmids = [...new Set([...$selPmids, n.name])];
  }

  // --- combine actions --------------------------------------------------------
  $: mergeOptions = mergeMode === "Org" ? orgNames : authorNames;
  const idForName = (name) => (mergeMode === "Org" ? orgIdByName : authorIdByName).get(name);

  function bestName(memberIds) {
    let best = "", bestDeg = -1;
    for (const id of memberIds) {
      const n = rawById.get(id);
      if (n && n.degree > bestDeg) { bestDeg = n.degree; best = n.name; }
    }
    return best;
  }

  function setMode(m) {
    if (m === mergeMode) return;
    mergeMode = m; // options differ per mode, so reset the staging area
    mergePick = [];
    mergeName = "";
  }

  function combine() {
    const ids = mergePick.map(idForName).filter(Boolean);
    // Resolve to RAW member ids, absorbing any already-merged group re-picked.
    const rawMembers = new Set();
    const absorb = new Set();
    const groupById = new Map($mergeGroups.map((g) => [g.id, g]));
    for (const id of ids) {
      const g = groupById.get(id);
      if (g) { absorb.add(g.id); for (const m of g.members) rawMembers.add(m); }
      else rawMembers.add(id);
    }
    if (rawMembers.size < 2) return;
    const members = [...rawMembers];
    const memberNames = members.map((id) => rawById.get(id)?.name).filter(Boolean);
    const name = mergeName.trim() || bestName(members);
    const gid = "merge:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    $mergeGroups = [
      ...$mergeGroups.filter((g) => !absorb.has(g.id)),
      { id: gid, name, label: mergeMode, members, memberNames },
    ];
    mergePick = [];
    mergeName = "";
    selected = null; // the staged variant nodes no longer exist
  }

  function splitGroup(id) {
    $mergeGroups = $mergeGroups.filter((g) => g.id !== id);
    if (selected && selected.id === id) selected = null;
  }

  function addToCombine(n) {
    setMode(n.label); // 'Org' or 'Author'
    mergePick = [...new Set([...mergePick, n.name])];
    showCombine = true;
  }
</script>

<div class="graph-view">
  <div class="controls">
    <MultiSelect label="Author" items={authorNames} bind:selected={$selAuthors}
      placeholder="add author…" color="var(--cjr-blue)" />
    <MultiSelect label="Organization" items={orgNames} bind:selected={$selOrgs}
      placeholder="add org…" color="var(--cjr-accent)" />
    <MultiSelect label="PMID" items={pmidList} bind:selected={$selPmids}
      placeholder="add PMID…" color="#5a7a52" allowFreeText={true} />
    <div class="meta">
      {#if hasFilter}
        <button class="clear" on:click={clearAll}>Clear all</button>
        <span class="count">{highlightIds.size} selected</span>
      {:else if !loading && !error}
        <span class="count">{paperCount} papers · {authorCount} authors · {orgCount} orgs</span>
      {/if}
      <button class="combine-toggle" class:on={showCombine} on:click={() => (showCombine = !showCombine)}>
        Combine nodes{#if $mergeGroups.length} · {$mergeGroups.length}{/if}
      </button>
    </div>
  </div>

  {#if showCombine}
    <div class="combine-panel">
      <div class="combine-row">
        <div class="seg" role="group" aria-label="Combine type">
          <button class:active={mergeMode === "Org"} on:click={() => setMode("Org")}>Organizations</button>
          <button class:active={mergeMode === "Author"} on:click={() => setMode("Author")}>Authors</button>
        </div>
        <div class="combine-pick">
          <MultiSelect items={mergeOptions} bind:selected={mergePick}
            placeholder={mergeMode === "Org" ? "search org variants (e.g. juul)…" : "search author variants…"}
            color="var(--cjr-accent)" />
        </div>
        <input class="combine-name" bind:value={mergeName} placeholder="combined name (optional)" />
        <button class="combine-go" disabled={mergePick.length < 2} on:click={combine}>
          Combine{mergePick.length >= 2 ? " " + mergePick.length : ""}
        </button>
      </div>

      {#if $mergeGroups.length}
        <div class="merge-list">
          {#each $mergeGroups as g (g.id)}
            <span class="merge-chip" class:author={g.label === "Author"}>
              <b>{g.name}</b><em>{g.members.length}</em>
              <button on:click={() => splitGroup(g.id)} title="Split back into variants" aria-label="Split">×</button>
            </span>
          {/each}
        </div>
      {/if}
      <p class="combine-hint">
        Pick the {mergeMode === "Org" ? "organization" : "author"} variants (e.g. type
        “juul”), add 2 or more, optionally name the combined node, then Combine.
        Merges are saved in your browser.
      </p>
    </div>
  {/if}

  <div class="stage">
    {#if error}
      <div class="msg error">⚠ {error}<br /><small>Run <code>npm run build-coi-graph</code> to generate the data.</small></div>
    {:else if loading}
      <div class="msg">Loading COI network…</div>
    {:else}
      <div class="split">
        <div class="pane">
          <div class="pane-title">Relationships {hasFilter ? "" : "(overview)"}</div>
          <div class="pane-body">
            <CoiNetwork {nodes} {links} {highlightIds} on:nodeclick={(e) => (selected = e.detail)} />
          </div>
        </div>
        <div class="pane">
          <div class="pane-title">
            <span>Author impact — papers vs</span>
            <select bind:value={yKey}>
              {#each Y_METRICS as m}<option value={m.key}>{m.label}</option>{/each}
            </select>
          </div>
          <div class="pane-body">
            <AuthorScatter authors={authorsList} highlightIds={activeAuthorIds} {yKey} {yLabel}
              on:authorclick={(e) => { selected = e.detail; addAuthor(e.detail.name); }} />
          </div>
        </div>
      </div>

      {#if selected}
        <aside class="detail">
          <button class="x" on:click={() => (selected = null)}>×</button>
          <div class="d-label">{selected.label}{selected.merged ? " · combined" : ""}</div>
          <h3>{selected.label === "Paper" ? "PMID " + selected.name : selected.name}</h3>
          {#if selected.label === "Paper" && selected.title}
            <p class="title">{selected.title}</p>
          {/if}
          <dl>
            {#if selected.merged}
              <dt>Combined from</dt><dd>{selected.merged} variants</dd>
            {/if}
            {#if selected.label === "Author"}
              <dt>Papers (total)</dt><dd>{selected.papers}</dd>
              <dt>COI organizations</dt><dd>{selected.coiOrgs}</dd>
              <dt>COI papers</dt><dd>{selected.coiPapers}</dd>
            {:else if selected.label === "Org"}
              <dt>Authors disclosing COI</dt><dd>{selected.degree}</dd>
            {:else}
              <dt>COI-disclosing authors</dt><dd>{selected.degree}</dd>
            {/if}
          </dl>
          <div class="detail-actions">
            <button class="filter-btn" on:click={() => addFromDetail(selected)}>
              Focus this {selected.label === "Paper" ? "PMID" : selected.label.toLowerCase()}
            </button>
            {#if selected.label !== "Paper"}
              <button class="filter-btn ghost" on:click={() => addToCombine(selected)}>Add to combine</button>
            {/if}
            {#if selected.merged}
              <button class="filter-btn ghost" on:click={() => splitGroup(selected.id)}>Split</button>
            {/if}
          </div>
        </aside>
      {/if}
    {/if}
  </div>
</div>

<style>
  .graph-view { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .controls {
    flex: 0 0 auto; display: flex; gap: 14px; align-items: flex-start;
    padding: 10px 12px; border-bottom: 1px solid var(--cjr-border); flex-wrap: wrap;
  }
  .meta { display: flex; align-items: center; gap: 10px; align-self: center; flex-wrap: wrap; }
  .clear {
    border: 1px solid var(--cjr-border); background: var(--cjr-white);
    border-radius: 5px; padding: 5px 10px; cursor: pointer; font-size: 13px;
  }
  .count { color: var(--cjr-text-muted); font-size: 13px; }

  .combine-toggle {
    border: 1px solid var(--cjr-border); background: var(--cjr-white);
    border-radius: 5px; padding: 5px 10px; cursor: pointer; font-size: 13px;
    color: var(--cjr-blue); font-weight: 600;
  }
  .combine-toggle:hover { border-color: var(--cjr-blue); }
  .combine-toggle.on { background: var(--cjr-blue); color: #fff; border-color: var(--cjr-blue); }

  .combine-panel {
    flex: 0 0 auto; padding: 10px 12px; border-bottom: 1px solid var(--cjr-border);
    background: var(--cjr-bg); display: flex; flex-direction: column; gap: 8px;
  }
  .combine-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .seg { display: inline-flex; border: 1px solid var(--cjr-border); border-radius: 6px; overflow: hidden; }
  .seg button {
    border: none; background: var(--cjr-white); cursor: pointer; font-size: 12px;
    padding: 6px 10px; color: var(--cjr-text); font-weight: 600;
  }
  .seg button + button { border-left: 1px solid var(--cjr-border); }
  .seg button.active { background: var(--cjr-accent); color: #fff; }
  .combine-pick { flex: 1 1 260px; min-width: 220px; }
  .combine-name {
    padding: 7px 9px; border: 1px solid var(--cjr-border); border-radius: 6px;
    font-size: 13px; font-family: var(--font-body); min-width: 180px;
  }
  .combine-go {
    border: none; background: var(--cjr-blue); color: #fff; border-radius: 6px;
    padding: 7px 14px; cursor: pointer; font-size: 13px; font-weight: 600;
  }
  .combine-go:disabled { background: var(--cjr-border); color: var(--cjr-text-muted); cursor: not-allowed; }

  .merge-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .merge-chip {
    display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
    background: var(--cjr-white); border: 1px solid var(--cjr-accent);
    border-radius: 14px; padding: 3px 6px 3px 10px; color: var(--cjr-text);
  }
  .merge-chip.author { border-color: var(--cjr-blue); }
  .merge-chip b { font-weight: 600; }
  .merge-chip em {
    font-style: normal; font-size: 10px; background: var(--cjr-bg);
    color: var(--cjr-text-muted); border-radius: 8px; padding: 1px 6px;
  }
  .merge-chip button {
    border: none; background: none; cursor: pointer; color: var(--cjr-text-muted);
    font-size: 15px; line-height: 1; padding: 0 2px;
  }
  .merge-chip button:hover { color: var(--cjr-accent); }
  .combine-hint { font-size: 11.5px; color: var(--cjr-text-muted); margin: 0; line-height: 1.4; }

  .stage { position: relative; flex: 1 1 auto; min-height: 0; }
  .split { display: flex; height: 100%; min-height: 0; }
  .pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .pane:first-child { flex: 1.6 1 0; border-right: 1px solid var(--cjr-border); }
  .pane:last-child { flex: 1 1 0; }
  .pane-title {
    flex: 0 0 auto; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--cjr-text-muted); font-weight: 600; padding: 5px 10px;
    border-bottom: 1px solid var(--cjr-bg); background: var(--cjr-bg);
    display: flex; align-items: center; gap: 6px;
  }
  .pane-title select {
    text-transform: none; letter-spacing: normal; font-size: 11px; font-weight: 600;
    color: var(--cjr-blue); padding: 2px 4px; border: 1px solid var(--cjr-border);
    border-radius: 4px; background: var(--cjr-white); cursor: pointer;
  }
  .pane-body { flex: 1 1 auto; min-height: 0; position: relative; }

  .msg {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 6px;
    color: var(--cjr-text-muted); text-align: center; padding: 24px;
  }
  .msg.error { color: var(--cjr-accent); }

  .detail {
    position: absolute; top: 12px; right: 12px; width: 250px; z-index: 5;
    background: var(--cjr-white); border: 1px solid var(--cjr-border);
    border-radius: 8px; padding: 14px 16px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  }
  .detail .x {
    position: absolute; top: 6px; right: 8px; border: none; background: none;
    font-size: 20px; cursor: pointer; color: var(--cjr-text-muted);
  }
  .d-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--cjr-accent); font-weight: 600; }
  .detail h3 { font-family: var(--font-heading); font-size: 17px; color: var(--cjr-blue); margin: 2px 0 8px; word-break: break-word; }
  .detail .title { font-size: 12px; color: var(--cjr-text); margin-bottom: 8px; line-height: 1.35; }
  dl { font-size: 13px; margin-bottom: 12px; }
  dt { color: var(--cjr-text-muted); margin-top: 6px; font-size: 11px; text-transform: uppercase; }
  .detail-actions { display: flex; flex-direction: column; gap: 6px; }
  .filter-btn {
    width: 100%; background: var(--cjr-blue); color: #fff; border: none;
    border-radius: 6px; padding: 7px; cursor: pointer; font-size: 13px; font-weight: 600;
  }
  .filter-btn.ghost { background: var(--cjr-white); color: var(--cjr-blue); border: 1px solid var(--cjr-border); }
  .filter-btn.ghost:hover { border-color: var(--cjr-blue); }
  code { background: var(--cjr-bg); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
