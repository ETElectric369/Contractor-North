import "server-only";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { getOrgSettings } from "@/lib/org-settings";
import { orgStaffIdsOrThrow } from "@/lib/push";
import { notifyPeople } from "@/lib/notifications";
import { readActiveOrgs } from "@/lib/cron-orgs";
import { reportError } from "@/lib/observe";
import { isOpenToBuy, newestListPerJob } from "@/lib/materials-checklist";
import { fillSlots, type Words } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";
import { materialsJobStatusOk } from "./materials-needed-rule";
import { readNeedsYouWaits, waitKey } from "./needs-you-waits";
import { jobWords } from "./words";

/**
 * THE MORNING MATERIALS NOTICE (cn-v1179). The owner, 2026-11-22: "the bulk of the list isnt needed
 * until i get to the job except picking up materials which could be a reminder notification the
 * morning of a job". So at the company's own 8 AM (the daily run), the office is told, once, which
 * jobs the crew stands on TODAY still have lines to buy.
 *
 * TWO DOORS, ONE THING. Needs You's `materials_needed` row (query.ts) already answers "what is still
 * to buy for the jobs the crew is about to stand on". This is the same answer narrowed to today, and
 * it is built from the SAME rule functions, never a copy of them: which statuses may ask
 * (materialsJobStatusOk), which list is the job's own (newestListPerJob), which line is still to buy
 * (isOpenToBuy), and which row he snoozed (readNeedsYouWaits + waitKey("materials_needed", job)). A
 * source pin in the test holds this file to each of them, so the two doors cannot drift.
 *
 * Where the row reads "today or tomorrow", this reads TODAY only, on the COMPANY's calendar (its
 * timezone, the day the daily run judges its 8 AM on), never the server's: a job whose scheduled
 * start falls inside the company's day, or a schedule segment that covers the company's date.
 *
 * THE SERVICE CLIENT BYPASSES RLS and three companies share one database: EVERY read below names the
 * company by hand (jobs, segments, lists, snoozes), and a segment's job from another company is
 * dropped even if a read ever let it through.
 *
 * NO PRICE, EVER: the notice names the job and how many lines, nothing else.
 *
 * A LOST READ SENDS NOTHING and goes to the error sink: a morning with no buzz is better than a
 * buzz that names a job he snoozed or misses the one that matters. That includes the snoozes: a read
 * of them that is "not ready" (failed, or 0367 not run) sends nothing for that company.
 */

/** One job the crew stands on today with lines still to buy. */
export type MaterialsTodayJob = { id: string; job_number: string | null; name: string | null; open: number };

export type MaterialsTodayRead = { ok: true; jobs: MaterialsTodayJob[] } | { ok: false; error: unknown };

/** The company's today and the instants its day begins and ends (the day after, resolved on the calendar). */
export function companyToday(tz: string, nowMs: number): { todayStr: string; dayStart: Date; dayEnd: Date } {
  const todayStr = todayStrInTz(tz, new Date(nowMs));
  const next = new Date(`${todayStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { todayStr, dayStart: tzDayStartUtc(todayStr, tz), dayEnd: tzDayStartUtc(next.toISOString().slice(0, 10), tz) };
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * THE RULE, NARROWED TO TODAY. Jobs the crew stands on today (scheduled inside the company's day, or a
 * segment covering its date), whose status may still ask (materialsJobStatusOk), with open lines on
 * the job's newest list (newestListPerJob + isOpenToBuy), and no snooze on its Needs You row. Most
 * lines to buy first. Every read names the company.
 */
export async function readMaterialsToday(supabase: any, orgId: string, tz: string, nowMs: number): Promise<MaterialsTodayRead> {
  try {
    const { todayStr, dayStart, dayEnd } = companyToday(tz, nowMs);
    const [jobsR, segR] = await Promise.all([
      supabase
        .from("jobs")
        .select("id, org_id, job_number, name, status, scheduled_start")
        .eq("org_id", orgId)
        .gte("scheduled_start", dayStart.toISOString())
        .lt("scheduled_start", dayEnd.toISOString())
        .limit(200),
      supabase
        .from("job_schedule_segments")
        .select("job_id, start_date, end_date, jobs(id, org_id, job_number, name, status)")
        .eq("org_id", orgId)
        .lte("start_date", todayStr)
        .gte("end_date", todayStr)
        .limit(200),
    ]);
    if (jobsR?.error) throw jobsR.error;
    if (segR?.error) throw segR.error;

    const candidates = new Map<string, { id: string; job_number: string | null; name: string | null }>();
    const consider = (j: any) => {
      if (!j?.id || String(j.org_id ?? orgId) !== orgId) return; // another company's job never rides
      if (!materialsJobStatusOk(j.status) || candidates.has(String(j.id))) return;
      candidates.set(String(j.id), { id: String(j.id), job_number: j.job_number ?? null, name: j.name ?? null });
    };
    for (const j of (jobsR?.data ?? []) as any[]) consider(j);
    for (const s of (segR?.data ?? []) as any[]) consider(one(s.jobs));
    if (!candidates.size) return { ok: true, jobs: [] };

    const ids = [...candidates.keys()];
    const [listsR, waits] = await Promise.all([
      // Newest first, so newestListPerJob keeps the job's own list (the one its Materials tab shows).
      supabase
        .from("material_lists")
        .select("id, job_id, created_at, material_list_items(purchased, is_tool)")
        .eq("org_id", orgId)
        .in("job_id", ids)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(400),
      readNeedsYouWaits(supabase, orgId, todayStr),
    ]);
    if (listsR?.error) throw listsR.error;
    if (!waits.ready) throw new Error("the Needs You snoozes could not be read");

    const jobs: MaterialsTodayJob[] = [];
    for (const ml of newestListPerJob((listsR?.data ?? []) as any[]).values()) {
      const job = candidates.get(String(ml.job_id));
      if (!job) continue;
      const open = ((ml.material_list_items ?? []) as any[]).filter(isOpenToBuy).length;
      if (!open) continue;
      if (waits.waits.has(waitKey("materials_needed", job.id))) continue; // he snoozed the row: no buzz
      jobs.push({ ...job, open });
    }
    jobs.sort((a, b) => b.open - a.open || jobWords(a).localeCompare(jobWords(b)));
    return { ok: true, jobs };
  } catch (error) {
    return { ok: false, error };
  }
}

/** How many jobs the body names before "+N more jobs". */
export const MATERIALS_TODAY_NAMED = 3;

/**
 * THE NOTICE'S WORDS, in the reader's language (`words` is lib/i18n's translator for `lang`, handed in:
 * this file carries no catalog). One job: "Larkspur · J-101: 5 to buy", opening its Materials tab.
 * Several: "Larkspur (5), Snowbell (2), Bayberry (1) +2 more jobs", opening Needs You. No price.
 */
export function materialsTodayNotice(
  jobs: readonly MaterialsTodayJob[],
  lang: Lang,
  words: Words,
): { title: string; body: string; url: string } | null {
  if (!jobs.length) return null;
  const title = words("sh_push_materials_today");
  const name = (j: MaterialsTodayJob) => jobWords(j, lang, words);
  if (jobs.length === 1) {
    const j = jobs[0];
    return { title, body: fillSlots(words("sh_pushMaterialsOne"), { job: name(j), n: j.open }), url: `/jobs/${j.id}?tab=materials` };
  }
  const named = jobs.slice(0, MATERIALS_TODAY_NAMED).map((j) => `${name(j)} (${j.open})`).join(", ");
  const more = jobs.length - MATERIALS_TODAY_NAMED;
  const tail = more <= 0 ? "" : ` ${more === 1 ? words("sh_pushMaterialsMoreOne") : fillSlots(words("sh_pushMaterialsMore"), { n: more })}`;
  return { title, body: named + tail, url: "/planner" };
}

export type MaterialsMorningCounts = { orgs: number; sent: number; nothing: number; already: number; failed: number; lapsed_skipped: number };

/**
 * THE STEP (the daily run, at each company's 8 AM, after the day-ahead digest). Nothing to buy today:
 * nothing sent. Else ONE notice to the office (orgStaffIds: owner, admin, office; never a tech),
 * through notifyPeople, so the bell records it and each person's switch for materials_today is
 * honoured by the push door.
 *
 * ONCE A DAY: the digest's own pattern. The notice leaves a materials_today line on each office
 * person's bell (a default-on kind writes the line for everyone it was meant for, the muted
 * included), so anyone who already has one since the company's midnight is passed over, and a
 * company whose whole office has one is counted `already`. A failed read of those lines throws for
 * that company: it sends nobody this morning, never twice.
 *
 * A company whose plan has ended gets nothing (readActiveOrgs, as the digest). One company's failure
 * is its own: counted, filed as cron-materials-today with its id, and the next company still runs.
 */
export async function sendMaterialsMorning(
  supabase: any,
  opts: { orgIds?: ReadonlySet<string>; nowMs: number; wordsFor: (lang: Lang) => Words },
): Promise<MaterialsMorningCounts> {
  const counts: MaterialsMorningCounts = { orgs: 0, sent: 0, nothing: 0, already: 0, failed: 0, lapsed_skipped: 0 };
  const { rows: orgs, lapsedSkipped } = await readActiveOrgs(supabase);
  counts.lapsed_skipped = lapsedSkipped;

  for (const org of orgs) {
    if (opts.orgIds && !opts.orgIds.has(org.id)) continue; // not this company's hour
    counts.orgs++;
    try {
      const tz = getOrgSettings(org.settings).timezone;
      const read = await readMaterialsToday(supabase, org.id, tz, opts.nowMs);
      if (!read.ok) throw read.error;
      if (!read.jobs.length) {
        counts.nothing++;
        continue;
      }

      const staff = await orgStaffIdsOrThrow(org.id);
      if (!staff.length) continue;

      const { dayStart } = companyToday(tz, opts.nowMs);
      const { data: sentRows, error: sentErr } = await supabase
        .from("notifications")
        .select("user_id")
        .eq("org_id", org.id)
        .eq("type", "materials_today")
        .gte("created_at", dayStart.toISOString());
      if (sentErr) throw sentErr;
      const already = new Set(((sentRows ?? []) as { user_id: string }[]).map((r) => r.user_id));
      const to = staff.filter((id) => !already.has(id));
      if (!to.length) {
        counts.already++;
        continue;
      }

      const jobs = read.jobs;
      await notifyPeople(org.id, to, "materials_today", (lang: Lang) => materialsTodayNotice(jobs, lang, opts.wordsFor(lang))!);
      counts.sent++;
    } catch (e) {
      counts.failed++;
      reportError("cron-materials-today", e, { orgId: org.id });
    }
  }
  return counts;
}
