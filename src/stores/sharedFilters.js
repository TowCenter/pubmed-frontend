import { writable } from "svelte/store";

// Selection state shared across the Semantic map and COI network views.
// Selecting an author / organization / PMID in either view highlights the same
// articles on the map and focuses the same nodes in the network. Values are the
// exact name/PMID strings used by both data sources (the CSV's author/coi_org
// fields and the graph's Author/Org/Paper node names match exactly).
export const selAuthors = writable([]);
export const selOrgs = writable([]);
export const selPmids = writable([]);

/** Clear every shared selection (used by both views' "clear/reset" actions). */
export function clearSharedFilters() {
  selAuthors.set([]);
  selOrgs.set([]);
  selPmids.set([]);
}
