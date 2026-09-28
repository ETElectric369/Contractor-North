/**
 * ONE CREW CHANGE, APPLIED TO THE CREW AS IT IS NOW (not the crew a page loaded a while ago). The job
 * page's crew chips send "put Mike on" or "take Brian off", never a whole list: a whole list built on a
 * page that has gone stale would silently take off whoever someone else put on in the meantime (a
 * foreman from the time clock, the schedule board, Nort). Order is kept, nobody is listed twice.
 */
export type CrewChange = { add?: string | null; remove?: string | null };

export function applyCrewChange(current: readonly string[] | null | undefined, change: CrewChange): string[] {
  const add = change.add ? String(change.add) : null;
  const remove = change.remove ? String(change.remove) : null;
  const out: string[] = [];
  for (const raw of current ?? []) {
    const id = String(raw ?? "");
    if (!id || id === remove || out.includes(id)) continue;
    out.push(id);
  }
  if (add && add !== remove && !out.includes(add)) out.push(add);
  return out;
}
