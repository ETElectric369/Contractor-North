"use client";

import Link from "next/link";

export interface DayBlock {
  id: string;
  personId: string | null; // null = unassigned column
  kind: "job" | "appt" | "time";
  label: string;
  sublabel?: string | null;
  startIso: string;
  endIso: string | null; // null → open / ongoing (time entries)
  href: string;
  open?: boolean;
}
export interface DayPerson {
  id: string;
  name: string;
}

const ROW_H = 52; // px per hour

const KIND_STYLE: Record<DayBlock["kind"], string> = {
  job: "bg-[rgb(var(--glass-tint))]/15 border-l-[3px] border-[rgb(var(--glass-tint))] text-slate-800",
  appt: "bg-violet-100/80 border-l-[3px] border-violet-400 text-violet-900",
  time: "bg-emerald-100/80 border-l-[3px] border-emerald-500 text-emerald-900",
};

const fmtTime = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(":00", "");

const localDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Minutes since local midnight. */
function minOfDay(iso: string) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** Greedy lane-packing within a person's column: overlapping blocks sit side by
 *  side, each cluster sized to its own lane count so a lone block stays full width. */
function packLanes<T extends { startMin: number; endMin: number }>(blocks: T[]) {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: (T & { lane: number; lanes: number })[] = [];
  let cluster: (T & { lane: number; lanes: number })[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = cluster.reduce((m, b) => Math.max(m, b.lane + 1), 0);
    cluster.forEach((b) => (b.lanes = lanes));
    out.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };
  const laneEnds: number[] = [];
  for (const b of sorted) {
    if (cluster.length && b.startMin >= clusterEnd) {
      flush();
      laneEnds.length = 0;
    }
    let lane = laneEnds.findIndex((end) => b.startMin >= end);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(b.endMin);
    } else {
      laneEnds[lane] = b.endMin;
    }
    const item = { ...b, lane, lanes: 1 } as T & { lane: number; lanes: number };
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, b.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export function DayGrid({
  people,
  blocks,
  dateStr,
}: {
  people: DayPerson[];
  blocks: DayBlock[];
  dateStr: string; // YYYY-MM-DD selected local day
}) {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isToday = localDateStr(now) === dateStr;

  // Keep only blocks that start on the selected day in the viewer's timezone
  // (the server sends a generous ±window; the browser knows the real local day).
  const onDay = blocks.filter((b) => localDateStr(new Date(b.startIso)) === dateStr);

  // Resolve each block to local start/end minutes (open entries end at "now").
  const resolved = onDay.map((b) => {
    const startMin = minOfDay(b.startIso);
    let endMin: number;
    if (b.endIso) endMin = minOfDay(b.endIso);
    else if (b.open) endMin = Math.max(startMin + 15, isToday ? nowMin : startMin + 60);
    else endMin = startMin + 60;
    if (endMin <= startMin) endMin = startMin + 30; // floor for visibility
    return { ...b, startMin, endMin: Math.min(endMin, 24 * 60) };
  });

  // Day window: default 6:00–18:00, expanded to fit anything outside it.
  let lo = 6;
  let hi = 18;
  for (const b of resolved) {
    lo = Math.min(lo, Math.floor(b.startMin / 60));
    hi = Math.max(hi, Math.ceil(b.endMin / 60));
  }
  lo = Math.max(0, lo);
  hi = Math.min(24, Math.max(hi, lo + 4));
  const hours = Array.from({ length: hi - lo }, (_, i) => lo + i);
  const gridH = (hi - lo) * ROW_H;

  // Columns: real people, plus an "Unassigned" column if anything lacks a person.
  const hasUnassigned = resolved.some((b) => !b.personId);
  const cols: DayPerson[] = [...people, ...(hasUnassigned ? [{ id: "__none", name: "Unassigned" }] : [])];

  const top = (min: number) => ((min - lo * 60) / 60) * ROW_H;

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <div className="flex min-w-max">
        {/* Hour gutter */}
        <div className="sticky left-0 z-10 w-12 shrink-0 border-r border-slate-100 bg-white">
          <div className="h-9 border-b border-slate-100" />
          <div className="relative" style={{ height: gridH }}>
            {hours.map((h, i) => (
              <div
                key={h}
                className="absolute right-1 -translate-y-1/2 text-[10px] font-medium tabular-nums text-slate-400"
                style={{ top: i * ROW_H }}
              >
                {h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}
              </div>
            ))}
          </div>
        </div>

        {/* Person columns */}
        {cols.map((person) => {
          const mine = packLanes(resolved.filter((b) => (b.personId ?? "__none") === person.id));
          return (
            <div key={person.id} className="w-[160px] shrink-0 border-r border-slate-100 last:border-r-0">
              <div className="flex h-9 items-center justify-center truncate border-b border-slate-100 bg-slate-50/70 px-2 text-xs font-semibold text-slate-700">
                {person.name}
              </div>
              <div className="relative" style={{ height: gridH }}>
                {/* hour gridlines */}
                {hours.map((h, i) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-slate-50"
                    style={{ top: i * ROW_H }}
                  />
                ))}
                {/* now line */}
                {isToday && nowMin >= lo * 60 && nowMin <= hi * 60 && (
                  <div className="absolute inset-x-0 z-20 border-t border-red-400" style={{ top: top(nowMin) }}>
                    <div className="absolute -left-0.5 -top-1 h-2 w-2 rounded-full bg-red-400" />
                  </div>
                )}
                {/* blocks */}
                {mine.map((b) => {
                  const widthPct = 100 / b.lanes;
                  return (
                    <Link
                      key={b.id}
                      href={b.href}
                      className={`absolute overflow-hidden rounded-md px-1.5 py-1 text-[11px] leading-tight shadow-sm transition hover:z-30 hover:shadow-md ${KIND_STYLE[b.kind]}`}
                      style={{
                        top: top(b.startMin) + 1,
                        height: Math.max(20, top(b.endMin) - top(b.startMin) - 2),
                        left: `calc(${b.lane * widthPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                      }}
                      title={`${b.label}${b.sublabel ? ` — ${b.sublabel}` : ""}`}
                    >
                      <div className="truncate font-semibold">{b.label}</div>
                      <div className="truncate opacity-70">
                        {fmtTime(new Date(b.startIso))}
                        {b.open ? "–now" : b.endIso ? `–${fmtTime(new Date(b.endIso))}` : ""}
                        {b.sublabel ? ` · ${b.sublabel}` : ""}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
