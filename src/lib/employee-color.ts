// Per-employee display helpers for the calendar/timecards. The old roster-index
// MemberColor palette (colorForMember) and initialsOf died with their last consumers
// (cn-v330 / week-agenda in cn-v507) and were removed in the 2026-07-16 churn audit —
// pillColorForPerson below is the live person-color SSOT.

/** The /timecards week-grid person color: a curated 8-color pill palette keyed
 *  by a STABLE HASH of the profile id (not roster index — the roster reorders
 *  when people join/leave, and a timecard pill must keep its color week to
 *  week). `pill` styles the grid pill, `dot` the legend chip's swatch. */
export type PersonPillColor = { pill: string; dot: string };

const PERSON_PILL_PALETTE: PersonPillColor[] = [
  { pill: "border-blue-300 bg-blue-100 text-blue-900", dot: "bg-blue-500" },
  { pill: "border-emerald-300 bg-emerald-100 text-emerald-900", dot: "bg-emerald-500" },
  { pill: "border-violet-300 bg-violet-100 text-violet-900", dot: "bg-violet-500" },
  { pill: "border-amber-300 bg-amber-100 text-amber-900", dot: "bg-amber-500" },
  { pill: "border-rose-300 bg-rose-100 text-rose-900", dot: "bg-rose-500" },
  { pill: "border-cyan-300 bg-cyan-100 text-cyan-900", dot: "bg-cyan-500" },
  { pill: "border-orange-300 bg-orange-100 text-orange-900", dot: "bg-orange-500" },
  { pill: "border-indigo-300 bg-indigo-100 text-indigo-900", dot: "bg-indigo-500" },
];

export function pillColorForPerson(id: string | null | undefined): PersonPillColor {
  if (!id) return { pill: "border-slate-300 bg-slate-100 text-slate-700", dot: "bg-slate-400" };
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PERSON_PILL_PALETTE[h % PERSON_PILL_PALETTE.length];
}

export function firstNameOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "—";
}
