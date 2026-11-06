import type { SortDir, SortOption, SortSpec } from "@/lib/sort-filter";
import type { Lang } from "@/lib/locale";
import { say, type Words } from "@/lib/lang-words";

/**
 * CONTACTS ORDER (Andrew: "Sorting ABCD or otherwise", filed on /crm). The customer list had no
 * sort control — created_at desc, take it or leave it. This is the server-side half of the shared
 * sort primitive (lib/sort-filter.ts): the page reads ?sort= from the URL, parses it here, and
 * hands the result straight to the Supabase .order call. Pure, so it is testable and so the
 * client control (crm/sort-control.tsx) and the server page agree on one vocabulary.
 *
 * A→Z by name is the DEFAULT. That is what a contact list is for; "newest first" was only ever
 * the database's habit.
 */

export const CRM_SORT_KEYS = ["name", "company", "recent"] as const;
export type CrmSortKey = (typeof CRM_SORT_KEYS)[number];

export const CRM_DEFAULT_SORT: SortSpec = { key: "name", dir: "asc" };

/** What the bar offers. `kind` is informational here — the ordering happens in Postgres. */
export const CRM_SORT_OPTIONS: SortOption[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "recent", label: "Recently Added", kind: "date" },
];

/** The catalog key each sort choice reads in another language (lib/words/customers, cu_lib_sort…). */
const CRM_SORT_LABEL_KEY: Record<CrmSortKey, string> = {
  name: "cu_lib_sortName",
  company: "cu_lib_sortCompany",
  recent: "cu_lib_sortRecent",
};

/** A sort choice's words for the person reading (the Ventas-2 wave, cn-v1146): CRM_SORT_OPTIONS' English
 *  by default, byte for byte; a Spanish caller's translator reads cu_lib_sort… (Title Case: a person
 *  taps it). This lib imports no catalog. An unknown key reads as itself. */
export function crmOrderLabel(key: string, lang: Lang = "en", words?: Words): string {
  const en = CRM_SORT_OPTIONS.find((o) => o.key === key)?.label;
  if (en === undefined || !isCrmSortKey(key)) return String(key ?? "");
  return say(lang, words, CRM_SORT_LABEL_KEY[key], en);
}

/** The direction a key means when nobody has said otherwise: names read A→Z, "recent" means
 *  newest first. Picking a key from the bar lands on this; the toggle flips it. */
const NATURAL_DIR: Record<CrmSortKey, SortDir> = { name: "asc", company: "asc", recent: "desc" };

const COLUMN: Record<CrmSortKey, string> = { name: "name", company: "company_name", recent: "created_at" };

export function isCrmSortKey(k: string): k is CrmSortKey {
  return (CRM_SORT_KEYS as readonly string[]).includes(k);
}

export function naturalCrmDir(key: CrmSortKey): SortDir {
  return NATURAL_DIR[key];
}

/** "name.asc" / "company.desc" / "recent" (dir optional → the key's natural direction). Anything
 *  unrecognised — a stale link, a typo, an old key — falls back to the default rather than
 *  erroring: a bad ?sort= must never blank the contact list. */
export function parseCrmSort(raw: string | undefined | null): SortSpec {
  if (!raw) return CRM_DEFAULT_SORT;
  const [k = "", d = ""] = raw.trim().toLowerCase().split(".");
  if (!isCrmSortKey(k)) return CRM_DEFAULT_SORT;
  const dir: SortDir = d === "asc" || d === "desc" ? d : NATURAL_DIR[k];
  return { key: k, dir };
}

/** The inverse of parseCrmSort — what goes in the URL and in localStorage. */
export function formatCrmSort(spec: SortSpec): string {
  return `${spec.key}.${spec.dir}`;
}

export function isDefaultCrmSort(spec: SortSpec): boolean {
  return spec.key === CRM_DEFAULT_SORT.key && spec.dir === CRM_DEFAULT_SORT.dir;
}

/** The Supabase .order() arguments for a spec. nullsFirst is always false: a contact with no
 *  company sinks to the bottom whichever way the list is flipped — the same "nulls always sink"
 *  law sortRows applies in memory, so the two halves of the primitive never disagree. */
export function crmOrderColumn(spec: SortSpec): { column: string; ascending: boolean; nullsFirst: boolean } {
  const key: CrmSortKey = isCrmSortKey(spec.key) ? spec.key : "name";
  return { column: COLUMN[key], ascending: spec.dir !== "desc", nullsFirst: false };
}
