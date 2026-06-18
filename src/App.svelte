<script>
  import MapView from "./views/MapView.svelte";
  import GraphView from "./views/GraphView.svelte";

  const TABS = [
    { id: "map", label: "Semantic map" },
    { id: "graph", label: "COI network" },
  ];

  let activeTab = "map";
  // Mount heavy views lazily on first visit, then keep them mounted so their
  // internal state (zoom, filters, query results) survives tab switches.
  let visited = { map: true, graph: false };

  function selectTab(id) {
    activeTab = id;
    visited[id] = true;
  }
</script>

<div class="shell">
  <div class="topbar">
    <h1 class="app-title">PubMed articles: E-Cigarette</h1>

    <nav class="tabbar" role="tablist" aria-label="Dashboard views">
      {#each TABS as tab}
        <button
          class="tab"
          class:active={activeTab === tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          on:click={() => selectTab(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </nav>
  </div>

  <div class="content">
    <!-- Map stays mounted so it never re-loads data / loses zoom on tab switch -->
    <div class="pane" class:hidden={activeTab !== "map"}>
      <MapView />
    </div>

    {#if visited.graph}
      <div class="pane" class:hidden={activeTab !== "graph"}>
        <GraphView />
      </div>
    {/if}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* Title (left) and tabs (right) share one row, vertically centered, sitting
     on a single thin grey divider. */
  .topbar {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--cjr-border);
    padding: 0 16px;
  }
  .app-title {
    align-self: center;
    font-family: var(--font-body);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--cjr-text);
    margin: 0;
    line-height: 1.2;
  }

  .tabbar {
    display: flex;
    gap: 0;
    align-items: stretch;
  }

  .tab {
    appearance: none;
    border: none;
    background: transparent;
    font-family: var(--font-body);
    font-size: 14px;
    font-weight: 600;
    color: var(--cjr-text-muted);
    padding: 8px 14px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 0.12s ease, border-color 0.12s ease;
  }
  .tab:hover {
    color: var(--cjr-blue);
  }
  .tab.active {
    color: var(--cjr-blue);
    border-bottom-color: var(--cjr-accent);
  }

  .content {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }

  .pane {
    height: 100%;
    min-height: 0;
  }
  .pane.hidden {
    display: none;
  }
</style>
