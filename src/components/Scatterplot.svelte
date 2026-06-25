<script>
  import { onMount } from "svelte";
  import { scaleLinear } from "d3-scale";
  import { max, min } from "d3-array";
  // Import from specific d3 packages, not the full "d3" meta-package, so the
  // CSV parser d3-dsv (which uses `new Function`) is never bundled — keeps the
  // app free of eval/new Function so it works under a strict CSP.
  import { select } from "d3-selection";
  import { zoom, zoomIdentity } from "d3-zoom";

  // Base dot color. Dots fall back to this unless the parent assigns a per-point
  // `groupColor` (one hue per selected author/org); active/inactive is otherwise
  // shown via opacity.
  const DOT_COLOR = "#1f77b4";

  export let data = [];
  export let domainColumn = "";
  export let opacity = 1;
  /** When false, slider controls all points; when true, active=0.9 and inactive=slider */
  export let anyFilterActive = false;
  export let selectedValues = new Set();
  export let searchQuery = "";
  export let highlightedData = [];
  export let startDate = null;
  export let endDate = null;
  export let hoveredData = null;
  export let selectedData = null;
  export let selectedPointIds = new Set();
  export let impactHighlightIds = new Set();

  let canvas;
  let containerEl;
  let ctx;
  let containerWidth = 800;
  let containerHeight = 600;
  const margin = { top: 20, right: 20, bottom: 20, left: 20 };
  const radius = 6;
  let lastHoveredData = null;
  let t = zoomIdentity;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 20;
  let selectionBox = null;
  let globalMouseUp = null;
  let didBoxSelectThisGesture = false;

  $: highlightedSet = new Set(highlightedData.map((d) => d.id));
  $: uniqueDomainCount = new Set(data.map((d) => d[domainColumn])).size;

  let zoomBehavior;
  let canvasSel;

  function matchesSearchQuery(text, query) {
    if (!query || !text) return false;
    try {
      return new RegExp(query, "i").test(text);
    } catch {
      return String(text).toLowerCase().includes(String(query).toLowerCase());
    }
  }

  function getMouseWorld(event) {
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const scaleX = containerWidth / rect.width;
    const scaleY = containerHeight / rect.height;
    const mouseX = (event.clientX - rect.left) * scaleX;
    const mouseY = (event.clientY - rect.top) * scaleY;
    return t.invert([mouseX, mouseY]);
  }

    /** Use isActive from parent (filteredData) so array columns and OR/AND logic match. */
    function isPointActive(d) {
      if (d && typeof d.isActive === 'boolean') return d.isActive;
      const hasSearch = !!(searchQuery && String(searchQuery).trim().length);
      const inSearch = hasSearch
        ? (matchesSearchQuery(d.title ?? '', searchQuery) || matchesSearchQuery(d.text ?? '', searchQuery))
        : true;
      const hasSelection = selectedValues && selectedValues.size > 0 && selectedValues.size < uniqueDomainCount;
      const inSelection = hasSelection ? selectedValues.has(d[domainColumn]) : true;
      const inDateRange = (startDate && endDate)
        ? (!!d.date && d.date >= startDate && d.date <= endDate)
        : true;
      return inSearch && inSelection && inDateRange;
    }


    
    $: innerWidth = containerWidth - margin.left - margin.right;
    $: innerHeight = containerHeight - margin.top - margin.bottom;
    
    // Guard scales against degenerate domains
    $: xDomainRaw = [min(data, d => d.x), max(data, d => d.x)];
    $: xDomain = (xDomainRaw[0] === xDomainRaw[1])
      ? [xDomainRaw[0] - 1, xDomainRaw[1] + 1]
      : xDomainRaw;
    $: xScale = scaleLinear()
      .domain(xDomain)
      .range([0, innerWidth]);
    
    $: yDomainRaw = [min(data, d => d.y), max(data, d => d.y)];
    $: yDomain = (yDomainRaw[0] === yDomainRaw[1])
      ? [yDomainRaw[0] - 1, yDomainRaw[1] + 1]
      : yDomainRaw;
    $: yScale = scaleLinear()
      .domain(yDomain)
      .range([innerHeight, 0]);
    
    // HiDPI setup and responsive sizing based on container element
    let dpr = 1;
    function setupCanvasDPI() {
      if (!canvas || !containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      // Keep containerWidth/Height in CSS pixels to sync scales and mouse events
      if (rect.width > 0 && rect.height > 0) {
        containerWidth = Math.floor(rect.width);
        containerHeight = Math.floor(rect.height);
      }
      dpr = Math.max(window.devicePixelRatio || 1, 1);
      // Visually fill container; internal pixel size scaled for crispness
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.width = Math.max(1, Math.floor(containerWidth * dpr));
      canvas.height = Math.max(1, Math.floor(containerHeight * dpr));
      ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

  function draw() {
      if (!ctx || !data.length) return;

      ctx.clearRect(0, 0, containerWidth, containerHeight);
      ctx.save();
      // Apply d3 zoom/pan transform
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      data.forEach(d => {
        // Use isActive and isHighlighted from filteredData
        ctx.beginPath();
        ctx.arc(margin.left + xScale(d.x), margin.top + yScale(d.y), Math.max(0.5, radius / t.k), 0, Math.PI * 2);
        // Active dots use their selection's group color (set per-point in the
        // parent); everything else falls back to the shared base color.
        ctx.fillStyle = (d.isActive && d.groupColor) ? d.groupColor : DOT_COLOR;
        // Opacity: when no filter active, slider controls all; when filter active, active=0.9 and inactive=slider
        const alpha = Math.max(0, Math.min(1, opacity));
        const activeAlpha = 0.9;
        const dotAlpha = anyFilterActive ? (d.isActive ? activeAlpha : alpha) : alpha;
        ctx.globalAlpha = dotAlpha;
        ctx.fill();
        ctx.globalAlpha = .2; // reset for next operations
      });

      ctx.setLineDash([]); // Reset line dash

      // Draw selected (pinned) point with distinct styling
      if (selectedData) {
        const baseX = margin.left + xScale(selectedData.x);
        const baseY = margin.top + yScale(selectedData.y);
        ctx.beginPath();
        ctx.arc(baseX, baseY, Math.max(0.5, (radius + 2) / t.k), 0, Math.PI * 2);
        ctx.fillStyle = selectedData.groupColor || DOT_COLOR;
        ctx.globalAlpha = 1;
        ctx.fill();
        ctx.strokeStyle = '#254c6f';
        ctx.lineWidth = Math.max(1, 3 / t.k);
        ctx.stroke();
      }

      // Draw hovered point (only if different from selected)
      if (hoveredData && hoveredData !== selectedData) {
        const baseX = margin.left + xScale(hoveredData.x);
        const baseY = margin.top + yScale(hoveredData.y);
        ctx.beginPath();
        ctx.arc(baseX, baseY, Math.max(0.5, radius / t.k), 0, Math.PI * 2);
        ctx.fillStyle = hoveredData.groupColor || DOT_COLOR;
        ctx.globalAlpha = 1;
        ctx.fill();
        ctx.strokeStyle = 'black';
        ctx.lineWidth = Math.max(1, 2 / t.k);
        ctx.stroke();
      }

      // Draw selection box (shift+drag)
      if (selectionBox) {
        const xMin = Math.min(selectionBox.x1, selectionBox.x2);
        const xMax = Math.max(selectionBox.x1, selectionBox.x2);
        const yMin = Math.min(selectionBox.y1, selectionBox.y2);
        const yMax = Math.max(selectionBox.y1, selectionBox.y2);
        ctx.fillStyle = 'rgba(222, 90, 53, 0.12)';
        ctx.strokeStyle = '#DE5A35';
        ctx.lineWidth = 2 / t.k;
        ctx.setLineDash([4, 3]);
        ctx.globalAlpha = 1;
        ctx.fillRect(xMin, yMin, xMax - xMin, yMax - yMin);
        ctx.strokeRect(xMin, yMin, xMax - xMin, yMax - yMin);
        ctx.setLineDash([]);
      }

      // Draw export-selection outlines (solid, tight to the circle)
      if (selectedPointIds && selectedPointIds.size > 0) {
        data.forEach(d => {
          if (!selectedPointIds.has(d.id)) return;
          const baseX = margin.left + xScale(d.x);
          const baseY = margin.top + yScale(d.y);
          ctx.beginPath();
          ctx.arc(baseX, baseY, Math.max(0.5, (radius + 1) / t.k), 0, Math.PI * 2);
          ctx.strokeStyle = '#DE5A35';
          ctx.lineWidth = Math.max(0.75, 1.5 / t.k);
          ctx.globalAlpha = 1;
          ctx.stroke();
        });
      }

      // Impact: highlight articles that cite the hovered one (distinct ring)
      if (impactHighlightIds && impactHighlightIds.size > 0) {
        data.forEach(d => {
          if (!impactHighlightIds.has(d.id)) return;
          const baseX = margin.left + xScale(d.x);
          const baseY = margin.top + yScale(d.y);
          ctx.beginPath();
          ctx.arc(baseX, baseY, Math.max(0.5, (radius + 1) / t.k), 0, Math.PI * 2);
          ctx.strokeStyle = '#2e7d32';
          ctx.setLineDash([4 / t.k, 3 / t.k]);
          ctx.lineWidth = Math.max(0.75, 1.5 / t.k);
          ctx.globalAlpha = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }

      ctx.restore();
    }
    
  // Removed stale click handler from pre d3-zoom implementation
    
  function handleMouseMove(event) {
      const rect = canvas.getBoundingClientRect();
      
      // Calculate scaling ratio between internal canvas dimensions and displayed dimensions
      const scaleX = containerWidth / rect.width;
      const scaleY = containerHeight / rect.height;
      
  // Adjust mouse coordinates based on the scaling ratio (canvas pixel coords)
  const mouseX = (event.clientX - rect.left) * scaleX;
  const mouseY = (event.clientY - rect.top) * scaleY;
    
  // Inverse transform via d3-zoom
  const [adjustedX, adjustedY] = t.invert([mouseX, mouseY]);
    
      // Update selection box while shift+dragging
      if (selectionBox) {
        selectionBox.x2 = adjustedX;
        selectionBox.y2 = adjustedY;
        draw();
        return;
      }
    
      const foundData = data.find(d => {
        const worldX = margin.left + xScale(d.x);
        const worldY = margin.top + yScale(d.y);
        const dx = worldX - adjustedX;
        const dy = worldY - adjustedY;
        const isInRange = Math.sqrt(dx * dx + dy * dy) < (radius + 3) / t.k;

        // Apply the same intersection logic for interactivity
        return isInRange && isPointActive(d);
      });

  if (foundData) {
        hoveredData = foundData;
        lastHoveredData = foundData;
        // indicate interactivity
        canvas.style.cursor = 'pointer';
      } else {
        hoveredData = null;
        lastHoveredData = null;
        canvas.style.cursor = 'crosshair';
      }

      draw();
    }

    function handleMouseDown(event) {
      if (!event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const [wx, wy] = getMouseWorld(event);
      selectionBox = { x1: wx, y1: wy, x2: wx, y2: wy };
      const onUp = (e) => {
        window.removeEventListener('mouseup', onUp);
        globalMouseUp = null;
        handleMouseUp(e);
      };
      globalMouseUp = onUp;
      window.addEventListener('mouseup', onUp);
      draw();
    }

    function handleMouseUp(event) {
      if (!selectionBox) return;
      const box = selectionBox;
      selectionBox = null;
      const xMin = Math.min(box.x1, box.x2);
      const xMax = Math.max(box.x1, box.x2);
      const yMin = Math.min(box.y1, box.y2);
      const yMax = Math.max(box.y1, box.y2);
      const idsToAdd = [];
      data.forEach(d => {
        if (!isPointActive(d)) return;
        const wx = margin.left + xScale(d.x);
        const wy = margin.top + yScale(d.y);
        if (wx >= xMin && wx <= xMax && wy >= yMin && wy <= yMax) {
          idsToAdd.push(d.id);
        }
      });
      if (idsToAdd.length > 0) {
        selectedPointIds = new Set([...selectedPointIds, ...idsToAdd]);
      }
      didBoxSelectThisGesture = true;
      draw();
    }

    function handleClick(event) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = containerWidth / rect.width;
      const scaleY = containerHeight / rect.height;
  const mouseX = (event.clientX - rect.left) * scaleX;
  const mouseY = (event.clientY - rect.top) * scaleY;
      const [adjustedX, adjustedY] = t.invert([mouseX, mouseY]);

      const foundData = data.find(d => {
        const worldX = margin.left + xScale(d.x);
        const worldY = margin.top + yScale(d.y);
        const dx = worldX - adjustedX;
        const dy = worldY - adjustedY;
        // Keep hit radius in screen pixels by scaling threshold by 1/k
        const isInRange = Math.sqrt(dx * dx + dy * dy) < (radius + 3) / t.k;

        return isInRange && isPointActive(d);
      });

      if (!foundData) {
        if (!event.shiftKey) selectedData = null;
        draw();
        return;
      }

      // Shift+click: toggle single point in selection (no drag)
      if (event.shiftKey) {
        if (didBoxSelectThisGesture) {
          didBoxSelectThisGesture = false;
          draw();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const newSet = new Set(selectedPointIds);
        if (newSet.has(foundData.id)) newSet.delete(foundData.id);
        else newSet.add(foundData.id);
        selectedPointIds = newSet;
        draw();
        return;
      }
      didBoxSelectThisGesture = false;

      // If Ctrl/Cmd is held, open URL in new tab (if available)
      if (event.ctrlKey || event.metaKey) {
        const url = foundData.url || foundData.link || foundData.href || foundData.permalink;
        if (url && typeof window !== 'undefined') {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
      }

      // Otherwise, pin/unpin the clicked point
      if (selectedData === foundData) {
        // Clicking the same point again unpins it
        selectedData = null;
      } else {
        // Pin the new point
        selectedData = foundData;
      }
      draw();
    }
    
    function handleMouseLeave() {
      hoveredData = lastHoveredData;
      draw();
    }
    
  let resizeObserver;
    onMount(() => {
      ctx = canvas.getContext('2d');
      setupCanvasDPI();
      // Observe size changes for responsiveness / DPR changes
      if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(() => {
          setupCanvasDPI();
          draw();
        });
    resizeObserver.observe(containerEl);
      }
      // Setup d3-zoom for wheel, double-click, and touch/pinch
  zoomBehavior = zoom()
        .scaleExtent([MIN_SCALE, MAX_SCALE])
        .filter((event) => {
          const e = event.sourceEvent ?? event;
          if (e.shiftKey) return false; // shift = selection mode (box or click), no pan/zoom
          if (e.type === 'wheel' || e.type === 'touchstart' || e.type === 'touchmove') return true;
          if (e.type === 'mousedown') return e.button === 0 && !e.ctrlKey && !e.metaKey;
          return !e.ctrlKey && !e.metaKey;
        })
        .on('zoom', (event) => {
          t = event.transform;
          draw();
        });
  canvasSel = select(canvas);
  canvasSel.call(zoomBehavior);
      draw();
      return () => {
        if (resizeObserver) resizeObserver.disconnect();
      };
    });

  // (Manual pan/zoom handlers removed in favor of d3-zoom)
    
    $: if (ctx) {
        data, opacity, anyFilterActive, selectedValues, searchQuery, domainColumn, startDate, endDate, selectedData, selectedPointIds, impactHighlightIds; // Watch these props
        if (data.length) draw(); // Redraw when any of these change
    }

    // Programmatic zoom controls
    function zoomBy(factor, evt) {
      evt?.stopPropagation?.();
      if (!canvasSel || !zoomBehavior) return;
      const cx = containerWidth / 2;
      const cy = containerHeight / 2;
      canvasSel.transition().duration(200).call(zoomBehavior.scaleBy, factor, [cx, cy]);
    }
    function zoomIn(evt) { zoomBy(1.25, evt); }
    function zoomOut(evt) { zoomBy(1/1.25, evt); }
    function resetZoom(evt) {
      evt?.stopPropagation?.();
      if (!canvasSel || !zoomBehavior) return;
      canvasSel.transition().duration(200).call(zoomBehavior.transform, zoomIdentity);
    }
</script>

<div class="chart-container" bind:this={containerEl}>
    <div class="zoom-controls" aria-label="Zoom controls">
      <button class="zoom-btn" aria-label="Zoom in" title="Zoom in" on:click={zoomIn}>+</button>
      <button class="zoom-btn" aria-label="Zoom out" title="Zoom out" on:click={zoomOut}>−</button>
      <button class="zoom-btn" aria-label="Reset zoom" title="Reset zoom" on:click={resetZoom}>⟲</button>
    </div>
    <div class="opacity-control" aria-label="Point opacity">
      <span class="opacity-label">Opacity</span>
      <input
        type="range"
        class="opacity-slider"
        min="0"
        max="1"
        step="0.01"
        bind:value={opacity}
      />
    </div>
    <canvas
      bind:this={canvas}
      width={containerWidth}
      height={containerHeight}
      on:mousedown={handleMouseDown}
      on:mousemove={handleMouseMove}
      on:mouseleave={handleMouseLeave}
      on:click={handleClick}
    ></canvas>
</div>

<style>
    .chart-container {
      position: relative; /* anchor for absolutely-positioned tooltip */
      display: flex;
      justify-content: center;
      align-items: center;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }
  
    canvas {
      cursor: crosshair;
      border-radius: 0;
      background-color: var(--cjr-white);
      width: 100%;
      height: 100%;
      display: block;
    }

    .zoom-controls {
      position: absolute;
      top: 12px;
      left: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 20;
      pointer-events: auto;
    }
    .zoom-btn {
      width: 34px;
      height: 34px;
      border-radius: 4px;
      border: 1px solid var(--cjr-border);
      background: var(--cjr-white);
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0;
      color: var(--cjr-text);
    }
    .zoom-btn:hover {
      background: var(--cjr-bg);
      border-color: var(--cjr-blue);
      color: var(--cjr-blue);
    }

    .opacity-control {
      position: absolute;
      bottom: 12px;
      left: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      z-index: 20;
      pointer-events: auto;
      background: var(--cjr-white);
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--cjr-border);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    }
    .opacity-label {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--cjr-text-muted);
      white-space: nowrap;
    }
    .opacity-slider {
      width: 72px;
      height: 5px;
      margin: 0;
      -webkit-appearance: none;
      appearance: none;
      background: var(--cjr-border);
      border-radius: 999px;
    }
    .opacity-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--cjr-blue);
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }
    .opacity-slider::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--cjr-blue);
      cursor: pointer;
      border: none;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }
</style>