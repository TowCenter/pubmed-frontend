<script>
  import { onMount, createEventDispatcher } from 'svelte';
  import { scaleOrdinal } from 'd3-scale';
  import { schemeCategory10 } from 'd3-scale-chromatic';

  const dispatch = createEventDispatcher();

  export let hoveredData;
  export let domainColumn;
  export let data;
  export let colorScale;
  export let searchQuery = "";
  export let isPinned = false;
  export let labelOverride = null;
  export let descriptionOverride = null;

  onMount(() => {
      colorScale.domain(data.map(d => d[domainColumn]));
  });

  // Function to highlight search terms in text
  function highlightText(text, query) {
    if (!query || !text) return text;

    try {
      // Try to use the query as a regex pattern
      const regex = new RegExp(`(${query})`, 'gi');
      return text.replace(regex, '<mark>$1</mark>');
    } catch (e) {
      // If regex is invalid, fall back to simple string search
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedQuery})`, 'gi');
      return text.replace(regex, '<mark>$1</mark>');
    }
  }

  /** PMIDs that exist in the loaded dataset (for filtering citing lists). */
  function pmidsInDataset() {
    return new Set(
      (data || [])
        .map((d) => String(d.pmid ?? d.PMID).trim())
        .filter(Boolean),
    );
  }

  function parseMeshTerms(val) {
    if (val == null) return [];
    if (Array.isArray(val)) {
      return val.map((v) => String(v).trim()).filter(Boolean);
    }
    const s = String(val).trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      const inner = s.slice(1).replace(/\]+$/, "").trim();
      if (!inner) return [];
      return inner
        .split(/,\s*/)
        .map((x) => x.replace(/^['"]\s*|['"]\s*$/g, "").trim())
        .filter(Boolean);
    }
    return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  }

  /**
   * Build a per-author list with each author's disclosed COI organizations.
   * Prefers the structured `authors_detail` JSON; falls back to splitting the
   * flat `authors` string (no COI info) for older data.
   */
  function parseAuthorsDetail(raw, authorsFallback) {
    if (raw != null && String(raw).trim() !== '') {
      try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(arr)) {
          return arr
            .filter((a) => a && a.name)
            .map((a) => ({
              name: String(a.name).trim(),
              coi: Array.isArray(a.coi)
                ? [...new Set(
                    a.coi
                      .flatMap((c) => String(c).split(';'))
                      .map((c) => c.trim())
                      .filter(Boolean),
                  )]
                : [],
            }));
        }
      } catch { /* fall through to flat list */ }
    }
    if (authorsFallback == null || String(authorsFallback).trim() === '') return [];
    return String(authorsFallback)
      .split(/[;]/)
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => ({ name, coi: [] }));
  }

  $: authorsDetail = parseAuthorsDetail(
    hoveredData && hoveredData.authors_detail,
    hoveredData && hoveredData.authors,
  );
</script>

<div class="detail-card">
  {#if hoveredData}
    {#if isPinned}
      <div class="pin-header">
        <span class="pin-indicator">📌 Pinned</span>
        <button class="unpin-btn" on:click={() => dispatch('unpin')}>✕</button>
      </div>
    {/if}
    <div class="pmid-date-line">
      {#if hoveredData.pmid || hoveredData.PMID}
        <a
          href="https://pubmed.ncbi.nlm.nih.gov/{hoveredData.pmid || hoveredData.PMID}"
          target="_blank"
          rel="noopener noreferrer"
          class="pmid-link"
        >PMID {hoveredData.pmid || hoveredData.PMID}</a>
      {/if}
      {#if hoveredData.date}
        <span class="card-date">{hoveredData.date.toISOString().split('T')[0]}</span>
      {/if}
    </div>
    {#if hoveredData.url || hoveredData.link || hoveredData.href || hoveredData.permalink}
      <a
        href={hoveredData.url || hoveredData.link || hoveredData.href || hoveredData.permalink}
        target="_blank"
        rel="noopener noreferrer"
        class="title-link"
      >
        <h1>{@html highlightText(hoveredData.title, searchQuery)}</h1>
      </a>
    {:else}
      <h1>{@html highlightText(hoveredData.title, searchQuery)}</h1>
    {/if}
    {#if authorsDetail.length}
      <div class="authors-block">
        <p class="authors-label">Authors</p>
        <ul class="authors-list">
          {#each authorsDetail as author}
            <li class="author-item" class:has-coi={author.coi.length}>
              <span class="author-name">{author.name}</span>
              {#if author.coi.length}
                <span class="author-coi-tags">
                  {#each author.coi as org}
                    <span class="coi-tag" title="Disclosed conflict of interest">{org}</span>
                  {/each}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if (hoveredData.keywords ?? hoveredData['mesh terms']) != null && (hoveredData.keywords ?? hoveredData['mesh terms']) !== ''}
      {@const terms = parseMeshTerms(hoveredData.keywords ?? hoveredData['mesh terms'])}
      {#if terms.length > 0}
        <div class="mesh-terms-block">
          <p class="mesh-terms-label">Keywords &amp; MeSH Terms</p>
          <div class="mesh-terms-tags">
            {#each terms as term}
              <span class="mesh-tag">{term}</span>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
    {#if hoveredData.citationCount != null && hoveredData.citationCount > 0}
      {@const inDataset = pmidsInDataset()}
      {@const selfPmid = String(hoveredData.pmid ?? hoveredData.PMID ?? '').trim()}
      {@const citedInDataset = (hoveredData.citedByPmids || []).filter((p) => {
        const s = String(p).trim();
        return s && s !== selfPmid && inDataset.has(s);
      })}
      <div class="impact-block">
        <p class="impact-label">Cited By</p>
        {#if citedInDataset.length > 0}
          <p class="impact-sublabel">Citing PMIDs: {hoveredData.citationCount} total, {citedInDataset.length} in this dataset:</p>
          <div class="cited-pmids">
            {#each citedInDataset.slice(0, 20) as pmid, i}
              {#if i > 0}, {/if}
              <a
                href="https://pubmed.ncbi.nlm.nih.gov/{pmid}"
                target="_blank"
                rel="noopener noreferrer"
                class="pmid-link"
                on:mouseenter={() => dispatch('citingPmidHover', { pmid })}
                on:mouseleave={() => dispatch('citingPmidHover', { pmid: null })}
              >{pmid}</a>
            {/each}
            {#if citedInDataset.length > 20}
              <span class="pmid-more"> … and {citedInDataset.length - 20} more</span>
            {/if}
          </div>
        {:else}
          <p class="impact-sublabel">Citing PMIDs: {hoveredData.citationCount} total, 0 in this dataset.</p>
        {/if}
      </div>
    {:else if hoveredData.citationCount === 0}
      <p class="impact-none">Not cited by other articles in this set.</p>
    {/if}
    {#if descriptionOverride}
      {#if descriptionOverride(domainColumn, hoveredData[domainColumn])}
        <p><em>{descriptionOverride(domainColumn, hoveredData[domainColumn])}</em></p>
      {/if}
    {/if}
    <div class="article-text-block">
      <p class="article-text-label">Abstract</p>
      <p class="article-text-content">{@html highlightText(hoveredData.abstract ?? hoveredData.text ?? '', searchQuery)}</p>
    </div>
  {:else}
    <p class="placeholder-intro">Each dot represents an article. When the dots are closer together, the articles are similar in meaning.</p>
    <p class="placeholder-text">{isPinned ? 'Click on a circle to pin it here.' : 'Hover over a circle to see details here.'}</p>
  {/if}
</div>

<style>
  .detail-card {
    padding: 0;
    border-radius: 4px;
    background: var(--cjr-white);
    height: 100%;
    overflow-y: auto;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    font-family: var(--font-body);
    color: var(--cjr-text);
  }

  h1 {
    margin: 0;
    padding: 0;
    font-weight: 400;
  }

  h1 {
    font-family: var(--font-heading);
    font-size: 1.1rem;
    font-weight: 500;
    line-height: 1.4;
    color: var(--cjr-text);
  }

  .title-link {
    text-decoration: none;
    color: var(--cjr-accent);
    display: block;
    cursor: pointer;
  }

  .title-link h1 {
    color: var(--cjr-accent);
  }

  .title-link:hover h1 {
    text-decoration: underline;
    color: var(--cjr-accent-hover);
  }

  .pmid-date-line {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    font-size: 0.85rem;
  }

  .card-date {
    color: var(--cjr-text-muted);
    padding: 0;
    background: transparent;
    border-radius: 0;
  }

  .authors-block {
    margin: 0.25rem 0;
  }
  .authors-label {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--cjr-blue);
    margin: 0 0 0.35rem 0;
  }
  .authors-list {
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--cjr-text);
    margin: 0;
    padding: 0;
    list-style: none;
    word-wrap: break-word;
  }
  .author-item {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.35rem 0.5rem;
    padding: 0.15rem 0;
  }
  .author-item.has-coi {
    border-left: 2px solid #a3361f;
    padding-left: 0.5rem;
    margin-left: -0.5rem;
  }
  .author-name {
    font-weight: 500;
    color: var(--cjr-text);
    padding: 0;
  }
  .author-coi-tags {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    padding: 0;
    color: var(--cjr-text);
  }

  .mesh-terms-block {
    padding: 0.75rem 0;
    margin: 0.25rem 0;
  }
  .impact-block {
    padding: 0.5rem 0;
    margin: 0.25rem 0;
  }
  .impact-label {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--cjr-blue);
    margin: 0 0 0.35rem 0;
  }
  .impact-sublabel {
    font-size: 0.72rem;
    color: var(--cjr-text-muted);
    margin: 0 0 0.25rem 0;
  }
  .cited-pmids {
    font-size: 0.8rem;
    line-height: 1.5;
    margin: 0;
  }
  .pmid-link {
    color: var(--cjr-accent);
    text-decoration: none;
  }
  .pmid-link:hover {
    text-decoration: underline;
    color: var(--cjr-accent-hover);
  }
  .pmid-more {
    color: var(--cjr-text-muted);
    font-style: italic;
  }
  .impact-none {
    font-size: 0.8rem;
    color: var(--cjr-text-muted);
    margin: 0;
    font-style: italic;
  }

  .mesh-terms-label {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--cjr-blue);
    margin: 0 0 0.5rem 0;
  }

  .mesh-terms-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0;
  }

  .mesh-tag {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--cjr-blue);
    background: rgba(37, 76, 111, 0.1);
    border: 1px solid rgba(37, 76, 111, 0.22);
    border-radius: 999px;
  }

  .coi-tag {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    font-size: 0.72rem;
    font-weight: 500;
    color: #a3361f;
    background: rgba(163, 54, 31, 0.08);
    border: 1px solid rgba(163, 54, 31, 0.25);
    border-radius: 999px;
  }

  .article-text-block {
    margin-top: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--cjr-border);
  }

  .article-text-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--cjr-text-muted);
    margin: 0 0 0.4rem 0;
  }

  .article-text-content {
    font-size: 0.9rem;
    line-height: 1.6;
    color: var(--cjr-text);
    margin: 0;
  }

  span {
    padding: 4px 8px;
    display: inline-block;
    vertical-align: bottom;
    border-radius: 4px;
    color: white;
    font-size: 0.8rem;
    width: fit-content;
  }

  p {
    font-size: 0.9rem;
    font-weight: 400;
    margin: 0;
    line-height: 1.6;
    color: var(--cjr-text);
  }

  .placeholder-intro {
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--cjr-text);
    margin: 0 0 0.75rem 0;
  }

  .placeholder-text {
    color: var(--cjr-text-muted);
    font-style: italic;
  }

  :global(.detail-card mark) {
    background-color: rgba(222, 90, 53, 0.25);
    color: var(--cjr-text);
    padding: 0 2px;
    border-radius: 2px;
  }

  .pin-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    margin-bottom: 0.5rem;
  }

  .pin-indicator {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--cjr-blue);
  }

  .unpin-btn {
    background: transparent;
    border: none;
    font-size: 1.2rem;
    cursor: pointer;
    color: var(--cjr-text-muted);
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .unpin-btn:hover {
    background: rgba(0, 0, 0, 0.06);
    color: var(--cjr-text);
  }
</style>