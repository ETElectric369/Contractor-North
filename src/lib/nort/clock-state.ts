/**
 * YOUR CLOCK RIGHT NOW (2026-10-20). Twice in one night Nort told Erik where he was on the clock
 * from an earlier turn: once after the screen had closed the punch ("you're already clocked in on
 * …"), once "already on the clock at 85 Larkspur" with no tool call at all, a punch Erik had closed
 * on the screen fifteen minutes before. The deeds law says read first; a law is words, and this is
 * the dots: the caller's own open punch, read fresh on every turn and put in front of him in the
 * volatile prompt, so there is nothing to remember and nothing to get wrong. Pure: the route reads
 * the row, this writes the line.
 */
export type OpenClockRow = {
  clock_in: string;
  job_id: string | null;
  jobs?: { job_number?: string | null; name?: string | null; address?: string | null } | { job_number?: string | null; name?: string | null; address?: string | null }[] | null;
} | null;

export const CLOCK_LINE_LAW =
  "Say whether you are on the clock, and on which job, ONLY from this line or from a tool result in THIS turn — never from an earlier turn: the screen can open or close a punch between two turns.";

export function clockStateLine(row: OpenClockRow | undefined, tz: string, readFailed = false): string {
  if (readFailed) {
    return "\n\nYOUR CLOCK RIGHT NOW: could not be read for this turn — before saying whether you are on the clock, read who_is_clocked_in.";
  }
  let state: string;
  if (!row) state = "NOT on the clock.";
  else {
    const t = new Date(row.clock_in);
    const since = isNaN(t.getTime()) ? "" : ` since ${t.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;
    const j = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
    const label = j ? [j.job_number, j.name || j.address].filter(Boolean).join(" ") : "";
    state = row.job_id && label ? `ON the clock${since} on ${label}.` : `ON the clock${since}, on no job.`;
  }
  return `\n\nYOUR CLOCK RIGHT NOW (read fresh for this turn — the one truth about your own punch): ${state} ${CLOCK_LINE_LAW}`;
}
