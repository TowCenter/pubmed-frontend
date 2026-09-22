<script>
  import { onMount } from "svelte";
  import MapView from "./views/MapView.svelte";
  import GraphView from "./views/GraphView.svelte";
  import {
    selectedCollection, availableCollections, ALL_COLLECTIONS, slugify, collectionForSlug,
  } from "./stores/collectionFilter.js";
  import { resolveCollectionsUrl } from "./lib/dataUrl.js";

  const TABS = [
    { id: "map", label: "Semantic map" },
    { id: "graph", label: "COI network" },
  ];

  let activeTab = "map";
  // Mount heavy views lazily on first visit, then keep them mounted so their
  // internal state (zoom, filters, query results) survives tab switches.
  // Neither mounts at all until a collection is picked (see the gate below) —
  // their data fetches are scoped to $selectedCollection, so there's nothing
  // valid for them to load before then.
  let visited = { map: true, graph: false };

  function selectTab(id) {
    activeTab = id;
    visited[id] = true;
  }

  // --- collection list --------------------------------------------------
  // Fetched once, up front, from the lightweight /api/collections (dev) or
  // collections.json (prod) — deliberately decoupled from the heavy
  // per-collection CSV/graph fetches, so the picker below can show its
  // options before any article data loads.
  let collectionsLoading = true;
  let collectionsError = "";

  onMount(async () => {
    try {
      const res = await fetch(resolveCollectionsUrl(import.meta.env));
      if (!res.ok) throw new Error(`Could not load collection list (${res.status})`);
      $availableCollections = await res.json();
    } catch (e) {
      collectionsError = e.message || String(e);
    } finally {
      collectionsLoading = false;
    }
  });

  // --- URL <-> collection sync -------------------------------------------
  // The collection is addressable in the URL path, e.g. /pubmed-frontend/creatine
  // (root, /pubmed-frontend/, means "nothing picked yet" — see the gate below,
  // it never means "show everything"), so a link can be shared/bookmarked
  // straight into a scoped view.
  const BASE = import.meta.env.BASE_URL || "/";

  function slugFromPath(pathname) {
    let rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
    rest = rest.replace(/^\/+|\/+$/g, "").split("/")[0];
    return rest || null;
  }

  function pathForCollection(name) {
    return BASE + (name === ALL_COLLECTIONS ? "" : slugify(name));
  }

  // The slug read from the URL on first load, held until availableCollections
  // is populated (from the fetch above) so it can be resolved to a real name.
  let pendingSlug = null;
  let resolvedInitialSlug = false;

  function applySlug(slug) {
    $selectedCollection = collectionForSlug($availableCollections, slug) || ALL_COLLECTIONS;
  }

  onMount(() => {
    pendingSlug = slugFromPath(window.location.pathname);
    const onPopState = () => applySlug(slugFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  // Resolve the URL's initial slug as soon as we know what collections exist.
  $: if (!resolvedInitialSlug && $availableCollections.length) {
    resolvedInitialSlug = true;
    if (pendingSlug) applySlug(pendingSlug);
  }

  /** Gate screen / "change dataset" link: pick a collection, push its URL. */
  function chooseCollection(name) {
    $selectedCollection = name;
    const path = pathForCollection(name);
    if (window.location.pathname !== path) {
      history.pushState({}, "", path + window.location.search);
    }
  }

  /** Back to the gate — resets the selection and the URL. */
  function changeDataset() {
    chooseCollection(ALL_COLLECTIONS);
  }
</script>


<div class="shell">
  <div class="topbar">
    <h1 class="app-title">
      PubMed articles{$selectedCollection !== ALL_COLLECTIONS ? `: ${$selectedCollection}` : ""}
    </h1>

    {#if $selectedCollection !== ALL_COLLECTIONS}
      <div class="topbar-right">
        <button class="change-dataset" on:click={changeDataset} title="Pick a different dataset">
          Change dataset
        </button>

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
    {/if}
  </div>

  <div class="content">
    {#if collectionsLoading}
      <div class="gate">
        <p>Loading datasets…</p>
      </div>
    {:else if collectionsError}
      <div class="gate">
        <p class="gate-error">⚠ {collectionsError}</p>
      </div>
    {:else if $selectedCollection === ALL_COLLECTIONS}
      <div class="gate">
        <h2 class="gate-title">Pick a dataset to explore</h2>
        <div class="gate-options">
          {#each $availableCollections as c}
            <button class="gate-option" on:click={() => chooseCollection(c)}>{c}</button>
          {/each}
        </div>
      </div>
    {:else}
      <!-- Map stays mounted so it never re-loads data / loses zoom on tab switch -->
      <div class="pane" class:hidden={activeTab !== "map"}>
        <MapView />
      </div>

      {#if visited.graph}
        <div class="pane" class:hidden={activeTab !== "graph"}>
          <GraphView />
        </div>
      {/if}
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
    flex-wrap: wrap;
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

  .topbar-right {
    display: flex;
    align-items: stretch;
    gap: 12px;
  }

  .change-dataset {
    appearance: none;
    align-self: center;
    border: 1px solid var(--cjr-border);
    background: var(--cjr-white);
    font-family: var(--font-body);
    font-size: 12px;
    font-weight: 600;
    color: var(--cjr-text-muted);
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    transition: color 0.12s ease, border-color 0.12s ease;
  }
  .change-dataset:hover {
    border-color: var(--cjr-blue);
    color: var(--cjr-blue);
  }

  /* Required-selection gate: shown instead of the tabs/views whenever no
     dataset is picked yet (loading the list, an error, or nothing chosen). */
  .gate {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    text-align: center;
    padding: 24px;
    color: var(--cjr-text-muted);
  }
  .gate-title {
    font-family: var(--font-heading, var(--font-body));
    font-size: 18px;
    font-weight: 600;
    color: var(--cjr-text);
    margin: 0;
  }
  .gate-options {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
  }
  .gate-option {
    appearance: none;
    border: 1px solid var(--cjr-border);
    background: var(--cjr-white);
    font-family: var(--font-body);
    font-size: 14px;
    font-weight: 600;
    color: var(--cjr-text);
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  }
  .gate-option:hover {
    border-color: var(--cjr-blue);
    color: var(--cjr-blue);
    background: rgba(37, 76, 111, 0.06);
  }
  .gate-error {
    color: var(--cjr-danger, #921f1f);
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
