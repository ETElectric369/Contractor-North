import type { WorkedPerson } from "@/lib/schedule/plan-vs-actual";

/**
 * THE WORKED TRACK (Wave 2, SV-actual; TEXT TO VISUAL): what happened on a past day, as a small
 * horizontal track under the words. The booked span is an outline; each person's stretches are bars in
 * their own color beneath it (the same color as their chip on the tile and their bar on the grid), with
 * their initials; the sentence stays as the label for whoever reads. A ghost (work nobody booked) has no
 * booked span: only the bars. Read-only marks; no money, ever.
 */
export function WorkedTrack({
  booked,
  people,
  sentence,
}: {
  /** The booked block, minutes past midnight; null for work nobody booked. */
  booked: { startMin: number; endMin: number } | null;
  people: WorkedPerson[];
  /** The words under it ("Booked 9–5 · Erik 10–6 · 1h late"). */
  sentence: string;
}) {
  let lo = booked?.startMin ?? Infinity;
  let hi = booked?.endMin ?? -Infinity;
  for (const p of people) for (const s of p.spans) {
    lo = Math.min(lo, s.startMin);
    hi = Math.max(hi, s.endMin);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    lo = 0;
    hi = 24 * 60;
  }
  const pct = (m: number) => `${(((m - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  const wid = (a: number, b: number) => `${Math.max(1.5, ((b - a) / (hi - lo)) * 100).toFixed(2)}%`;
  return (
    <div className="space-y-1" role="img" aria-label={sentence}>
      <div className="space-y-0.5" aria-hidden="true">
        {booked && (
          <div className="flex items-center gap-1.5">
            <span className="w-4 shrink-0" />
            <div className="relative h-2 min-w-0 flex-1">
              <span
                data-booked
                className="absolute inset-y-0 rounded-sm border border-slate-400 bg-white"
                style={{ left: pct(booked.startMin), width: wid(booked.startMin, booked.endMin) }}
              />
            </div>
          </div>
        )}
        {people.map((p) => (
          <div key={p.profileId} className="flex items-center gap-1.5">
            <span
              title={p.name}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white ${p.dot}`}
            >
              {p.initials}
            </span>
            <div className="relative h-1.5 min-w-0 flex-1">
              {p.spans.map((s, i) => (
                <span
                  key={i}
                  className={`absolute inset-y-0 rounded-full ${p.dot}`}
                  style={{
                    left: pct(s.startMin),
                    width: wid(s.startMin, s.endMin),
                    ...(s.open ? { maskImage: "linear-gradient(to right, black 55%, transparent)", WebkitMaskImage: "linear-gradient(to right, black 55%, transparent)" } : {}),
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] leading-snug text-slate-600">{sentence}</p>
    </div>
  );
}
