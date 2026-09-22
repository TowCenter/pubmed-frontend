import { writable } from "svelte/store";

export { slugify, collectionForSlug } from "../lib/collectionSlug.js";

// Which collection (e.g. "E-Cigs", "Creatine") the whole app is scoped to.
// "All" is the sentinel for "nothing chosen yet" — the app requires a real
// selection before showing any data (see App.svelte's gate), it's never a
// legitimate "show everything" end-state.
export const ALL_COLLECTIONS = "All";
export const selectedCollection = writable(ALL_COLLECTIONS);

// Populated by App.svelte on mount from the lightweight /api/collections
// (dev) or collections.json (prod) endpoint — kept separate from the heavy
// per-collection CSV/graph fetches so the picker can show options before any
// of that data loads.
export const availableCollections = writable([]);
