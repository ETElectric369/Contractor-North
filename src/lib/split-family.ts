/**
 * WHICH ENTRIES ARE ONE SPLIT SHIFT (0288).
 *
 * A split shift is ordinary time entries. Every piece cut from a shift points at that shift's FIRST
 * entry through `split_from` (the first entry keeps the original id and points at nothing), so a
 * family is "the first entry, and everything that points at it". Timecards brackets a family as
 * "Split from one shift", and the edit sheet offers Move The Split and Join Back only between two
 * pieces of the same family that touch.
 *
 * Pure: the page hands it the rows it already read.
 */

export type FamilyRow = {
  id: string;
  profile_id?: string | null;
  clock_in: string;
  clock_out: string | null;
  split_from?: string | null;
  split_how?: string | null;
};

/** id → the family it belongs to (the first entry's id), for every row that is part of a split. */
export function splitFamilies(rows: FamilyRow[]): Map<string, string> {
  const parents = new Set<string>();
  for (const r of rows ?? []) if (r?.split_from) parents.add(String(r.split_from));
  const out = new Map<string, string>();
  for (const r of rows ?? []) {
    if (!r?.id) continue;
    if (r.split_from) out.set(String(r.id), String(r.split_from));
    else if (parents.has(String(r.id))) out.set(String(r.id), String(r.id));
  }
  return out;
}

/** True when any piece of the family was rebuilt from an old allocation split by 0289. */
export function familyWasConverted(rows: FamilyRow[], family: string): boolean {
  return (rows ?? []).some((r) => r?.split_from === family && r.split_how === "converted");
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && Math.abs(Date.parse(a) - Date.parse(b)) < 1000;

/** The pieces of the same family that end where this one starts (prev) and start where it ends (next). */
export function splitNeighbors<T extends FamilyRow>(rows: T[], id: string): { prev: T | null; next: T | null } {
  const fam = splitFamilies(rows);
  const me = (rows ?? []).find((r) => r.id === id);
  const key = fam.get(id);
  if (!me || !key) return { prev: null, next: null };
  const kin = rows.filter((r) => r.id !== id && fam.get(r.id) === key && (r.profile_id ?? null) === (me.profile_id ?? null));
  return {
    prev: kin.find((r) => same(r.clock_out, me.clock_in)) ?? null,
    next: me.clock_out ? (kin.find((r) => same(r.clock_in, me.clock_out)) ?? null) : null,
  };
}
