<script>
  // Population scatter: every COI author as a dot. x = total papers,
  // y = # COI organizations. Selected authors are highlighted so you can see
  // where they fall against everyone else. No edges — full context, no hairball.
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { scaleLinear } from "d3-scale";

  export let authors = [];           // [{id,name,papers,coiOrgs,coiPapers,citations}]
  export let highlightIds = null;    // Set<string> of author ids to emphasize (selection)
  export let hoverIds = null;        // Set<string> of author ids to spotlight (linked hover)
  export let yKey = "coiOrgs";       // which metric on the y-axis
  export let yLabel = "# COI organizations";

  const dispatch = createEventDispatcher();
  const M = { top: 16, right: 16, bottom: 40, left: 52 };

  let containerEl, canvas, ctx;
  let width = 400, height = 500, dpr = 1;
  let hovered = null;

  const xVal = (a) => a.papers || 0;
  $: yVal = (a) => a[yKey] || 0;

  $: xMax = authors.length ? Math.max(...authors.map(xVal)) : 1;
  $: yMax = authors.length ? Math.max(...authors.map(yVal)) : 1;
  $: x = scaleLinear().domain([0, xMax * 1.05]).range([M.left, width - M.right]);
  $: y = scaleLinear().domain([0, yMax * 1.05]).range([height - M.bottom, M.top]);
  $: hi = highlightIds && highlightIds.size ? highlightIds : null;
  // redraw on any input change
  $: { yKey; yLabel; highlightIds; hoverIds; authors; if (ctx) draw(); }

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
    draw();
  }

  function draw() {
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // axes
    ctx.strokeStyle = "#ccc";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.left, M.top); ctx.lineTo(M.left, height - M.bottom); ctx.lineTo(width - M.right, height - M.bottom);
    ctx.stroke();

    ctx.fillStyle = "#999";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const tick of x.ticks(5)) {
      ctx.fillText(tick, x(tick), height - M.bottom + 14);
    }
    ctx.textAlign = "right";
    for (const tick of y.ticks(5)) {
      ctx.fillText(tick, M.left - 6, y(tick) + 3);
    }
    // axis titles
    ctx.fillStyle = "#666";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Total papers", (M.left + width - M.right) / 2, height - 6);
    ctx.save();
    ctx.translate(12, (M.top + height - M.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    // dots — non-highlighted first (dim), highlighted on top
    const drawDot = (a, on) => {
      ctx.globalAlpha = hi ? (on ? 1 : 0.12) : 0.5;
      ctx.fillStyle = on ? "#DE5A35" : "#254c6f";
      ctx.beginPath();
      ctx.arc(x(xVal(a)), y(yVal(a)), on ? 5 : 2.5, 0, 2 * Math.PI);
      ctx.fill();
    };
    for (const a of authors) if (!(hi && hi.has(a.id))) drawDot(a, false);
    if (hi) for (const a of authors) if (hi.has(a.id)) drawDot(a, true);
    ctx.globalAlpha = 1;

    // labels for highlighted (cap to avoid clutter) + hovered
    const labelled = [];
    if (hi) {
      const sel = authors.filter((a) => hi.has(a.id));
      if (sel.length <= 25) labelled.push(...sel);
    }
    if (hovered && !labelled.includes(hovered)) labelled.push(hovered);
    ctx.fillStyle = "#222";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    for (const a of labelled) {
      ctx.fillText(a.name, x(xVal(a)) + 7, y(yVal(a)) + 3);
    }

    // Linked hover: spotlight dots for the node hovered/pinned in the network.
    const hov = hoverIds && hoverIds.size ? hoverIds : null;
    if (hov) {
      ctx.globalAlpha = 1;
      const spot = authors.filter((a) => hov.has(a.id));
      for (const a of spot) {
        ctx.beginPath();
        ctx.arc(x(xVal(a)), y(yVal(a)), 6, 0, 2 * Math.PI);
        ctx.fillStyle = "#DE5A35";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#111";
        ctx.stroke();
      }
      if (spot.length <= 25) {
        ctx.fillStyle = "#222";
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "left";
        for (const a of spot) ctx.fillText(a.name, x(xVal(a)) + 7, y(yVal(a)) + 3);
      }
    }
    ctx.restore();
  }

  function dotAt(mx, my) {
    let best = null, bestD = 64;
    for (const a of authors) {
      const dx = x(xVal(a)) - mx, dy = y(yVal(a)) - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = a; }
    }
    return best;
  }
  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const hit = dotAt(e.clientX - r.left, e.clientY - r.top);
    if (hit !== hovered) { hovered = hit; dispatch("authorhover", hit); draw(); }
    canvas.style.cursor = hit ? "pointer" : "default";
  }
  function onLeave() {
    if (hovered) { hovered = null; dispatch("authorhover", null); draw(); }
  }
  function onClick(e) {
    const r = canvas.getBoundingClientRect();
    const hit = dotAt(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;
    // Ctrl/Cmd+click toggles the author in the selection (multi-select);
    // a plain click just opens their detail card.
    if (e.ctrlKey || e.metaKey) dispatch("authortoggle", hit);
    else dispatch("authorclick", hit);
  }

  let ro;
  onMount(() => {
    resize();
    ro = new ResizeObserver(resize);
    ro.observe(containerEl);
  });
  onDestroy(() => ro && ro.disconnect());
</script>

<div class="scatter" bind:this={containerEl}>
  <canvas bind:this={canvas} on:pointermove={onMove} on:pointerleave={onLeave} on:click={onClick}></canvas>
  {#if hovered}
    <div class="tip">
      <strong>{hovered.name}</strong>
      <span>{hovered.papers} papers · {yVal(hovered)} {yLabel.toLowerCase()}</span>
    </div>
  {/if}
</div>

<style>
  .scatter { position: relative; width: 100%; height: 100%; min-height: 0; background: var(--cjr-white); overflow: hidden; }
  canvas { display: block; }
  .tip {
    position: absolute; bottom: 8px; left: 8px;
    background: var(--cjr-blue); color: #fff; padding: 5px 9px; border-radius: 6px;
    font-size: 12px; pointer-events: none; max-width: 90%;
  }
  .tip span { opacity: 0.75; margin-left: 6px; font-size: 11px; }
</style>
