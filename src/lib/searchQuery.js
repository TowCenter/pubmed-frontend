// --- boolean keyword search --------------------------------------------
// "vaping AND nicotine", "vaping OR e-cigarette", "vaping AND (nicotine OR
// ENDS)", "\"lung injury\"" (quotes for an exact phrase). Bare words with no
// operator between them are implicitly AND'd; AND binds tighter than OR,
// same convention as PubMed/Google. Parsed once per keystroke, evaluated
// per row against just the checked search fields.

export function tokenizeSearchQuery(q) {
  const tokens = [];
  const re = /"([^"]*)"|([()])|(\bAND\b|\bOR\b)|([^\s()]+)/gi;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[1] !== undefined) tokens.push({ type: "term", value: m[1] });
    else if (m[2]) tokens.push({ type: m[2] === "(" ? "lparen" : "rparen" });
    else if (m[3]) tokens.push({ type: m[3].toUpperCase() === "AND" ? "and" : "or" });
    else if (m[4]) tokens.push({ type: "term", value: m[4] });
  }
  return tokens;
}

export function parseSearchQuery(q) {
  const tokens = tokenizeSearchQuery(q);
  if (!tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseUnary() {
    const t = peek();
    if (!t) return null;
    if (t.type === "lparen") {
      next();
      const node = parseOr();
      if (peek() && peek().type === "rparen") next();
      return node;
    }
    if (t.type === "term") {
      next();
      return { type: "term", value: t.value.trim().toLowerCase() };
    }
    next(); // stray "AND" / "OR" / ")" with nothing to bind to — drop it
    return null;
  }
  function parseAnd() {
    let node = parseUnary();
    while (node) {
      const t = peek();
      if (!t || t.type === "or" || t.type === "rparen") break;
      if (t.type === "and") next(); // explicit AND; otherwise implicit (bare next term)
      const t2 = peek();
      if (!t2 || t2.type === "or" || t2.type === "rparen") break;
      const right = parseUnary();
      if (!right) break;
      node = { type: "and", left: node, right };
    }
    return node;
  }
  function parseOr() {
    let node = parseAnd();
    while (node && peek() && peek().type === "or") {
      next();
      const right = parseAnd();
      if (!right) break;
      node = { type: "or", left: node, right };
    }
    return node;
  }

  return parseOr();
}

export function evalSearchQuery(node, haystackLower) {
  if (!node) return true;
  if (node.type === "term") return !node.value || haystackLower.includes(node.value);
  if (node.type === "and")
    return evalSearchQuery(node.left, haystackLower) && evalSearchQuery(node.right, haystackLower);
  if (node.type === "or")
    return evalSearchQuery(node.left, haystackLower) || evalSearchQuery(node.right, haystackLower);
  return true;
}

/** Build the lowercased searchable text for a row from just the checked fields. */
export function searchHaystack(d, fields, fieldDefs) {
  return fieldDefs
    .filter((f) => fields.has(f.key))
    .map((f) => f.get(d))
    .filter((v) => v != null)
    .join("\n")
    .toLowerCase();
}
