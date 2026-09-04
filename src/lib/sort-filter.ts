/**
 * SORT & FILTER, ONE PRIMITIVE (Andrew: "Sorting ABCD or otherwise" — filed on the customer list,
 * true of the price list too: order was whatever the database returned). Pure helpers here; the
 * control that drives them is src/components/sort-filter-bar.tsx. Same brain on every list.
 */

export type SortDir = "asc" | "desc";
export type SortSpec = { key: string; dir: SortDir };

export type SortOption = { key: string; label: string; kind?: "text" | "number" | "date" };
export type FilterChip<T> = { key: string; label: string; test: (row: T) => boolean };

/** Stable sort by one key. Numbers and dates compare numerically; text compares naturally
 *  (case-insensitive, "10" after "9"); nulls always sink to the bottom regardless of direction. */
export function sortRows<T extends Record<string, unknown>>(rows: T[], spec: SortSpec | null, options: SortOption[]): T[] {
  if (!spec) return rows;
  const opt = options.find((o) => o.key === spec.key);
  if (!opt) return rows;
  const kind = opt.kind ?? "text";
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const value = (r: T): unknown => r[spec.key];
  const isNull = (v: unknown) => v === null || v === undefined || v === "";
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const va = value(a.r);
      const vb = value(b.r);
      if (isNull(va) && isNull(vb)) return a.i - b.i;
      if (isNull(va)) return 1;
      if (isNull(vb)) return -1;
      let c = 0;
      if (kind === "number") c = Number(va) - Number(vb);
      else if (kind === "date") c = new Date(String(va)).getTime() - new Date(String(vb)).getTime();
      else c = collator.compare(String(va), String(vb));
      if (c === 0) return a.i - b.i;
      return spec.dir === "asc" ? c : -c;
    })
    .map(({ r }) => r);
}

/** Group rows by a key; rows with no value land under `emptyLabel`. Group order follows first
 *  appearance in the (already sorted) input, so sorting inside groups is free. */
export function groupRows<T extends Record<string, unknown>>(rows: T[], key: string | null, emptyLabel = "—"): { label: string; rows: T[] }[] {
  if (!key) return [{ label: "", rows }];
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const v = r[key];
    const label = v === null || v === undefined || String(v).trim() === "" ? emptyLabel : String(v);
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(r);
  }
  return [...map.entries()].map(([label, rows]) => ({ label, rows }));
}

/** Apply every ACTIVE chip (AND). */
export function applyFilters<T>(rows: T[], chips: FilterChip<T>[], active: Set<string>): T[] {
  const on = chips.filter((c) => active.has(c.key));
  if (!on.length) return rows;
  return rows.filter((r) => on.every((c) => c.test(r)));
}

/** Case-insensitive contains across the named text fields. */
export function searchRows<T extends Record<string, unknown>>(rows: T[], q: string, fields: string[]): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => fields.some((f) => String(r[f] ?? "").toLowerCase().includes(needle)));
}

export type SortFilterPrefs = { sort: SortSpec | null; group: string | null; chips: string[] };

/** Per-person, per-list memory of the last sort/group/chips. localStorage can be absent or
 *  throwing (private mode, previews) — every read and write is guarded and the default wins. */
export function loadPrefs(storageKey: string, fallback: SortFilterPrefs): SortFilterPrefs {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(`cn.sortfilter.${storageKey}`) : null;
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<SortFilterPrefs>;
    return {
      sort: p.sort && typeof p.sort.key === "string" && (p.sort.dir === "asc" || p.sort.dir === "desc") ? p.sort : fallback.sort,
      group: typeof p.group === "string" || p.group === null ? (p.group ?? null) : fallback.group,
      chips: Array.isArray(p.chips) ? p.chips.filter((c) => typeof c === "string") : fallback.chips,
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(storageKey: string, prefs: SortFilterPrefs): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(`cn.sortfilter.${storageKey}`, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — the choice just isn't remembered */
  }
}
