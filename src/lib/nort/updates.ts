import type { NortHolding } from "@/lib/nort/greeting";
import { firstName } from "@/lib/nort/greeting";

/**
 * WHAT NORT IS HOLDING FOR A PERSON, and the one door that hands it over (0394).
 *
 * Two kinds today: their own bug reports that were resolved since they last heard (the return
 * leg, 0196 — the chat route used to read these out unasked on the first reply and stamp them on
 * injection), and crew-lead daily reports the office has not read (the Bell's daily_report rows,
 * the last two days: a report older than that is yesterday's business on My Day, not something
 * to hold a person up with — [[badges-show-open]]).
 *
 * The reads take the two clients they need: bug_reports' read policy is staff-only, so the
 * caller's OWN rows come through the service client filtered BY HAND to reported_by = them (a
 * tech who filed a report is the person this exists for); notifications are theirs by RLS.
 * Nothing is stamped by looking — only readMyUpdates stamps, when the person said yes.
 *
 * A filer's name reaches a prompt and a spoken line: it is their first name only, letters and
 * a few marks, short — a full_name is a thing its owner types.
 */
type Client = any;
const RESOLVED = ["fixed", "closed", "wontfix"];
const FROM = /^Daily report from (.+)$/i;
export const REPORTS_LIMIT = 8;
export const DAILY_REPORT_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** The filer's first name, safe for a prompt and a voice: letters, digits, space, ' . -; 24 at most. */
export function safeFrom(title: string | null | undefined): string {
  const m = FROM.exec(String(title ?? "").trim());
  const first = firstName(m ? m[1] : null) ?? "";
  const clean = Array.from(first.replace(/[^\p{L}\p{N} '.-]/gu, "")).slice(0, 24).join("").trim();
  return clean || "the crew";
}

/** "shipped" / "not being built" / "closed — see note": the outcome a resolved report is read with. */
export function outcomeWords(status: string): string {
  return status === "wontfix" ? "not being built" : status === "closed" ? "closed — see note" : "shipped";
}

const sinceIso = () => new Date(Date.now() - DAILY_REPORT_AGE_MS).toISOString();

export async function holdingFor(userId: string, service: Client, rls: Client): Promise<NortHolding> {
  const [reports, daily] = await Promise.all([
    service.from("bug_reports").select("id").eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).limit(REPORTS_LIMIT),
    rls.from("notifications").select("id, title").eq("user_id", userId).eq("type", "daily_report").is("read_at", null).gte("created_at", sinceIso()).order("created_at", { ascending: false }).limit(10),
  ]);
  const seen = new Set<string>();
  const dailyReports: { from: string }[] = [];
  for (const n of (daily.data ?? []) as { title?: string | null }[]) {
    const from = safeFrom(n.title);
    if (seen.has(from)) continue; // two reports from one person are named once; the hand-over reads both
    seen.add(from);
    dailyReports.push({ from });
  }
  return { reports: reports.error ? 0 : ((reports.data ?? []) as unknown[]).length, dailyReports };
}

export type MyUpdates = {
  reports: { outcome: string; note: string }[];
  dailyReports: { from: string; line: string; url: string | null }[];
  /** A stamp that did not land: said, so the same lines are offered again next time. */
  unstamped?: string;
};

/** HAND THEM OVER (the person said yes): the lines, and the stamps that say they were heard —
 *  filer_notified_at on the reports, read_at on the daily-report rows — each asked for its rows
 *  back (the silent-write law), a miss reported in the answer rather than swallowed. */
export async function readMyUpdates(userId: string, service: Client, rls: Client): Promise<MyUpdates> {
  const [{ data: shipped }, { data: daily }] = await Promise.all([
    service.from("bug_reports").select("id, note, status").eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).order("created_at", { ascending: false }).limit(REPORTS_LIMIT),
    rls.from("notifications").select("id, title, body, url").eq("user_id", userId).eq("type", "daily_report").is("read_at", null).gte("created_at", sinceIso()).order("created_at", { ascending: false }).limit(10),
  ]);
  const reports = ((shipped ?? []) as { id: string; note: string | null; status: string }[]).map((r) => ({
    outcome: outcomeWords(r.status),
    note: String(r.note ?? "").replace(/\s+/g, " ").replace(/[<>]/g, "").slice(0, 140),
  }));
  const dailyReports = ((daily ?? []) as { id: string; title?: string | null; body?: string | null; url?: string | null }[]).map((n) => ({
    from: safeFrom(n.title),
    line: String(n.body ?? "").replace(/[<>]/g, "").slice(0, 140),
    url: n.url ?? null,
  }));
  const misses: string[] = [];
  const now = new Date().toISOString();
  if (shipped?.length) {
    const ids = (shipped as { id: string }[]).map((r) => r.id);
    const { data, error } = await service.from("bug_reports").update({ filer_notified_at: now }).in("id", ids).eq("reported_by", userId).select("id");
    if (error || (data ?? []).length !== ids.length) misses.push("the report updates");
  }
  if (daily?.length) {
    const ids = (daily as { id: string }[]).map((n) => n.id);
    const { data, error } = await rls.from("notifications").update({ read_at: now }).in("id", ids).eq("user_id", userId).select("id");
    if (error || (data ?? []).length !== ids.length) misses.push("the daily reports");
  }
  return { reports, dailyReports, ...(misses.length ? { unstamped: `Couldn't mark ${misses.join(" and ")} as heard — they will be offered again.` } : {}) };
}
