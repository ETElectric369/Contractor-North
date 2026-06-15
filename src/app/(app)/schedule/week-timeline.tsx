import { gatherBlocks, peopleFromBlocks, ScheduleLegend } from "./day-timeline";
import { WeekGrid } from "./week-grid";

/** Per-person WEEK roster: each crew member's jobs/appointments/clocked time
 *  across the 7 days, side by side. */
export async function WeekTimeline({ weekStart, person }: { weekStart: string; person?: string }) {
  // ±18h beyond the 7-day span; the client trims each block to its local day.
  const base = new Date(`${weekStart}T00:00:00`);
  const winStart = new Date(base.getTime() - 18 * 3600 * 1000).toISOString();
  const winEnd = new Date(base.getTime() + (7 * 24 + 18) * 3600 * 1000).toISOString();
  const { blocks, profiles } = await gatherBlocks(winStart, winEnd);
  const people = peopleFromBlocks(profiles, blocks, person);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T12:00:00`);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  return (
    <div>
      <ScheduleLegend />
      {people.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white py-12 text-center text-sm text-slate-400">
          No team members to show for this week.
        </div>
      ) : (
        <WeekGrid people={people} blocks={blocks} days={days} />
      )}
    </div>
  );
}
