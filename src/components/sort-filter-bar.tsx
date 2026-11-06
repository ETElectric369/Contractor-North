"use client";

import { useEffect, useState } from "react";
import { ArrowDownAZ, ArrowUpAZ, Layers } from "lucide-react";
import { Select } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { loadPrefs, savePrefs, type SortFilterPrefs, type SortOption, type SortSpec } from "@/lib/sort-filter";

/**
 * THE SORT & FILTER BAR — one control for every list (Andrew's "Sorting ABCD" on Contacts; the
 * price list; then leads and jobs). Sort by any offered column, flip direction, optionally group,
 * toggle filter chips. Remembers the last choice per person per list (localStorage, guarded).
 *
 * It renders the controls and hands the parent a prefs object; the parent runs the pure helpers
 * in lib/sort-filter.ts over its rows. Keeping the arithmetic out of the component means a server
 * page can apply the same prefs to a query (Contacts) while a client table applies them in memory.
 */
export function useSortFilter(storageKey: string, fallback: SortFilterPrefs) {
  const [prefs, setPrefs] = useState<SortFilterPrefs>(fallback);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setPrefs(loadPrefs(storageKey, fallback));
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const update = (patch: Partial<SortFilterPrefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(storageKey, next);
      return next;
    });
  return { prefs, update, loaded };
}

export function SortFilterBar({
  sortOptions,
  groupOptions = [],
  chips = [],
  prefs,
  onChange,
  className,
}: {
  sortOptions: SortOption[];
  groupOptions?: { key: string; label: string }[];
  chips?: { key: string; label: string; count?: number }[];
  prefs: SortFilterPrefs;
  onChange: (patch: Partial<SortFilterPrefs>) => void;
  className?: string;
}) {
  // Shared (Contacts, the price list): the bar's own words in the reader's language; the options' labels are the caller's.
  const t = translator(useLang());
  const sort: SortSpec | null = prefs.sort;
  const dir = sort?.dir ?? "asc";
  const active = new Set(prefs.chips);
  const toggleChip = (key: string) => {
    const next = new Set(active);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ chips: [...next] });
  };
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        {t("cu_sort")}
        <Select
          aria-label={t("cu_sortBy")}
          className="h-9 w-auto text-sm"
          value={sort?.key ?? ""}
          onChange={(e) => onChange({ sort: e.target.value ? { key: e.target.value, dir } : null })}
        >
          <option value="">{t("cu_btn_sortDefault")}</option>
          {sortOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>
      <button
        type="button"
        aria-label={dir === "asc" ? t("cu_ascending") : t("cu_descending")}
        title={dir === "asc" ? t("cu_ascTitle") : t("cu_descTitle")}
        disabled={!sort}
        onClick={() => sort && onChange({ sort: { ...sort, dir: dir === "asc" ? "desc" : "asc" } })}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
      >
        {dir === "asc" ? <ArrowDownAZ className="h-4 w-4" /> : <ArrowUpAZ className="h-4 w-4" />}
      </button>
      {groupOptions.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <Layers className="h-3.5 w-3.5" /> {t("cu_group")}
          <Select aria-label={t("cu_groupBy")} className="h-9 w-auto text-sm" value={prefs.group ?? ""} onChange={(e) => onChange({ group: e.target.value || null })}>
            <option value="">{t("cu_btn_groupNone")}</option>
            {groupOptions.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </Select>
        </label>
      )}
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-pressed={active.has(c.key)}
          onClick={() => toggleChip(c.key)}
          className={`inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs font-medium ${
            active.has(c.key) ? "border-brand bg-brand-light text-brand" : "border-slate-200 text-slate-600 hover:bg-slate-50"
          }`}
        >
          {c.label}
          {typeof c.count === "number" && <span className="text-slate-400">{c.count}</span>}
        </button>
      ))}
    </div>
  );
}
