<script>
  import { onMount, tick } from "svelte";
  import Papa from "papaparse";
  import Scatterplot from "./components/Scatterplot.svelte";
  import RangeSlider from "./components/RangeSlider.svelte";
  import DetailCard from "./components/DetailCard.svelte";
  import { scaleOrdinal } from 'd3-scale';
  import { schemeCategory10 } from 'd3-scale-chromatic';

  // Resolve data URL from query params (url | filename [+ bucket]) or env fallback
  let resolvedDataUrl = "";
  function resolveDataUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const directUrl = params.get("url");
      const filename = params.get("filename");
      const bucket = params.get("bucket");

      // Highest priority: full URL provided
      if (directUrl && /^https?:\/\//i.test(directUrl)) return directUrl;

      // Build from filename and (optional) bucket
      if (filename) {
        // Determine base from bucket param or env
        let base = "";
        if (bucket) {
          if (/^https?:\/\//i.test(bucket)) {
            base = bucket;
          } else if (bucket.includes(".")) {
            // Looks like a host (e.g. my-bucket.s3.amazonaws.com or custom domain)
            base = `https://${bucket}`;
          } else {
            // Treat as bare S3 bucket name
            base = `https://${bucket}.s3.amazonaws.com`;
          }
        } else {
          // Env-configured default base (e.g. https://my-bucket.s3.amazonaws.com/)
          base =
            import.meta.env.VITE_S3_BASE_URL ||
            import.meta.env.VITE_DATA_BASE_URL ||
            "https://pink-slime-public.s3.amazonaws.com/";
        }
        if (base && !base.endsWith("/")) base += "/";
        return base ? base + filename : filename;
      }

      // Fallbacks: explicit env or local file in /public (use root path so it works with base path)
      return import.meta.env.VITE_DATA_URL || (import.meta.env.BASE_URL || "/") + "data-with-xy.csv";
    } catch (e) {
      console.warn("Failed to resolve data URL from query params:", e);
      return import.meta.env.VITE_DATA_URL || (import.meta.env.BASE_URL || "/") + "data-with-xy.csv";
    }
  }

  let data = [],
    columns = [],
    domainColumn = "",
    uniqueValues = [];
  let selectedValues = new Set();
  /** "or" = match any selected value; "and" = match all selected values (row must contain every selected value). */
  let highlightMatchMode = "or";
  let opacity = 0.05,
    startDate = null,
    endDate = null;
  let filteredData = [],
    allDates = [];
  let startDateIndex = 0;
  let endDateIndex = 0;
  let isPlaying = false;
  let playInterval = null;
  let highlightedData = [];

  let searchQuery = "";
  let highlightSearchQuery = "";
  let showAnnotations = false;
  let hideNoAbstract = false; // when true, drop articles with no abstract from the map

  let hoveredData = null;
  let selectedData = null; // Pinned/clicked data
  let selectedPointIds = new Set(); // Shift+drag or shift+click for export
  let activePmids = 0;

  // hideNoAbstract is a hard filter: abstract-less articles are removed from the
  // map entirely (not just dimmed), so they also drop out of the PMID counts.
  $: displayData = hideNoAbstract
    ? filteredData.filter((d) => (d.abstract ?? d.text ?? "").trim() !== "")
    : filteredData;

  /** Total rows in dataset. */
  $: totalPmids = displayData ? displayData.length : 0;
  /** Count of rows passing current filters (shown on map). */
  $: activePmids = displayData ? displayData.filter((d) => d.isActive).length : 0;

  // Impact: highlight "cited by" articles. Two modes:
  // 1) On hover/pin: highlight articles that cite the hovered/pinned one.
  // 2) "Active set" mode: highlight all articles that cite ANY of the currently active (highlighted) circles.
  let impactHighlightOn = false;
  let highlightCitingForActiveSet = false;
  /** Returns Set of row ids in filteredData whose PMID is in the given citedByPmids list. */
  function getCitingArticleIds(citedByPmids, dataSource) {
    if (!citedByPmids?.length || !dataSource?.length) return new Set();
    const pmidSet = new Set(
      citedByPmids.map((p) => String(p).trim()).filter(Boolean),
    );
    if (!pmidSet.size) return new Set();
    return new Set(
      dataSource
        .filter((d) => {
          const pmid = d.pmid ?? d.PMID;
          return pmid != null && pmidSet.has(String(pmid).trim());
        })
        .map((d) => d.id),
    );
  }
  $: impactHighlightIds = highlightCitingForActiveSet
    ? (() => {
        const activeArticles = filteredData.filter((d) => d.isActive);
        if (!activeArticles.length) return new Set();
        const allCitedByPmids = activeArticles.flatMap((a) => a.citedByPmids || []);
        return getCitingArticleIds(allCitedByPmids, filteredData);
      })()
    : impactHighlightOn && (selectedData || hoveredData)
      ? getCitingArticleIds(
          (selectedData || hoveredData).citedByPmids || [],
          filteredData,
        )
      : new Set();

  // When pinned, show hovered article in card if it's one of the "cited by" articles
  $: displayedData =
    selectedData && hoveredData && impactHighlightIds.has(hoveredData.id)
      ? hoveredData
      : selectedData || hoveredData;

  // Color scale for the detail card
  $: colorScale = scaleOrdinal(schemeCategory10)
    .domain(domainColumn ? uniqueValues : []);

  // Computed min/max dates from actual data
  $: minDateFromData = allDates.length > 0 ? allDates[0] : null;
  $: maxDateFromData = allDates.length > 0 ? allDates[allDates.length - 1] : null;

  const NON_CATEGORICAL_COLUMNS = new Set([
    // Free-text / per-row-unique fields that make no sense as highlight categories.
    // "coi" is the raw disclosure text (kept for search/detail); "coi_org" holds
    // the clean, selectable organizations instead.
    "x", "y", "date", "id", "embedding", "n_tokens", "abstract", "text", "coi",
  ]);

  // Friendlier labels for the "Highlight by column" dropdown (falls back to the
  // raw column name for anything not listed).
  const COLUMN_LABELS = {
    coi_org: "COI organization",
    affiliations: "Affiliation",
    funding: "Funding",
    authors: "Author",
    keywords: "Keyword",
    journal: "Journal",
  };
  const columnLabel = (c) => COLUMN_LABELS[c] || c;
  const IMPACT_HIGH = "High (10+)";
  const IMPACT_MEDIUM = "Medium (1–9)";
  const IMPACT_NONE = "None (0)";
  $: allowedDomainColumns = columns.filter(
    (c) => c && !NON_CATEGORICAL_COLUMNS.has(c),
  );
  $: filteredUniqueValues = !highlightSearchQuery.trim()
    ? uniqueValues
    : uniqueValues.filter((v) =>
        String(v).toLowerCase().includes(highlightSearchQuery.trim().toLowerCase()),
      );

  $: {
    if (!columns || columns.length === 0) {
      // wait until parsed
    } else if (
      allowedDomainColumns.length &&
      domainColumn &&
      !allowedDomainColumns.includes(domainColumn)
    ) {
      domainColumn = allowedDomainColumns[0];
    } else if (allowedDomainColumns.length === 0) {
      domainColumn = "";
    }
  }

  // Keep highlight values in sync with Color by column (so reset and column change always show correct list)
  $: if (domainColumn && data && data.length) {
    uniqueValues = [
      ...new Set(data.flatMap((d) => parseColumnValueToItems(d[domainColumn]))),
    ].sort((a, b) => String(a).localeCompare(String(b)));
  } else {
    uniqueValues = [];
  }

  // Loading/progress state
  let isLoading = false;
  let loadPhase = "idle"; // 'downloading' | 'unzipping' | 'parsing' | 'idle'
  let loadBytes = 0;
  let loadTotal = 0;
  let loadProgress = 0; // 0-100 when total known
  let parsedRows = 0; // rows kept so far while streaming-parsing
  let loadError = "";

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 KB";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const dp = i === 0 ? 0 : 1;
    return `${v.toFixed(dp)} ${units[i]}`;
  }

  onMount(async () => {
    try {
      loadError = "";
      isLoading = true;
      loadPhase = "downloading";
      loadBytes = 0;
      loadTotal = 0;
      loadProgress = 0;

      // Determine the final data URL once on mount
      resolvedDataUrl = resolveDataUrl();
      const isZipFile = resolvedDataUrl.toLowerCase().endsWith('.zip');

      const response = await fetch(resolvedDataUrl, {
        mode: "cors",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      loadError = "";
      const len = response.headers.get("content-length");
      loadTotal = len ? parseInt(len, 10) : 0;

      let dataBytes;
      if (response.body && response.body.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        // Stream and accumulate while reporting progress
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          loadBytes = received;
          if (loadTotal) {
            loadProgress = Math.round((received / loadTotal) * 100);
          }
        }
        const full = new Uint8Array(received);
        let offset = 0;
        for (const c of chunks) {
          full.set(c, offset);
          offset += c.byteLength;
        }
        dataBytes = full;
      } else {
        // Fallback without streaming/progress
        const arrayBuffer = await response.arrayBuffer();
        dataBytes = new Uint8Array(arrayBuffer);
      }

      let csvText = "";
      if (isZipFile) {
        loadPhase = "unzipping";
        await tick();

        const { default: JSZip } = await import("jszip"); // lazy: keeps jszip out of the main bundle
        const zip = new JSZip();
        const zipContent = await zip.loadAsync(dataBytes);

        const csvFile = Object.keys(zipContent.files).find(
          (name) => name.toLowerCase().endsWith(".csv") && !zipContent.files[name].dir,
        );

        if (!csvFile) {
          throw new Error("No CSV file found in ZIP archive");
        }

        csvText = await zipContent.files[csvFile].async("text");
      } else {
        csvText = new TextDecoder().decode(dataBytes);
      }

      loadPhase = "parsing";
      await tick();
      await parseData(csvText);
      loadPhase = "idle";
    } catch (err) {
      loadError = err?.message || String(err);
    } finally {
      isLoading = false;
    }

    return () => {
      if (playInterval) clearInterval(playInterval);
    };
  });

  let anyFilterActive = false;
  $: {
    // Determine if any filter is active
    const fullDateRange =
      allDates.length &&
      startDateIndex === 0 &&
      endDateIndex === allDates.length - 1;
    const hasSelection =
      selectedValues.size > 0 && selectedValues.size < uniqueValues.length;
    const hasSearch = searchQuery && searchQuery.trim().length > 0;
    anyFilterActive = !fullDateRange || hasSelection || hasSearch;

    filteredData = data.map((d) => {
      const inDateRange =
        (!startDate || d.date >= startDate) &&
        (!endDate || d.date <= endDate);
      let inSelection = true;
      if (hasSelection && selectedValues.size > 0) {
        const raw = d[domainColumn];
        const rowValues = rowValuesForColumn(raw);
        if (highlightMatchMode === "or") {
          inSelection = rowValues.some((v) => selectedValues.has(v));
        } else {
          inSelection = [...selectedValues].every((v) => rowValues.includes(v));
        }
      }
      let inSearch = true;
      if (hasSearch) {
        // Fields the keyword search looks through.
        const haystack = [
          d.title, d.abstract ?? d.text, d.authors,
          d.coi, d.coi_org, d.affiliations, d.funding,
        ].filter((v) => v != null).join("\n");
        try {
          const regex = new RegExp(searchQuery, "i");
          inSearch = regex.test(haystack);
        } catch {
          inSearch = haystack.toLowerCase().includes(searchQuery.toLowerCase());
        }
      }

      const passes = inDateRange && inSelection && inSearch;
      return {
        ...d,
        isActive: anyFilterActive ? passes : true,
        isHighlighted: anyFilterActive ? passes : true,
      };
    });

  }

  /**
   * Parse a cell value into an array of individual items.
   * Handles: JSON array "[\"a\",\"b\"]", Python-style "['a','b']", comma/semicolon-separated, or single value.
   */
  function parseColumnValueToItems(raw) {
    if (raw == null || raw === "") return [];
    const s = String(raw).trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
      } catch {
        // Python-style: ['Item1', ' Item2'] — extract quoted segments
        const out = [];
        const re = /['"]([^'"]*)['"]/g;
        let m;
        while ((m = re.exec(s)) !== null) out.push(m[1].trim());
        if (out.length > 0) return out.filter(Boolean);
      }
    }
    if (s.includes(",") || s.includes(";")) {
      return s.split(/[,;]/).map((v) => v.trim()).filter(Boolean);
    }
    return [s];
  }

  /** Normalize a cell value to an array of values for highlight matching (uses parseColumnValueToItems). */
  function rowValuesForColumn(raw) {
    return parseColumnValueToItems(raw);
  }

  $: startPercent =
    allDates.length > 1 ? (startDateIndex / (allDates.length - 1)) * 100 : 0;
  $: endPercent =
    allDates.length > 1 ? (endDateIndex / (allDates.length - 1)) * 100 : 100;

  // Use actual max date from data instead of arbitrary cap
  $: maxAllowedIndex = allDates.length > 0 ? allDates.length - 1 : 0;

  function parseCitedByPmids(val) {
    if (val == null) return [];
    const s = String(val).trim();
    if (!s) return [];
    try {
      let parsed = null;
      try {
        parsed = JSON.parse(s);
      } catch {
        const normalized = s.replace(/""/g, '"');
        parsed = JSON.parse(normalized);
      }
      if (Array.isArray(parsed)) return parsed.map((p) => String(p).trim()).filter(Boolean);
      return [];
    } catch {
      return s.split(/[,\s;]+/).map((p) => p.replace(/^["'\s]+|["'\s]+$/g, "")).filter(Boolean);
    }
  }

  /**
   * Stream-parse CSV data into `data`.
   * Accepts a File/Blob (read in async chunks — no giant intermediate string,
   * no main-thread freeze) or a raw CSV string. Rows are processed as each
   * chunk arrives rather than buffering the whole file first.
   */
  function parseData(input) {
    return new Promise((resolve, reject) => {
      data = [];
      columns = [];
      parsedRows = 0;
      loadError = "";
      let headerCaptured = false;

      Papa.parse(input, {
        header: true,
        skipEmptyLines: true,
        // Note: transformHeader is a function, so this must NOT run in a worker
        // (Papa postMessages the config to the worker and functions can't be cloned).
        transformHeader: (header) => header.trim().toLowerCase(),
        chunkSize: 5 * 1024 * 1024, // 5 MB slices → stream + yield between chunks
        chunk: (results) => {
          if (!headerCaptured && results.meta && results.meta.fields) {
            columns = results.meta.fields;
            headerCaptured = true;
          }
          const rows = results.data;
          for (let i = 0; i < rows.length; i++) {
            const d = rows[i];
            if (!d.x || !d.y || !d.date) continue;
            const numX = +d.x;
            const numY = +d.y;
            const date = d.date instanceof Date ? d.date : new Date(d.date);
            if (Number.isNaN(numX) || Number.isNaN(numY) || Number.isNaN(date.getTime())) continue;
            const citedByPmids = parseCitedByPmids(d.cited_by_pmids);
            const citationCount = citedByPmids.length;
            const impactBucket =
              citationCount >= 10 ? IMPACT_HIGH : citationCount >= 1 ? IMPACT_MEDIUM : IMPACT_NONE;
            data.push({
              ...d,
              x: numX,
              y: numY,
              date,
              id: data.length,
              citationCount,
              citedByPmids,
              impact: impactBucket,
            });
          }
          parsedRows = data.length; // drives the live "parsed N rows" label
        },
        complete: () => {
          if (data.length === 0) {
            loadError =
              "CSV parsed successfully, but no valid rows were found. Please ensure your file contains valid x, y, and date columns.";
          }

          const dateSet = new Set();
          for (let i = 0; i < data.length; i++) dateSet.add(data[i].date.getTime());
          allDates = [...dateSet].sort((a, b) => a - b).map((t) => new Date(t));
          startDate = allDates[0];
          endDate = allDates[allDates.length - 1];
          startDateIndex = 0;
          endDateIndex = allDates.length - 1;
          updateDateIndices();
          selectedPointIds = new Set();
          if (data.some((r) => r.impact != null)) columns = [...columns, "impact"];
          data = data.slice();
          resolve();
        },
        error: (error) => {
          loadError = error?.message || String(error);
          console.error("Papa Parse error:", error);
          reject(error);
        },
      });
    });
  }

  function handleDomainChange(event) {
    domainColumn = event.target.value;
    selectedValues = new Set();
    highlightSearchQuery = "";
    showAnnotations = false;
  }

  function handleSelectionChange(event) {
    const selectedOptions = [...event.target.selectedOptions].map(
      (o) => o.value,
    );
    // When list is filtered, merge: keep selection for hidden items, use DOM for visible
    const visibleSet = new Set(filteredUniqueValues);
    const selectedHidden = [...selectedValues].filter((v) => !visibleSet.has(v));
    const newSelected = new Set([...selectedHidden, ...selectedOptions]);

    const allSelected = newSelected.size === uniqueValues.length;
    if (allSelected || newSelected.size === 0) {
      selectedValues = new Set();
      highlightedData = [];
    } else {
      selectedValues = newSelected;
      if (newSelected.size > 0) opacity = 0.25;
      highlightedData = data.filter((d) => {
        const rowValues = parseColumnValueToItems(d[domainColumn]);
        const match =
          highlightMatchMode === "or"
            ? rowValues.some((v) => selectedValues.has(v))
            : [...selectedValues].every((v) => rowValues.includes(v));
        return (
          match &&
          (!startDate || d.date >= startDate) &&
          (!endDate || d.date <= endDate)
        );
      });
    }

    showAnnotations = false;
  }

  function updateSelectedDates(start, end, fromIndices = false) {
    if (fromIndices) {
      startDate = allDates[start] || allDates[0];
      endDate = allDates[end] || allDates[allDates.length - 1];
    } else {
      startDate = start;
      endDate = end;
    }
    showAnnotations = false;
    updateDateIndices();
  }

  function updateDateIndices() {
    if (startDate) {
      const timestamp = startDate.getTime();
      startDateIndex = Math.max(
        0,
        allDates.findIndex((d) => d.getTime() >= timestamp),
      );
    } else {
      startDateIndex = 0;
    }

    if (endDate) {
      const timestamp = endDate.getTime();
      let ei = -1;
      for (let i = allDates.length - 1; i >= 0; i--) {
        if (allDates[i].getTime() <= timestamp) {
          ei = i;
          break;
        }
      }
      endDateIndex = ei >= 0 ? ei : allDates.length - 1;
    } else {
      endDateIndex = allDates.length - 1;
    }

    if (startDateIndex > endDateIndex) startDateIndex = endDateIndex;
    if (endDateIndex < startDateIndex) endDateIndex = startDateIndex;
  }

  function handleDateChange(e, type) {
    if (e.detail !== undefined) {
      // Handle slider events
      if (type === "start") {
        startDateIndex = e.detail;
        if (startDateIndex > endDateIndex) startDateIndex = endDateIndex;
      } else {
        endDateIndex = e.detail;
        if (endDateIndex < startDateIndex) endDateIndex = startDateIndex;
      }
      // Update dates based on the indices
      updateSelectedDates(startDateIndex, endDateIndex, true);
    } else {
      // Handle date input events
      const newDate = e.target.value ? new Date(e.target.value) : null;

      if (type === "start") {
        updateSelectedDates(newDate, endDate);
      } else {
        updateSelectedDates(startDate, newDate);
      }

      // Update indices based on the new dates
      updateDateIndices();
    }
  }

  function formatDateInput(date) {
    return date ? date.toISOString().split("T")[0] : "";
  }

  function getSelectedPmids() {
    return data
      .filter((d) => selectedPointIds.has(d.id))
      .map((d) => d.pmid ?? d.PMID)
      .filter((v) => v !== undefined && v !== null && v !== "");
  }

  function exportPmids() {
    const pmids = getSelectedPmids();
    if (pmids.length === 0) return;
    const text = pmids.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pmids.txt";
    a.click();
    URL.revokeObjectURL(url);
    try {
      navigator.clipboard.writeText(text);
    } catch (_) {}
  }

  function clearPointSelection() {
    selectedPointIds = new Set();
  }

  async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (file) {
      showAnnotations = false;
      const isZipFile = file.name.toLowerCase().endsWith('.zip');

      if (isZipFile) {
        try {
          isLoading = true;
          loadPhase = "unzipping";
          await tick();
          const arrayBuffer = await file.arrayBuffer();
          const { default: JSZip } = await import("jszip"); // lazy: keeps jszip out of the main bundle
          const zip = new JSZip();
          const zipContent = await zip.loadAsync(arrayBuffer);
          const csvFile = Object.keys(zipContent.files).find((name) =>
            name.toLowerCase().endsWith(".csv") && !zipContent.files[name].dir,
          );
          if (!csvFile) throw new Error("No CSV file found in ZIP archive");
          const csvText = await zipContent.files[csvFile].async("text");
          loadPhase = "parsing";
          await tick();
          await parseData(csvText);
          loadPhase = "idle";
        } catch (err) {
          loadError = err?.message || String(err);
          console.error("Failed to load ZIP file:", err);
        } finally {
          isLoading = false;
        }
      } else {
        try {
          loadError = "";
          isLoading = true;
          loadPhase = "parsing";
          await tick();
          // Hand the File straight to Papa — it streams it in chunks via
          // FileReader, so there's no full read-to-string and no UI freeze.
          await parseData(file);
          loadPhase = "idle";
        } catch (err) {
          loadError = err?.message || String(err);
          console.error("Failed to load CSV file:", err);
        } finally {
          isLoading = false;
        }
      }
    }
  }

  function shiftDateRange(days) {
    const rangeDuration = endDateIndex - startDateIndex;
    let newStartIndex = startDateIndex + days;
    let newEndIndex = endDateIndex + days;

    // Handle boundary conditions
    if (newStartIndex < 0) {
      newStartIndex = 0;
      newEndIndex = Math.min(rangeDuration, allDates.length - 1);
    }

    if (newEndIndex >= allDates.length) {
      newEndIndex = allDates.length - 1;
      newStartIndex = Math.max(0, newEndIndex - rangeDuration);
    }

    startDateIndex = newStartIndex;
    endDateIndex = newEndIndex;
    updateSelectedDates(startDateIndex, endDateIndex, true);
  }

  function togglePlayPause() {
    if (isPlaying) {
      clearInterval(playInterval);
      isPlaying = false;
    } else {
      isPlaying = true;
      showAnnotations = false;
      playInterval = setInterval(() => {
        if (endDateIndex >= allDates.length - 1) {
          clearInterval(playInterval);
          isPlaying = false;
          return;
        }
        shiftDateRange(1);
      }, 500);
    }
  }

  function handleSearch(event) {
    searchQuery = event.target.value;
    showAnnotations = false;
  }

  function handleOpacityChange() {
    showAnnotations = false;
  }

  function resetFilters() {
    // Stop playback if running
    if (isPlaying && playInterval) {
      clearInterval(playInterval);
      isPlaying = false;
    }

    // Reset to no color-by column
    domainColumn = "";

    // Clear selection and highlights
    selectedValues = new Set();
    highlightedData = [];
    selectedPointIds = new Set();

    // Reset search and annotations
    searchQuery = "";
    highlightSearchQuery = "";
    hideNoAbstract = false;
    showAnnotations = false;

    // Reset opacity to initial default
    opacity = 0.05;

    // Force Svelte to update opacity binding
    opacity = +opacity;

    // Reset date range to full
    if (allDates.length) {
      startDateIndex = 0;
      endDateIndex = allDates.length - 1;
      updateSelectedDates(startDateIndex, endDateIndex, true);
    } else {
      startDate = null;
      endDate = null;
      startDateIndex = 0;
      endDateIndex = 0;
    }
  }
</script>

<!-- App Layout -->
<div class="container">
  <div class="title-section">
    <div class="title-section-left">
      <h1 class="title">PubMed articles: E-Cigarette</h1>
    </div>
    <div class="headline-bar">
      <label for="file-upload" class="file-upload-btn" aria-label="Upload CSV or ZIP">Upload CSV</label>
      <input
        id="file-upload"
        type="file"
        accept=".csv,.zip"
        on:change={handleFileUpload}
        class="file-upload-input"
      />
    </div>
  </div>

  <div class="content">
    <!-- Filters Panel -->
    <aside class="filter-panel left-panel" aria-label="Filters">
      <header class="filter-panel-header">
        <span class="active-metric" title="Shown (passing filters) / total rows in dataset">{activePmids} / {totalPmids} PMIDs</span>
        <button type="button" class="reset-btn" on:click={resetFilters}>Reset all</button>
      </header>

      <section class="filter-section">
        <label for="search-input" class="filter-label">Search articles</label>
        <div class="search-input-wrap">
          <input
            id="search-input"
            type="text"
            class="filter-input filter-input-search"
            placeholder="Title, abstract, COI, affiliation, funding…"
            on:input={handleSearch}
          />
        </div>
        <label class="filter-checkbox filter-checkbox-abstract">
          <input type="checkbox" bind:checked={hideNoAbstract} class="filter-checkbox-input" />
          <span class="filter-checkbox-text">Only articles with an abstract</span>
        </label>
      </section>

      {#if allowedDomainColumns.length}
        <section class="filter-section">
          <label for="domain-column" class="filter-label">Highlight by column</label>
          <select
            id="domain-column"
            class="filter-input filter-select"
            on:change={handleDomainChange}
            bind:value={domainColumn}
          >
            <option value="">Choose column</option>
            {#each allowedDomainColumns as column}
              <option value={column}>{columnLabel(column)}</option>
            {/each}
          </select>
        </section>
      {/if}

      {#if uniqueValues.length}
        <section class="filter-section filter-section-collapsible">
          <details class="filter-details" open>
            <summary class="filter-summary">Highlight by value</summary>
            <div class="filter-details-inner">
              <div class="filter-match-mode" role="group" aria-label="Match logic">
                <label class="filter-radio">
                  <input type="radio" name="highlightMatch" value="or" bind:group={highlightMatchMode} />
                  <span>Any (OR)</span>
                </label>
                <label class="filter-radio">
                  <input type="radio" name="highlightMatch" value="and" bind:group={highlightMatchMode} />
                  <span>All (AND)</span>
                </label>
              </div>
              <input
                type="text"
                class="filter-input filter-input-search"
                placeholder="Filter values..."
                bind:value={highlightSearchQuery}
              />
              <select
                id="value-select"
                multiple
                size="4"
                class="filter-select filter-multi-select"
                on:change={handleSelectionChange}
              >
                {#each filteredUniqueValues as item}
                  <option value={item} selected={selectedValues.has(item)}>{item}</option>
                {/each}
              </select>
            </div>
          </details>
        </section>
      {/if}

      <section class="filter-section">
        <span class="filter-label">Date range</span>
        <div class="filter-date-wrap">
          <RangeSlider
            min={0}
            max={maxAllowedIndex}
            bind:startValue={startDateIndex}
            bind:endValue={endDateIndex}
            on:startChange={(e) => handleDateChange(e, "start")}
            on:endChange={(e) => handleDateChange(e, "end")}
          />
          <div class="filter-date-labels">
            <span>{formatDateInput(startDate)}</span>
            <span>{formatDateInput(endDate)}</span>
          </div>
        </div>
      </section>

      <section class="filter-section filter-section-impact-toggles">
        <span class="filter-label">Citation highlight</span>
        <label class="filter-checkbox">
          <input type="checkbox" bind:checked={highlightCitingForActiveSet} class="filter-checkbox-input" />
          <span class="filter-checkbox-text">Active Set</span>
          {#if highlightCitingForActiveSet && impactHighlightIds.size > 0}
            <span class="filter-pill">{impactHighlightIds.size}</span>
          {/if}
        </label>
        <label class="filter-checkbox">
          <input type="checkbox" bind:checked={impactHighlightOn} class="filter-checkbox-input" />
          <span class="filter-checkbox-text">On hover</span>
          {#if impactHighlightOn && !highlightCitingForActiveSet && (selectedData || hoveredData) && impactHighlightIds.size > 0}
            <span class="filter-pill">{impactHighlightIds.size}</span>
          {/if}
        </label>
      </section>

      <section class="filter-section filter-section-selection">
        <span class="filter-label">Selection {#if selectedPointIds.size > 0}<span class="filter-pill">{selectedPointIds.size}</span>{/if}</span>
        <p class="filter-hint">Shift+drag or Shift+click on the map.</p>
        {#if selectedPointIds.size > 0}
          <div class="filter-btn-group">
            <button type="button" class="filter-btn filter-btn-primary" on:click={exportPmids}>Export PMIDs</button>
            <button type="button" class="filter-btn filter-btn-ghost" on:click={clearPointSelection}>Clear</button>
          </div>
        {/if}
      </section>

    </aside>

    <div class="scatterplot-container">
      {#if displayData.length}
        <Scatterplot
          data={displayData}
          {domainColumn}
          {selectedValues}
          bind:opacity
          anyFilterActive={anyFilterActive}
          {searchQuery}
          {showAnnotations}
          {highlightedData}
          {startDate}
          {endDate}
          impactHighlightIds={impactHighlightIds}
          bind:hoveredData
          bind:selectedData
          bind:selectedPointIds
          on:opacityChange={handleOpacityChange}
        />
      {:else if isLoading}
        <div class="progress-wrap">
          <div class="progress-header">
            {#if loadPhase === "downloading"}
              Downloading {resolvedDataUrl.toLowerCase().endsWith('.zip') ? 'ZIP' : 'CSV'}...
            {:else if loadPhase === "unzipping"}
              Unzipping...
            {:else if loadPhase === "parsing"}
              Parsing CSV{parsedRows ? ` — ${parsedRows.toLocaleString()} rows` : ""}...
            {:else}
              Loading...
            {/if}
          </div>
          {#if loadPhase === "downloading"}
            {#if loadTotal}
              <div class="progress-bar">
                <div class="progress-fill" style="width: {loadProgress}%"></div>
              </div>
              <div class="progress-label">
                {loadProgress}% ({formatBytes(loadBytes)} / {formatBytes(
                  loadTotal,
                )})
              </div>
            {:else}
              <div class="progress-bar indeterminate"></div>
              <div class="progress-label">{formatBytes(loadBytes)}</div>
            {/if}
          {:else}
            <div class="progress-bar indeterminate"></div>
          {/if}
        </div>
      {:else if loadError}
        <div class="error-message" role="alert">
          <strong>Unable to load data:</strong>
          <div>{loadError}</div>
        </div>
      {:else if loadError}
        <div class="error-message" role="alert">
          <strong>Unable to load data:</strong>
          <div>{loadError}</div>
        </div>
      {:else}
        <p>Waiting for data</p>
      {/if}
    </div>

    <!-- Right Panel for Speech Details -->
    <div class="detail-panel">
      <DetailCard
        hoveredData={displayedData}
        {data}
        {domainColumn}
        {colorScale}
        {searchQuery}
        isPinned={!!selectedData}
        on:unpin={() => selectedData = null}
      />
    </div>
  </div>
</div>

<style>
  /* Make the overall page non-scrollable */
  :global(html, body, #app) {
    height: 100%;
    overflow: hidden;
  }

  .container {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    font-family: var(--font-body);
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
  }

  .title-section {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    text-align: left;
    border-bottom: 4px solid var(--cjr-accent);
    padding-bottom: 0.75rem;
  }

  .title-section-left {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-family: var(--font-heading);
    font-size: calc(1.5rem + 0.6vw);
    font-weight: 500;
    color: var(--cjr-text);
    margin: 0;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }

  .headline-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-top: 0;
    padding-top: 0;
    margin-left: auto;
    flex-shrink: 0;
  }

  .file-upload-input {
    position: absolute;
    width: 0.1px;
    height: 0.1px;
    opacity: 0;
    overflow: hidden;
    z-index: -1;
  }

  .file-upload-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.4rem 0.85rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: #fff;
    background: var(--cjr-accent);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s ease, transform 0.05s ease;
  }

  .file-upload-btn:hover {
    background: var(--cjr-accent-hover, #c94a26);
  }

  .file-upload-btn:active {
    transform: scale(0.98);
  }

  .error-message {
    padding: 1rem;
    border: 1px solid var(--cjr-danger, #d23f3f);
    background: rgba(210, 63, 63, 0.08);
    color: var(--cjr-danger, #921f1f);
    border-radius: 0.75rem;
    max-width: 40rem;
    margin: 0.5rem 0;
  }

  .error-message strong {
    display: block;
    margin-bottom: 0.25rem;
  }

  .content {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .filter-panel {
    --filter-accent: var(--cjr-blue);
    --filter-bg: #f8f9fa;
    --filter-border: #e8eaed;
    --filter-radius: 8px;
    --filter-focus: 0 0 0 2px rgba(37, 76, 111, 0.2);
    background: var(--filter-bg);
    padding: 1rem 1.1rem;
    width: 280px;
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    font-size: 0.875rem;
  }

  .filter-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--filter-border);
  }

  .active-metric {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--cjr-text);
    letter-spacing: 0.02em;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .reset-btn {
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    font-family: var(--font-body);
    background: transparent;
    border: 1px solid var(--filter-border);
    color: var(--cjr-text-muted);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .reset-btn:hover {
    border-color: var(--filter-accent);
    color: var(--filter-accent);
    background: rgba(37, 76, 111, 0.06);
  }

  .filter-section {
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--filter-border);
  }
  .filter-section:last-child {
    border-bottom: none;
  }

  .filter-label {
    display: block;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--cjr-text-muted);
    margin-bottom: 0.4rem;
  }

  .filter-input,
  .filter-select {
    width: 100%;
    padding: 0.45rem 0.6rem;
    font-size: 0.8125rem;
    font-family: var(--font-body);
    border: 1px solid var(--filter-border);
    border-radius: 6px;
    background: var(--cjr-white);
    color: var(--cjr-text);
    box-sizing: border-box;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .filter-input::placeholder {
    color: var(--cjr-text-muted);
    opacity: 0.8;
  }
  .filter-input:focus,
  .filter-select:focus {
    outline: none;
    border-color: var(--filter-accent);
    box-shadow: var(--filter-focus);
  }

  .filter-input-search {
    padding-left: 0.65rem;
  }

  .filter-multi-select {
    min-height: 88px;
    padding: 0.35rem;
    font-size: 0.8rem;
    border-radius: 6px;
  }

  .filter-details {
    margin: 0;
  }
  .filter-summary {
    list-style: none;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--filter-accent);
    padding: 0.2rem 0;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .filter-summary::-webkit-details-marker {
    display: none;
  }
  .filter-summary:hover {
    color: var(--cjr-blue-dark);
  }
  .filter-details-inner {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }
  .filter-match-mode {
    display: flex;
    gap: 1rem;
    align-items: center;
  }
  .filter-radio {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--cjr-text);
    cursor: pointer;
  }
  .filter-radio input {
    margin: 0;
    accent-color: var(--filter-accent);
    cursor: pointer;
  }

  .filter-date-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .filter-date-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.7rem;
    color: var(--cjr-text-muted);
    letter-spacing: 0.02em;
  }

  .filter-btn {
    font-family: var(--font-body);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    border: none;
    transition: background 0.15s, color 0.15s, transform 0.05s;
  }
  .filter-btn:active {
    transform: scale(0.98);
  }
  .filter-btn-primary {
    background: var(--filter-accent);
    color: var(--cjr-white);
  }
  .filter-btn-primary:hover {
    background: var(--cjr-blue-dark);
  }
  .filter-btn-ghost {
    background: transparent;
    color: var(--cjr-text-muted);
    border: 1px solid var(--filter-border);
  }
  .filter-btn-ghost:hover {
    border-color: var(--cjr-text-muted);
    color: var(--cjr-text);
  }
  .filter-btn-group {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }

  .filter-pill {
    font-size: 0.7rem;
    font-weight: 600;
    background: var(--filter-accent);
    color: var(--cjr-white);
    padding: 0.12rem 0.4rem;
    border-radius: 999px;
    margin-left: 0.25rem;
  }

  .filter-section-impact-toggles .filter-label {
    margin-bottom: 0.35rem;
  }
  .filter-section-impact-toggles .filter-checkbox + .filter-checkbox {
    margin-top: 0.6rem;
    margin-left: 1rem;
  }
  .filter-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--cjr-text);
    cursor: pointer;
    margin-bottom: 0.25rem;
  }
  .filter-checkbox-input {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: var(--filter-accent);
    cursor: pointer;
  }
  .filter-checkbox-text {
    flex: 1;
  }
  .filter-hint {
    font-size: 0.72rem;
    color: var(--cjr-text-muted);
    line-height: 1.35;
    margin: 0.25rem 0 0 0;
  }

  .detail-panel {
    background: var(--cjr-white);
    padding: 1.5rem;
    width: 450px;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  .scatterplot-container {
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--cjr-white);
    border-radius: 4px;
    height: 100%;
    min-height: 0;
    padding: 1rem;
    box-sizing: border-box;
    border: 1px solid var(--cjr-border);
  }

  /* Progress styles */
  .progress-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }
  .progress-header {
    font-size: 0.9rem;
    color: var(--cjr-text);
    font-weight: 600;
  }
  .progress-bar {
    position: relative;
    height: 8px;
    background: var(--cjr-border);
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--cjr-blue);
    width: 0%;
    transition: width 120ms linear;
  }
  .progress-bar.indeterminate::before {
    content: "";
    position: absolute;
    left: -40%;
    width: 40%;
    height: 100%;
    background: var(--cjr-blue);
    animation: indet 1s infinite linear;
    will-change: left;
    transform: translateZ(0);
  }

  @keyframes indet {
    0% {
      left: -40%;
    }
    50% {
      left: 60%;
    }
    100% {
      left: 100%;
    }
  }
  .progress-label {
    font-size: 0.8rem;
    color: var(--cjr-text-muted);
    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
    min-width: 180px;
    text-align: left;
  }

  /* Laptops / small desktops: tighten the 3-column dashboard but keep it
     pinned to one screen. */
  @media (min-width: 1025px) and (max-width: 1440px) {
    .content {
      display: grid;
      grid-template-columns: 230px 1fr 360px;
      grid-template-rows: 1fr;
      gap: 1rem;
    }

    .filter-panel {
      grid-column: 1;
      grid-row: 1;
      width: 230px;
    }

    .scatterplot-container {
      grid-column: 2;
      grid-row: 1;
      min-height: 300px;
    }

    .detail-panel {
      grid-column: 3;
      grid-row: 1;
      width: 360px;
      height: 100%;
      max-height: none;
      min-height: 0;
    }
  }

  /* Tablets & phones: stop pinning to a single viewport. Let the page scroll
     and stack the panels, with the plot taking a usable slice of the screen.
     (The scatterplot uses a ResizeObserver, so it re-fits automatically.) */
  @media (max-width: 1024px) {
    :global(html, body, #app) {
      height: auto;
      overflow: auto;
    }

    .container {
      height: auto;
      min-height: 100%;
      overflow: visible;
    }

    .content {
      display: flex;
      flex-direction: column;
      overflow: visible;
      gap: 1rem;
    }

    .filter-panel {
      width: 100%;
      height: auto;
      max-height: none;
      overflow: visible;
    }

    .scatterplot-container {
      width: 100%;
      height: 65vh;
      min-height: 360px;
    }

    .detail-panel {
      width: 100%;
      height: auto;
      max-height: none;
      overflow: visible;
    }
  }

  /* Phones: smaller plot slice + tighter chrome. */
  @media (max-width: 768px) {
    .container {
      padding: 0.75rem;
    }

    .scatterplot-container {
      height: 58vh;
      min-height: 300px;
      padding: 0.5rem;
    }

    .title {
      font-size: 1.4rem;
    }
  }

  .search-input-wrap {
    position: relative;
  }
  .search-input-wrap .filter-input-search {
    width: 100%;
    box-sizing: border-box;
  }
  .filter-checkbox-abstract {
    margin-top: 0.5rem;
  }
</style>
