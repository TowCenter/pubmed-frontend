/**
 * Parse a cell value into an array of individual items.
 * Handles: JSON array "[\"a\",\"b\"]", Python-style "['a','b']", comma/semicolon-separated, or single value.
 */
export function parseColumnValueToItems(raw) {
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
    return s
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [s];
}

/** Normalize a cell value to an array of values for highlight matching (uses parseColumnValueToItems). */
export function rowValuesForColumn(raw) {
  return parseColumnValueToItems(raw);
}

export function parseCitedByPmids(val) {
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
    return s
      .split(/[,\s;]+/)
      .map((p) => p.replace(/^["'\s]+|["'\s]+$/g, ""))
      .filter(Boolean);
  }
}
