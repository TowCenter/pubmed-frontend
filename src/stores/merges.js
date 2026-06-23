import { writable, derived } from "svelte/store";

// Node merges (variant org/author names combined into one canonical node) are
// created in the COI network view but shared with the Semantic map, so a
// combined node resolves the same way in both: the map's author/org matching
// and pickers collapse every variant into the canonical name.
//
// Each group: { id, name, label:'Org'|'Author', members:[rawNodeId,...],
//               memberNames:[name,...] }
// memberNames lets the map resolve variants → canonical WITHOUT loading the
// graph. Legacy groups saved before memberNames existed are backfilled by the
// network view once the graph loads.
const KEY = "coi-merges-v1";

function load() {
  try {
    const s = typeof localStorage !== "undefined" && localStorage.getItem(KEY);
    if (s) return JSON.parse(s) || [];
  } catch {
    /* unreadable / blocked storage */
  }
  return [];
}

export const mergeGroups = writable(load());

if (typeof localStorage !== "undefined") {
  mergeGroups.subscribe((groups) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(groups));
    } catch {
      /* quota / blocked */
    }
  });
}

/** Build a variant-name → canonical-name map for one node label. */
function buildNameMap(groups, label) {
  const m = new Map();
  for (const g of groups) {
    if (g.label !== label || !g.memberNames) continue;
    for (const n of g.memberNames) m.set(n, g.name);
  }
  return m;
}

export const authorCanonical = derived(mergeGroups, ($g) => buildNameMap($g, "Author"));
export const orgCanonical = derived(mergeGroups, ($g) => buildNameMap($g, "Org"));
