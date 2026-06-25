<script>
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import {
    forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide,
  } from "d3-force";
  import { zoom as d3zoom, zoomIdentity } from "d3-zoom";
  import { select } from "d3-selection";

  export let nodes = [];
  export let links = [];
  export let highlightIds = null; // Set<string> of directly-selected node ids

  const dispatch = createEventDispatcher();
  const COLORS = { Paper: "#5a7a52", Author: "#254c6f", Org: "#DE5A35" };
  // Lighter shades for nodes with no COI disclosure (plain co-authors and the
  // papers they wrote without disclosing), so the COI signal stays prominent.
  const COLORS_MUTED = { Paper: "#aac6a2", Author: "#9aafc6" };
  // n.coi === false only after the expanded graph is rebuilt; older data (no
  // `coi` field) falls back to the full color, so this stays backward-compatible.
  function nodeColor(n) {
    if (n.coi === false && COLORS_MUTED[n.label]) return COLORS_MUTED[n.label];
    return COLORS[n.label] || "#999";
  }
  // Size multiplier: directly-selected nodes are biggest, then nodes shared by
  // 2+ selections (e.g. co-authored papers), then everything else.
  function nodeScale(n) {
    if (selSet.has(n.id)) return 2.6;
    if (view.shared.has(n.id)) return 1.9;
    return 1;
  }

  let containerEl, canvas, ctx;
  let width = 800, height = 600, dpr = 1;
  let t = zoomIdentity, zoomBehavior;
  let hovered = null;
  let baseScale = 1, cx = 0, cy = 0;

  // node-type visibility (toggled from the legend)
  let show = { Paper: true, Author: true, Org: true };
  function toggle(label) { show = { ...show, [label]: !show[label] }; }

  // Directly-selected node ids (from the Author/Org/PMID filters). These stay
  // visible even when their type is hidden via the legend, so e.g. hiding Org
  // leaves only the selected org(s) on screen.
  $: selSet = highlightIds || new Set();

  // Reference show + selSet directly in each reactive block so Svelte re-runs
  // them when either changes (selected nodes survive a hidden type).
  $: fNodes = nodes.filter((n) => show[n.label] || selSet.has(n.id));
  $: visibleIds = new Set(fNodes.map((n) => n.id));
  $: fLinks = links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target));

  function buildNeighbors(ls) {
    const m = new Map();
    for (const l of ls) {
      if (!m.has(l.source)) m.set(l.source, new Set());
      if (!m.has(l.target)) m.set(l.target, new Set());
      m.get(l.source).add(l.target);
      m.get(l.target).add(l.source);
    }
    return m;
  }

  // Every node renders at the same fixed radius (node type is shown by color).
  const NODE_RADIUS = 4;
  function radius() {
    return NODE_RADIUS;
  }

  // --- the current view: full overview, or a freshly-laid-out focus subgraph ---
  let view = { nodes: [], links: [], byId: new Map(), neighbors: new Map(), focus: false, shared: new Set() };

  $: buildView(highlightIds, fNodes, fLinks);

  function buildView(hi, allNodes, allLinks) {
    if (!allNodes.length) {
      view = { nodes: [], links: [], byId: new Map(), neighbors: new Map(), focus: false, shared: new Set() };
      draw();
      return;
    }
    const byIdAll = new Map(allNodes.map((n) => [n.id, n]));
    const neighborsAll = buildNeighbors(allLinks);
    const focus = hi && hi.size > 0;

    if (!focus) {
      // Overview = the COI network only (authors/papers that carry a disclosure,
      // plus orgs). The full set of papers and co-authors is large, so it's only
      // revealed when you select a node (the focus branch below).
      const ov = allNodes.filter((n) => n.coi !== false);
      const ovById = new Map(ov.map((n) => [n.id, n]));
      const ovLinks = allLinks.filter((l) => ovById.has(l.source) && ovById.has(l.target));
      view = { nodes: ov, links: ovLinks, byId: ovById, neighbors: buildNeighbors(ovLinks), focus: false, shared: new Set() };
      frameAndDraw();
      return;
    }

    // Show only what's relevant to the selection (not every neighbor).
    const selected = [...hi].filter((id) => byIdAll.has(id));
    const labelOf = (id) => byIdAll.get(id)?.label;
    const authorsOf = (id) =>
      [...(neighborsAll.get(id) || [])].filter((nb) => labelOf(nb) === "Author");
    const visible = new Set(selected);
    let shared = new Set();

    if (selected.length >= 2) {
      // Each selected node constrains which AUTHORS are relevant:
      //   selected Author → authors who co-authored with them (+ themselves)
      //   selected Org    → authors who disclosed that org
      //   selected Paper  → authors on that paper
      // Relevant authors must satisfy EVERY selected constraint (intersection),
      // e.g. "authors who disclosed Juul AND co-authored a paper with Polosa".
      const constraintSets = selected.map((id) => {
        if (labelOf(id) === "Author") {
          const co = new Set([id]);
          for (const p of neighborsAll.get(id) || []) {
            if (labelOf(p) === "Paper") for (const a of authorsOf(p)) co.add(a);
          }
          return co;
        }
        return new Set(authorsOf(id)); // Org or Paper → its incident authors
      });
      let relevant = new Set(constraintSets[0]);
      for (let i = 1; i < constraintSets.length; i++)
        relevant = new Set([...relevant].filter((x) => constraintSets[i].has(x)));

      // Author set = selected authors + relevant authors.
      const authorSet = new Set(relevant);
      for (const id of selected) if (labelOf(id) === "Author") authorSet.add(id);
      for (const a of authorSet) visible.add(a);

      // Bridge papers: those co-authored by 2+ of these authors, so the
      // co-authorship links between them are actually drawn.
      const paperCount = new Map();
      for (const a of authorSet) {
        for (const nb of neighborsAll.get(a) || []) {
          if (labelOf(nb) === "Paper") paperCount.set(nb, (paperCount.get(nb) || 0) + 1);
        }
      }
      for (const [pid, c] of paperCount) if (c >= 2) visible.add(pid);

      // Emphasize the relevant authors (the answer to the cross-filter query).
      shared = new Set([...relevant].filter((id) => !hi.has(id)));
    } else {
      // Single selection: that node + its direct (1-hop) neighbors.
      for (const id of selected) {
        for (const nb of neighborsAll.get(id) || []) visible.add(nb);
      }
    }

    const sub = [...visible].map((id) => ({ ...byIdAll.get(id) })).filter(Boolean);
    const byId = new Map(sub.map((n) => [n.id, n]));
    const subLinks = allLinks.filter((l) => byId.has(l.source) && byId.has(l.target));
    const neighbors = new Map();
    for (const l of subLinks) {
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source).add(l.target);
      neighbors.get(l.target).add(l.source);
    }

    // fresh local layout with strong collision so nodes never overlap
    const simLinks = subLinks.map((l) => ({ source: l.source, target: l.target }));
    const sim = forceSimulation(sub)
      .force("charge", forceManyBody().strength(-260))
      .force("link", forceLink(simLinks).id((d) => d.id).distance(60).strength(0.6))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide().radius((d) => radius(d) + 6).iterations(4))
      .stop();
    const ticks = sub.length > 600 ? 120 : 300;
    for (let i = 0; i < ticks; i++) sim.tick();

    view = { nodes: sub, links: subLinks, byId, neighbors, focus: true, shared };
    frameAndDraw();
  }

  // --- fit current view to the canvas and reset zoom ---
  function fit() {
    if (!view.nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of view.nodes) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    }
    cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
    const dx = maxX - minX || 1, dy = maxY - minY || 1;
    baseScale = Math.min(width / dx, height / dy) * 0.88;
  }
  function frameAndDraw() {
    fit();
    if (canvas && zoomBehavior) {
      t = zoomIdentity;
      select(canvas).call(zoomBehavior.transform, zoomIdentity);
    }
    draw();
  }

  const px = (n) => (n.x - cx) * baseScale + width / 2;
  const py = (n) => (n.y - cy) * baseScale + height / 2;

  function resize() {
    if (!containerEl || !canvas) return;
    width = containerEl.clientWidth;
    height = containerEl.clientHeight;
    dpr = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx = canvas.getContext("2d");
    fit();
    draw();
  }

  function draw() {
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const dimByHover = Boolean(hovered);
    const onHover = (id) =>
      !dimByHover || id === hovered.id || (view.neighbors.get(hovered.id) || new Set()).has(id);

    // edges
    ctx.lineWidth = 0.7 / t.k;
    for (const l of view.links) {
      const s = view.byId.get(l.source), d = view.byId.get(l.target);
      if (!s || !d) continue;
      const on = onHover(l.source) && onHover(l.target);
      if (dimByHover && !on) continue;
      ctx.strokeStyle = l.rel === "AUTHORED" ? "rgba(90,122,82,0.30)" : "rgba(150,160,170,0.28)";
      ctx.beginPath();
      ctx.moveTo(px(s), py(s));
      ctx.lineTo(px(d), py(d));
      ctx.stroke();
    }

    // nodes
    for (const n of view.nodes) {
      ctx.globalAlpha = onHover(n.id) ? 1 : 0.1;
      ctx.fillStyle = nodeColor(n);
      const scale = nodeScale(n);
      const r = (radius(n) * scale) / Math.sqrt(t.k);
      ctx.beginPath();
      ctx.arc(px(n), py(n), r, 0, 2 * Math.PI);
      ctx.fill();
      if (scale > 1) {
        // ring emphasizes selected (biggest) and shared nodes
        const isSel = selSet.has(n.id);
        ctx.lineWidth = (isSel ? 2.2 : 1.5) / t.k;
        ctx.strokeStyle = isSel ? "#000" : "#111";
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    ctx.restore();

    // Labels are drawn in screen space (after the zoom transform) with greedy
    // de-overlap so text never piles up: higher-degree nodes (and the hovered
    // one) claim space first, and any label that would collide is skipped.
    // Zooming in spreads nodes apart, so more labels appear as you go deeper.
    drawLabels(onHover);
  }

  function drawLabels(onHover) {
    const FONT_PX = 11;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.font = `${FONT_PX}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    // Candidates: selected + shared nodes (always), every Author/Org in focus,
    // plus hovered.
    const ids = [];
    for (const id of selSet) if (view.byId.has(id)) ids.push(id);
    for (const id of view.shared) if (!ids.includes(id)) ids.push(id);
    if (view.focus) {
      for (const n of view.nodes)
        if (n.label !== "Paper" && !ids.includes(n.id)) ids.push(n.id);
    }
    if (hovered && !ids.includes(hovered.id)) ids.push(hovered.id);

    // Priority order: hovered, then selected, then shared, then by degree
    // (most-connected win the remaining space).
    const rank = (id) =>
      (hovered && id === hovered.id ? 4 : 0) + (selSet.has(id) ? 2 : 0) + (view.shared.has(id) ? 1 : 0);
    ids.sort((a, b) => {
      const dr = rank(b) - rank(a);
      if (dr) return dr;
      const na = view.byId.get(a), nb = view.byId.get(b);
      return (nb?.degree || 0) - (na?.degree || 0);
    });

    const placed = [];
    const pad = 2;
    const overlaps = (b) =>
      placed.some((p) =>
        b.x1 < p.x2 + pad && b.x2 > p.x1 - pad && b.y1 < p.y2 + pad && b.y2 > p.y1 - pad);

    for (const id of ids) {
      const n = view.byId.get(id);
      if (!n || !onHover(id)) continue;
      const screenR = radius(n) * nodeScale(n) * Math.sqrt(t.k);
      const sx = t.x + t.k * px(n);
      const sy = t.y + t.k * py(n) - screenR - 4;
      if (sx < -80 || sx > width + 80 || sy < -10 || sy > height + 10) continue; // cull off-screen
      const w = ctx.measureText(n.name).width;
      const box = { x1: sx - w / 2, x2: sx + w / 2, y1: sy - FONT_PX, y2: sy };
      // hovered, selected, and shared labels always show
      const forced = (hovered && id === hovered.id) || selSet.has(id) || view.shared.has(id);
      if (!forced && overlaps(box)) continue;
      placed.push(box);
      ctx.lineWidth = 3; // white halo keeps text legible over dense nodes/edges
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeText(n.name, sx, sy);
      ctx.fillStyle = "#222";
      ctx.fillText(n.name, sx, sy);
    }
    ctx.restore();
  }

  // --- hover / click ---
  function nodeAt(mx, my) {
    const [bx, by] = t.invert([mx, my]);
    let best = null, bestD = Infinity;
    for (const n of view.nodes) {
      const baseR = radius(n) * nodeScale(n);
      const r = baseR / Math.sqrt(t.k) + 3 / t.k;
      const ddx = px(n) - bx, ddy = py(n) - by;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < r * r && d2 < bestD) { bestD = d2; best = n; }
    }
    return best;
  }
  function onMove(e) {
    const rect = canvas.getBoundingClientRect();
    const hit = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (hit !== hovered) { hovered = hit; draw(); }
    canvas.style.cursor = hit ? "pointer" : "grab";
  }
  function onClick(e) {
    const rect = canvas.getBoundingClientRect();
    const hit = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) dispatch("nodeclick", hit);
  }

  let ro;
  onMount(() => {
    resize();
    zoomBehavior = d3zoom().scaleExtent([0.1, 14]).on("zoom", (e) => { t = e.transform; draw(); });
    select(canvas).call(zoomBehavior);
    ro = new ResizeObserver(resize);
    ro.observe(containerEl);
  });
  onDestroy(() => ro && ro.disconnect());
</script>

<div class="net" bind:this={containerEl}>
  <canvas bind:this={canvas} on:pointermove={onMove} on:click={onClick}></canvas>
  {#if hovered}
    <div class="tip">
      <strong>{hovered.label === "Paper" ? "PMID " + hovered.name : hovered.name}</strong>
      <span>{hovered.label} · {hovered.degree} link{hovered.degree === 1 ? "" : "s"}</span>
    </div>
  {/if}
  <div class="legend">
    <button class:off={!show.Paper} on:click={() => toggle("Paper")} title="Show/hide PMID nodes">
      <i style="background:{COLORS.Paper}"></i>PMID</button>
    <button class:off={!show.Author} on:click={() => toggle("Author")} title="Show/hide Author nodes">
      <i style="background:{COLORS.Author}"></i>Author</button>
    <button class:off={!show.Org} on:click={() => toggle("Org")} title="Show/hide Org nodes (selected orgs stay)">
      <i style="background:{COLORS.Org}"></i>Org</button>
  </div>
</div>

<style>
  .net { position: relative; width: 100%; height: 100%; min-height: 0; background: var(--cjr-white); overflow: hidden; }
  canvas { display: block; }
  .tip {
    position: absolute; bottom: 10px; left: 10px;
    background: var(--cjr-blue); color: #fff; padding: 6px 10px; border-radius: 6px;
    font-size: 13px; max-width: 70%; pointer-events: none;
  }
  .tip span { opacity: 0.75; margin-left: 8px; font-size: 11px; }
  .legend {
    position: absolute; top: 10px; left: 10px; display: flex; gap: 12px;
    background: rgba(255,255,255,0.9); padding: 5px 10px; border-radius: 6px;
    border: 1px solid var(--cjr-border); font-size: 12px;
  }
  .legend button {
    display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
    border: none; background: none; font: inherit; font-size: 12px; color: var(--cjr-text);
    padding: 1px 2px; border-radius: 4px;
  }
  .legend button:hover { background: var(--cjr-bg); }
  .legend button.off { opacity: 0.4; text-decoration: line-through; }
  .legend i { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
</style>
