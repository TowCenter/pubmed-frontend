import { writable } from "svelte/store";

// Selection state shared across the Semantic map and COI network views.
// Selecting an author / organization / PMID in either view highlights the same
// articles on the map and focuses the same nodes in the network. Values are the
// exact name/PMID strings used by both data sources (the CSV's author/coi_org
// fields and the graph's Author/Org/Paper node names match exactly).
export const selAuthors = writable([]);
export const selOrgs = writable([]);
export const selPmids = writable([]);

// PMIDs currently passing the map's date range / "Highlight by value" /
// search filters (collection + search-in-filter-mode are already reflected
// in this set too, since they narrow the map's data before these run). The
// COI network filters its nodes down to just these papers, so it reacts to
// the same filtering the map's dots do. Deliberately excludes the linked
// Author/Org/PMID selection above (selAuthors/selOrgs/selPmids) — that's
// already shared and drives the graph's own focus/expand-depth view instead
// of a hard filter, so folding it in here would double-apply it and break
// that feature. null = not computed yet (e.g. before the CSV loads) = no
// restriction.
export const mapActivePmids = writable(null);

/** Clear every shared selection (used by both views' "clear/reset" actions). */
export function clearSharedFilters() {
  selAuthors.set([]);
  selOrgs.set([]);
  selPmids.set([]);
}
