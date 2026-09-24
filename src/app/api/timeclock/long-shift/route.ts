import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { reportError } from "@/lib/observe";
import { createNotifications } from "@/lib/notifications";
import { orgStaffIds, sendPushToProfiles } from "@/lib/push";
import { isStaffRole } from "@/lib/actions/perms";
import { jobLabel } from "@/lib/schedule-options";
import { LONG_SHIFT_HOURS, OFFICE_BELL_HOURS, clockDoorWords, pickLongShiftSteps, quietHold } from "@/lib/long-shift";

/**
 * THE LONG-SHIFT JOB (2026-09-24). Hourly (vercel.json "0 * * * *").
 *
 * Erik: "Brian did it the other day too and I had no way to stop it to set the time for the
 * invoice". A forgotten clock was found by the office a day later, by hand. Then, the same day:
 * "I think 12 hours is a good question point mark" and "Put a line on the Bell at 10 hours and buzz
 * at 12". So a running clock is spoken about in two steps, each at most once per shift:
 *
 *   OFFICE_BELL_HOURS (10): a line on the office's bell. No push, nobody asked. A bell line is
 *     silent, so it goes out at any hour.
 *   LONG_SHIFT_HOURS (12): the person whose clock it is is asked (push and bell) while he still
 *     remembers when he stopped, and the office's phones buzz. Pushes never go out between 9 PM and
 *     6 AM org-local; the 6 AM run does them. Brian's 1:37 PM clock-in puts the office's line on the
 *     bell at 11:37 PM, reaches twelve hours at 1:37 AM inside the hold, and is asked at 6:00 AM,
 *     16.4 hours in and still under the 18-hour ceiling his own picker allows.
 *
 * It never closes anything. A clock stops only at a time a person states (payroll does not invent
 * hours, and nothing here observed when the work ended).
 *
 * CLAIM FIRST, PER STEP. Each step has its own column (0291): long_shift_warned_at for the bell
 * line, long_shift_nudged_at for the question and the buzz. It is set with a guarded UPDATE before
 * anything is sent, and a zero-row claim is skipped, so two overlapping runs never tell anybody
 * twice, and the 10-hour line can never stand in for the 12-hour question.
 *
 * WHO HEARS. The office is its staff who may see the timecards (owner, admin, office: orgStaffIds,
 * active only), about a crew member's clock; a staff member's own clock is his own business, as it
 * was. Each push respects the reader's own switch in Settings: the crew member's rides clock_out,
 * the office's rides long_shift. A removed person's phone is never pushed, but the office still
 * hears about the clock he left running: that is exactly the one nobody else will stop.
 *
 * The service client bypasses RLS: every query is org-scoped by hand.
 *
 *   GET /api/timeclock/long-shift   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const counts = { orgs: 0, held: 0, bells_due: 0, nudges_due: 0, office_bells: 0, asked: 0, office_buzzes: 0, failed: 0 };
  const { data: orgs, error: orgErr } = await supabase.from("organizations").select("id, settings");
  if (orgErr) {
    reportError("cron-long-shift", orgErr);
    return NextResponse.json({ ...counts, failed: 1 }, { status: 500 });
  }

  for (const org of orgs ?? []) {
    counts.orgs++;
    const tz = getOrgSettings(org.settings).timezone;
    const nowMs = Date.now();
    // Counted, not skipped: the night holds the pushes, never the office's bell line.
    if (quietHold(nowMs, tz)) counts.held++;
    try {
      const { data: open, error } = await supabase
        .from("time_entries")
        .select(
          "id, profile_id, clock_in, long_shift_warned_at, long_shift_nudged_at, job:job_id(job_number, name), profiles:profile_id(full_name, role, active)",
        )
        .eq("org_id", org.id)
        .eq("status", "open")
        .or("long_shift_warned_at.is.null,long_shift_nudged_at.is.null");
      if (error) throw error;

      type Person = { full_name?: string | null; role?: string | null; active?: boolean | null };
      type Job = { job_number?: string | null; name?: string | null };
      type Row = {
        id: string;
        profile_id: string;
        clock_in: string;
        long_shift_warned_at: string | null;
        long_shift_nudged_at: string | null;
        job?: Job | Job[] | null;
        profiles?: Person | Person[] | null;
      };
      const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
      const { bell, nudge } = pickLongShiftSteps((open ?? []) as unknown as Row[], nowMs, tz);
      counts.bells_due += bell.length;
      counts.nudges_due += nudge.length;
      if (!bell.length && !nudge.length) continue;

      let staffIds: string[] | null = null;
      const office = async () => (staffIds ??= await orgStaffIds(org.id));

      /** The guarded claim: true only when THIS run set the column. */
      const claim = async (id: string, column: "long_shift_warned_at" | "long_shift_nudged_at") => {
        const { data: claimed, error: claimErr } = await supabase
          .from("time_entries")
          .update({ [column]: new Date(nowMs).toISOString() })
          .eq("id", id)
          .eq("org_id", org.id)
          .eq("status", "open")
          .is(column, null)
          .select("id");
        if (claimErr) throw claimErr;
        return !!claimed?.length; // zero rows: another run took it, or the clock stopped meanwhile
      };

      /** The facts every sentence names, in the org's clock. */
      const facts = (r: Row) => {
        const person = one(r.profiles);
        const job = one(r.job);
        const inAt = new Date(r.clock_in);
        const since = `${inAt.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${inAt
          .toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
          .replace(/ /g, " ")}`; // ICU's narrow no-break space before AM/PM, as a plain space
        const name = (person?.full_name ?? "").trim();
        return {
          person,
          crew: !isStaffRole(person?.role ?? ""),
          label: job ? jobLabel(job) : null,
          since,
          first: name.split(/\s+/)[0] || "A crew member",
          door: clockDoorWords(name).clockOut,
          hours: Math.floor((nowMs - inAt.getTime()) / 3_600_000),
        };
      };

      // ── STEP ONE: the office's bell line at OFFICE_BELL_HOURS. Silent, so never held. ──
      for (const r of bell) {
        if (!(await claim(r.id, "long_shift_warned_at"))) continue;
        const f = facts(r);
        if (!f.crew) continue;
        await createNotifications(org.id, await office(), {
          type: "long_shift",
          title: `${f.first} Is Still On The Clock`,
          body:
            `Clocked in ${f.since}${f.label ? ` at ${f.label}` : ""}, ${f.hours} hours ago. ` +
            `If the shift is over, ${f.door} on Timecards. At ${LONG_SHIFT_HOURS} hours ${f.first} is asked.`,
          url: `/timecards?entry=${r.id}`,
        });
        counts.office_bells++;
      }

      // ── STEP TWO: at LONG_SHIFT_HOURS the person is asked and the office buzzes (never at night). ──
      for (const r of nudge) {
        if (!(await claim(r.id, "long_shift_nudged_at"))) continue;
        const f = facts(r);

        if (f.person?.active !== false) {
          const title = "Still On The Clock?";
          const body = `You've been clocked in${f.label ? ` at ${f.label}` : ""} since ${f.since}. Tap to set when you stopped.`;
          await sendPushToProfiles([r.profile_id], "clock_out", { title, body, url: "/timeclock" });
          await createNotifications(org.id, [r.profile_id], { type: "long_shift", title, body, url: "/timeclock" });
          counts.asked++;
        }

        if (f.crew) {
          await sendPushToProfiles(await office(), "long_shift", {
            title: `${f.first} Is Still On The Clock`,
            body:
              `Clocked in ${f.since}${f.label ? ` at ${f.label}` : ""}, ${f.hours} hours ago` +
              `${f.person?.active === false ? " (no longer on your crew)" : `. ${f.first} has been asked when the shift ended`}. ` +
              `${f.door} on Timecards if you know.`,
            url: `/timecards?entry=${r.id}`,
          });
          counts.office_buzzes++;
        }
      }
    } catch (e) {
      // Nothing silent: a cron JSON nobody reads is not a report (audit v921).
      counts.failed++;
      reportError("cron-long-shift", e, { orgId: org.id });
    }
  }

  return NextResponse.json({ ...counts, bell_hours: OFFICE_BELL_HOURS, ask_hours: LONG_SHIFT_HOURS });
}
