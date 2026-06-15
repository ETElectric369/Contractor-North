"use client";

import Link from "next/link";
import type { DayBlock, DayPerson } from "./day-grid";

const pad = (n: number) => String(n).padStart(2, "0");
const localDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(":00", "");

const CHIP: Record<DayBlock["kind"], string> = {
  job: "bg-[rgb(var(--glass-tint))]/15 text-slate-700 border-l-2 border-[rgb(var(--glass-tint))]",
  appt: "bg-violet-100 text-violet-800 border-l-2 border-violet-400",
  time: "bg-emerald-100 text-emerald-800 border-l-2 border-emerald-500",
};

const COLS = "120px repeat(7, minmax(0, 1fr))";

/** A week roster: one row per crew member, one column per day; each cell shows
 *  that person's jobs / appointments / clocked time as compact chips — so you
 *  can see your week next to everyone else's. */
export function WeekGrid({
  people,
  blocks,
  days,
}: {
  people: DayPerson[];
  blocks: DayBlock[];
  days: string[]; // 7 × YYYY-MM-DD (Mon→Sun)
}) {
  const today = localDateStr(new Date());
  const cellKey = (pid: string, day: string) => `${pid}::${day}`;

  const byCell = new Map<string, DayBlock[]>();
  let hasUnassigned = false;
  for (const b of blocks) {
    const day = localDateStr(new Date(b.startIso));
    if (!days.includes(day)) continue;
    if (!b.personId) hasUnassigned = true;
    const k = cellKey(b.personId ?? "__none", day);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k)!.push(b);
  }
  for (const arr of byCell.values()) {
    arr.sort((a, b) => +new Date(a.startIso) - +new Date(b.startIso));
  }

  const rows: DayPerson[] = [...people, ...(hasUnassigned ? [{ id: "__none", name: "Unassigned" }] : [])];
  const dayLabel = (day: string) =>
    new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <div className="min-w-[760px]">
        <div className="grid" style={{ gridTemplateColumns: COLS }}>
          <div className="sticky left-0 z-10 border-b border-r border-slate-100 bg-slate-50/70 px-2 py-2 text-xs font-semibold text-slate-500">
            Crew
          </div>
          {days.map((day) => (
            <div
              key={day}
              className={`border-b border-slate-100 px-2 py-2 text-center text-xs font-semibold ${
                day === today ? "bg-brand/10 text-brand-dark" : "bg-slate-50/70 text-slate-500"
              }`}
            >
              {dayLabel(day)}
            </div>
          ))}
        </div>

        {rows.map((person) => (
          <div
            key={person.id}
            className="grid border-b border-slate-100 last:border-b-0"
            style={{ gridTemplateColumns: COLS }}
          >
            <div className="sticky left-0 z-10 truncate border-r border-slate-100 bg-white px-2 py-2 text-xs font-semibold text-slate-700">
              {person.name}
            </div>
            {days.map((day) => {
              const cell = byCell.get(cellKey(person.id, day)) ?? [];
              return (
                <div key={day} className={`min-h-[58px] space-y-1 px-1 py-1 ${day === today ? "bg-brand/5" : ""}`}>
                  {cell.map((b) => (
                    <Link
                      key={b.id}
                      href={b.href}
                      className={`block truncate rounded px-1.5 py-1 text-[10px] leading-tight ${CHIP[b.kind]}`}
                      title={`${b.label}${b.sublabel ? ` — ${b.sublabel}` : ""}`}
                    >
                      <span className="font-semibold tabular-nums">
                        {fmtTime(b.startIso)}
                        {b.open ? "–now" : b.endIso ? `–${fmtTime(b.endIso)}` : ""}
                      </span>{" "}
                      {b.label}
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
