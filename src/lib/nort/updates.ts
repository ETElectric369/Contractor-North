import type { NortHolding } from "@/lib/nort/greeting";
import { firstName } from "@/lib/nort/greeting";
import { reportError } from "@/lib/observe";

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
/**
 * How many unheard reports Nort holds and reads out at once — ALL of them, to a safety cap.
 * This was 8, a page: Erik's first night found 31 unheard (a backlog the old digest never
 * stamped), said "sure" twice, got eight each time, and the ring kept pulsing and the greeting
 * kept asking — "its still repeating and pulsing after the report". A hold is finite: one yes
 * empties it. A yes marks heard EXACTLY the reports it read out, by id — never "every unheard
 * one" by filter, which also marked the ones past the cap and any resolved after the read
 * as heard though no one had heard them. Past the cap the rest stay held and the next greeting
 * names them (a report is heard, or it is still being asked about — never lost). The prompt
 * reads the newest few as lines and sums the rest from `summary`, which is computed here, not
 * by the model.
 */
export const REPORTS_LIMIT = 100;
const DEFAULT_TZ = "UTC";
export const DAILY_REPORT_AGE_MS = 2 * 24 * 60 * 60 * 1000;
/** A report filed longer ago than this is OLD: the greeting says how far back, the line says when. */
export const REPORT_OLD_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** "Sep 30" — the day a report was filed, in the company's timezone (what Nort says back comes
 *  from the stored instant formatted in the org's tz — lib/org-local-time's rule; 7:34 PM Pacific
 *  on the 29th is the 30th in UTC and must not be said as the 30th). */
export function filedWords(iso: string | null | undefined, tz: string = DEFAULT_TZ): string | null {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return null;
  try {
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  } catch {
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: DEFAULT_TZ });
  }
}

/**
 * How far back the held reports were FILED, when any of them is old: the month (and the year
 * when it is not this one) of the oldest. null while every held report is within
 * REPORT_OLD_AFTER_MS — a fresh batch needs no qualifier. It is the FILING date (bug_reports has
 * no resolved stamp), which is why the greeting says "filed as far back as July", not "from July".
 */
export function reportsBack(filed: (string | null | undefined)[], now: number, tz: string = DEFAULT_TZ): string | null {
  const ts = filed.map((d) => Date.parse(String(d ?? ""))).filter((t) => Number.isFinite(t));
  if (!ts.length) return null;
  const oldestMs = Math.min(...ts);
  if (now - oldestMs < REPORT_OLD_AFTER_MS) return null;
  const oldest = new Date(oldestMs);
  const fmt = (o: Intl.DateTimeFormatOptions) => {
    try {
      return oldest.toLocaleDateString("en-US", { ...o, timeZone: tz });
    } catch {
      return oldest.toLocaleDateString("en-US", { ...o, timeZone: DEFAULT_TZ });
    }
  };
  const month = fmt({ month: "long" });
  const year = fmt({ year: "numeric" });
  const thisYear = (() => {
    try {
      return new Date(now).toLocaleDateString("en-US", { year: "numeric", timeZone: tz });
    } catch {
      return new Date(now).toLocaleDateString("en-US", { year: "numeric", timeZone: DEFAULT_TZ });
    }
  })();
  return year === thisYear ? month : `${month} ${year}`;
}

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

// A read that fails HERE is a greeting that does not ask this time — nothing is stamped by looking,
// so the next Talk asks again — AND IT IS FILED (cn-v1130): both reads used to drop their error on
// the floor, so a broken read of the held reports was invisible to ops. The hand-over below
// (readMyUpdates) is the one that says its read failures to the person: it is the one a yes is
// waiting on.
export async function holdingFor(userId: string, service: Client, rls: Client, tz: string = DEFAULT_TZ): Promise<NortHolding> {
  const [reports, daily] = await Promise.all([
    service.from("bug_reports").select("id, created_at").eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).order("created_at", { ascending: false }).limit(REPORTS_LIMIT),
    rls.from("notifications").select("id, title").eq("user_id", userId).eq("type", "daily_report").is("read_at", null).gte("created_at", sinceIso()).order("created_at", { ascending: false }).limit(10),
  ]);
  if (reports.error) reportError("nort:holding", reports.error, { userId });
  if (daily.error) reportError("nort:holding", daily.error, { userId, read: "daily_report" });
  const seen = new Set<string>();
  const dailyReports: { from: string }[] = [];
  for (const n of (daily.data ?? []) as { title?: string | null }[]) {
    const from = safeFrom(n.title);
    if (seen.has(from)) continue; // two reports from one person are named once; the hand-over reads both
    seen.add(from);
    dailyReports.push({ from });
  }
  const held = reports.error ? [] : ((reports.data ?? []) as { created_at?: string | null }[]);
  const back = reportsBack(held.map((r) => r.created_at), Date.now(), tz);
  return { reports: held.length, dailyReports, ...(back ? { reportsBack: back } : {}) };
}

/** The outcomes of a hand-over, counted in code so the model never has to (it reads a few lines
 *  and sums the rest from these numbers). `filedFrom`/`filedTo` are the oldest and newest filing
 *  days, in the company's timezone. */
export type UpdatesSummary = {
  total: number;
  shipped: number;
  notBeingBuilt: number;
  closed: number;
  filedFrom: string | null;
  filedTo: string | null;
};

export function summarize(rows: { status: string; created_at?: string | null }[], tz: string = DEFAULT_TZ): UpdatesSummary {
  const ts = rows.map((r) => Date.parse(String(r.created_at ?? ""))).filter((t) => Number.isFinite(t));
  return {
    total: rows.length,
    shipped: rows.filter((r) => r.status === "fixed").length,
    notBeingBuilt: rows.filter((r) => r.status === "wontfix").length,
    closed: rows.filter((r) => r.status === "closed").length,
    filedFrom: ts.length ? filedWords(new Date(Math.min(...ts)).toISOString(), tz) : null,
    filedTo: ts.length ? filedWords(new Date(Math.max(...ts)).toISOString(), tz) : null,
  };
}

export type MyUpdates = {
  /** `filed` is the day they reported it; `old` marks one filed longer ago than REPORT_OLD_AFTER_MS
   *  (two weeks), and Nort opens that line with the date so weeks-old news is not read as this
   *  morning's. Newest first. */
  reports: { outcome: string; note: string; filed: string | null; old?: true }[];
  /** The outcomes counted — the model sums from here, never by counting lines. */
  summary?: UpdatesSummary;
  dailyReports: { from: string; line: string; url: string | null }[];
  /** They said SKIP: the updates on things they reported were marked heard without being read. */
  skipped?: { reports: number };
  /** After a skip: the crew's daily reports are NOT skipped (they are the office's real news, not
   *  stale) — still held, by who filed them, so Nort can say so. */
  stillHolding?: { dailyReports: string[] };
  /** A read or a stamp that did not land: said in words, so the person is never told "nothing"
   *  about a hold that could not be read, and the same lines are offered again next time. */
  unstamped?: string;
};

/**
 * THEY SAID SKIP (Erik: "all of the things that you just mentioned to me are old"): mark every
 * unheard resolved report of THEIRS heard — all of them, by filter, not a page — without reading
 * any back. A crew daily report is not skipped: it is under two days old by construction and it
 * is the office's news, not a stale backlog; it stays held and Nort says so. The write asks for
 * its rows back; a miss is said, never swallowed.
 */
export async function skipMyUpdates(userId: string, service: Client, rls: Client): Promise<MyUpdates> {
  const now = new Date().toISOString();
  const { data: reports, error: rErr } = await service
    .from("bug_reports").update({ filer_notified_at: now })
    .eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).select("id");
  const left = await holdingFor(userId, service, rls).catch(() => null);
  return {
    reports: [],
    dailyReports: [],
    skipped: { reports: rErr ? 0 : ((reports ?? []) as unknown[]).length },
    ...(left?.dailyReports.length ? { stillHolding: { dailyReports: left.dailyReports.map((d) => d.from) } } : {}),
    ...(rErr ? { unstamped: "Couldn't mark the report updates as heard — they will be offered again." } : {}),
  };
}

/** HAND THEM OVER (the person said yes): the lines, and the stamps that say they were heard —
 *  filer_notified_at on the reports, read_at on the daily-report rows — each asked for its rows
 *  back (the silent-write law), a miss reported in the answer rather than swallowed. */
export async function readMyUpdates(userId: string, service: Client, rls: Client, opts?: { skip?: boolean; tz?: string }): Promise<MyUpdates> {
  if (opts?.skip === true) return skipMyUpdates(userId, service, rls);
  const tz = opts?.tz || DEFAULT_TZ;
  const nowMs = Date.now();
  const [{ data: shipped, error: shippedErr }, { data: daily, error: dailyErr }] = await Promise.all([
    service.from("bug_reports").select("id, note, status, created_at").eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).order("created_at", { ascending: false }).limit(REPORTS_LIMIT),
    rls.from("notifications").select("id, title, body, url").eq("user_id", userId).eq("type", "daily_report").is("read_at", null).gte("created_at", sinceIso()).order("created_at", { ascending: false }).limit(10),
  ]);
  // Newest first, sorted HERE as well as by the query, so the order the model reads is the order
  // whatever answered the query (PostgREST, or a fake in a test) — not a trust in `.order()`.
  const rows = ([...((shipped ?? []) as { id: string; note: string | null; status: string; created_at?: string | null }[])]).sort(
    (a, b) => (Date.parse(String(b.created_at ?? "")) || 0) - (Date.parse(String(a.created_at ?? "")) || 0),
  );
  const reports = rows.map((r) => {
    const t = Date.parse(String(r.created_at ?? ""));
    const old = Number.isFinite(t) && nowMs - t >= REPORT_OLD_AFTER_MS;
    return {
      outcome: outcomeWords(r.status),
      note: String(r.note ?? "").replace(/\s+/g, " ").replace(/[<>]/g, "").slice(0, 140),
      filed: filedWords(r.created_at, tz),
      ...(old ? { old: true as const } : {}),
    };
  });
  const summary = summarize(rows, tz);
  const dailyReports = ((daily ?? []) as { id: string; title?: string | null; body?: string | null; url?: string | null }[]).map((n) => ({
    from: safeFrom(n.title),
    line: String(n.body ?? "").replace(/[<>]/g, "").slice(0, 140),
    url: n.url ?? null,
  }));
  // A READ THAT FAILED IS NOT AN EMPTY HOLD. The person said yes to "want them now?"; answering
  // "nothing to read" would be a lie, and the ring would pulse on. Say which could not be read —
  // none of it was stamped, so it is still held and a second ask gets it.
  const unread: string[] = [];
  if (shippedErr) unread.push("the report updates");
  if (dailyErr) unread.push("the daily reports");
  const misses: string[] = [];
  const now = new Date().toISOString();
  if (rows.length) {
    // EXACTLY THE ROWS READ OUT, by id: a yes marks heard what the person heard. Not "every unheard
    // one" by filter, which also marked the ones past REPORTS_LIMIT and any resolved after the
    // read. The status and unheard guards stay, so a row reopened since is left alone. Every row
    // read must stamp.
    const ids = rows.map((r) => r.id);
    const { data, error } = await service.from("bug_reports").update({ filer_notified_at: now })
      .in("id", ids).eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).select("id");
    if (error || (data ?? []).length < ids.length) misses.push("the report updates");
  }
  if (daily?.length) {
    const ids = (daily as { id: string }[]).map((n) => n.id);
    const { data, error } = await rls.from("notifications").update({ read_at: now }).in("id", ids).eq("user_id", userId).select("id");
    if (error || (data ?? []).length !== ids.length) misses.push("the daily reports");
  }
  const said = [
    ...(unread.length ? [`Couldn't read ${unread.join(" and ")} just now — they are still held, so ask me again.`] : []),
    ...(misses.length ? [`Couldn't mark ${misses.join(" and ")} as heard — they will be offered again.`] : []),
  ];
  return { reports, ...(rows.length ? { summary } : {}), dailyReports, ...(said.length ? { unstamped: said.join(" ") } : {}) };
}
