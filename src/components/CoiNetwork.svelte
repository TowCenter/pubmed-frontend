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

  let containerEl, canvas, ctx;
  let width = 800, height = 600, dpr = 1;
  let t = zoomIdentity, zoomBehavior;
  let hovered = null;
  let baseScale = 1, cx = 0, cy = 0;

  // node-type visibility (toggled from the legend)
  let show = { Paper: true, Author: true, Org: true };
  function toggle(label) { show = { ...show, [label]: !show[label] }; }

  $: visibleIds = new Set(nodes.filter((n) => show[n.label]).map((n) => n.id));
  $: fNodes = nodes.filter((n) => show[n.label]);
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
  let view = { nodes: [], links: [], byId: new Map(), neighbors: new Map(), focus: false };

  $: buildView(highlightIds, fNodes, fLinks);

  function buildView(hi, allNodes, allLinks) {
    if (!allNodes.length) {
      view = { nodes: [], links: [], byId: new Map(), neighbors: new Map(), focus: false };
      draw();
      return;
    }
    const byIdAll = new Map(allNodes.map((n) => [n.id, n]));
    const neighborsAll = buildNeighbors(allLinks);
    const focus = hi && hi.size > 0;

    if (!focus) {
      view = { nodes: allNodes, links: allLinks, byId: byIdAll, neighbors: neighborsAll, focus: false };
      frameAndDraw();
      return;
    }

    // visible = selected (that are present) + 1-hop neighbors
    const visible = new Set();
    for (const id of hi) {
      if (!byIdAll.has(id)) continue;
      visible.add(id);
      for (const nb of neighborsAll.get(id) || []) visible.add(nb);
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

    view = { nodes: sub, links: subLinks, byId, neighbors, focus: true };
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
      ctx.fillStyle = COLORS[n.label] || "#999";
      ctx.beginPath();
      ctx.arc(px(n), py(n), radius(n) / Math.sqrt(t.k), 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // labels: in focus, label authors+orgs; always label hovered
    ctx.fillStyle = "#222";
    ctx.font = `${11 / t.k}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    const labelled = new Set();
    if (view.focus) {
      for (const n of view.nodes) if (n.label !== "Paper") labelled.add(n.id);
    }
    if (hovered) labelled.add(hovered.id);
    for (const id of labelled) {
      const n = view.byId.get(id);
      if (!n || !onHover(id)) continue;
      ctx.fillText(n.name, px(n), py(n) - radius(n) / Math.sqrt(t.k) - 3 / t.k);
    }
    ctx.restore();
  }

  // --- hover / click ---
  function nodeAt(mx, my) {
    const [bx, by] = t.invert([mx, my]);
    let best = null, bestD = Infinity;
    for (const n of view.nodes) {
      const r = radius(n) / Math.sqrt(t.k) + 3 / t.k;
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
    <button class:off={!show.Org} on:click={() => toggle("Org")} title="Show/hide Org nodes">
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
