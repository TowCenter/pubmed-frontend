<script>
  // Lightweight type-ahead multi-select. `items` is the full list of options;
  // `selected` (bindable) is the chosen subset. Emits via two-way binding.
  import { createEventDispatcher } from "svelte";

  export let items = [];
  export let selected = [];
  export let placeholder = "Search…";
  export let label = "";
  export let color = "var(--cjr-blue)";
  export let allowFreeText = false; // add typed value even if not in items (for PMIDs)
  export let meta = null; // optional Map item -> secondary label (e.g. paper count)

  const dispatch = createEventDispatcher();
  let text = "";
  let open = false;
  let activeIndex = 0;

  $: q = text.trim().toLowerCase();
  // With a query, substring-filter; on focus with no query, show the leading
  // items (callers can pre-sort, e.g. authors by paper count) so the picker
  // doubles as a ranked browse list.
  $: matches = (q
    ? items.filter((i) => i.toLowerCase().includes(q) && !selected.includes(i))
    : items.filter((i) => !selected.includes(i))
  ).slice(0, 20);

  function add(item) {
    if (!item || selected.includes(item)) return;
    selected = [...selected, item];
    text = "";
    open = false;
    activeIndex = 0;
    dispatch("change", selected);
  }
  function remove(item) {
    selected = selected.filter((s) => s !== item);
    dispatch("change", selected);
  }
  function onKey(e) {
    if (e.key === "ArrowDown") { activeIndex = Math.min(activeIndex + 1, matches.length - 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { activeIndex = Math.max(activeIndex - 1, 0); e.preventDefault(); }
    else if (e.key === "Enter") {
      if (matches[activeIndex]) add(matches[activeIndex]);
      else if (allowFreeText && text.trim()) add(text.trim());
    } else if (e.key === "Backspace" && !text && selected.length) {
      remove(selected[selected.length - 1]);
    }
  }
</script>

<div class="ms" style="--accent:{color}">
  {#if label}<span class="lbl">{label}</span>{/if}
  <div class="box">
    {#each selected as item}
      <span class="chip">{item}<button on:click={() => remove(item)} aria-label="remove">×</button></span>
    {/each}
    <input
      bind:value={text}
      {placeholder}
      on:focus={() => (open = true)}
      on:input={() => { open = true; activeIndex = 0; }}
      on:blur={() => setTimeout(() => (open = false), 120)}
      on:keydown={onKey}
    />
  </div>
  {#if open && matches.length}
    <ul class="menu">
      {#each matches as m, i}
        <li class:active={i === activeIndex}
            on:mousedown|preventDefault={() => add(m)}
            on:mouseenter={() => (activeIndex = i)}>
          <span class="opt-name">{m}</span>
          {#if meta && meta.get(m) != null}<span class="opt-meta">{meta.get(m)}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ms { position: relative; display: flex; flex-direction: column; gap: 3px; min-width: 200px; }
  .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--cjr-text-muted); font-weight: 600; }
  .box {
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    border: 1px solid var(--cjr-border); border-radius: 6px; padding: 4px 6px;
    background: var(--cjr-white); min-height: 34px;
  }
  .box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--cjr-blue-focus); }
  input { border: none; outline: none; flex: 1; min-width: 90px; font-size: 13px; font-family: var(--font-body); }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; font-size: 12px;
    background: var(--accent); color: #fff; border-radius: 4px; padding: 2px 4px 2px 7px;
  }
  .chip button { border: none; background: none; color: #fff; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; opacity: 0.8; }
  .chip button:hover { opacity: 1; }
  .menu {
    position: absolute; top: 100%; left: 0; right: 0; z-index: 20; margin-top: 2px;
    background: #fff; border: 1px solid var(--cjr-border); border-radius: 6px;
    max-height: 240px; overflow: auto; box-shadow: 0 6px 18px rgba(0,0,0,0.12);
  }
  .menu li {
    padding: 6px 10px; font-size: 13px; cursor: pointer;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .menu li.active { background: var(--cjr-blue-focus); }
  .opt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt-meta {
    flex-shrink: 0; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
    color: var(--cjr-text-muted);
  }
</style>
