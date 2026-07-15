// Stable per-employee color for the calendar — no DB / migration. Assigned by
// roster index (so each person keeps the same color across the org), falling back
// to an id hash. Tailwind classes are full static strings so the JIT keeps them.

export type MemberColor = { bg: string; border: string; text: string; dot: string };

const PALETTE: MemberColor[] = [
  { bg: "bg-blue-100", border: "border-blue-300", text: "text-blue-900", dot: "bg-blue-500" },
  { bg: "bg-emerald-100", border: "border-emerald-300", text: "text-emerald-900", dot: "bg-emerald-500" },
  { bg: "bg-violet-100", border: "border-violet-300", text: "text-violet-900", dot: "bg-violet-500" },
  { bg: "bg-amber-100", border: "border-amber-300", text: "text-amber-900", dot: "bg-amber-500" },
  { bg: "bg-rose-100", border: "border-rose-300", text: "text-rose-900", dot: "bg-rose-500" },
  { bg: "bg-cyan-100", border: "border-cyan-300", text: "text-cyan-900", dot: "bg-cyan-500" },
  { bg: "bg-lime-100", border: "border-lime-300", text: "text-lime-900", dot: "bg-lime-500" },
  { bg: "bg-fuchsia-100", border: "border-fuchsia-300", text: "text-fuchsia-900", dot: "bg-fuchsia-500" },
  { bg: "bg-orange-100", border: "border-orange-300", text: "text-orange-900", dot: "bg-orange-500" },
  { bg: "bg-teal-100", border: "border-teal-300", text: "text-teal-900", dot: "bg-teal-500" },
  { bg: "bg-indigo-100", border: "border-indigo-300", text: "text-indigo-900", dot: "bg-indigo-500" },
  { bg: "bg-pink-100", border: "border-pink-300", text: "text-pink-900", dot: "bg-pink-500" },
];

const UNASSIGNED: MemberColor = {
  bg: "bg-slate-100",
  border: "border-slate-300",
  text: "text-slate-700",
  dot: "bg-slate-400",
};

export function colorForMember(id: string | null | undefined, members: { id: string }[]): MemberColor {
  if (!id) return UNASSIGNED;
  const i = members.findIndex((m) => m.id === id);
  const idx = i >= 0 ? i : [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  return PALETTE[idx % PALETTE.length];
}

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

export function initialsOf(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function firstNameOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "—";
}
