import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { reportError } from "@/lib/observe";
import { createNotifications } from "@/lib/notifications";
import { orgStaffIdsOrThrow, sendPushToProfiles } from "@/lib/push";
import { sendSms, smsReadiness } from "@/lib/sms";
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
 *   LONG_SHIFT_HOURS (12): the person whose clock it is is asked (push and bell, and a text when
 *     the org can text: lib/sms-readiness) while he still remembers when he stopped, and the
 *     office's phones buzz. The push is the primary; the text reaches a phone whose app is not
 *     signed in or has pushes off. The text rides the org's "Text timeclock reminders" box
 *     (Settings, Scheduling). Until texting is set up, or with that box unticked, the text is
 *     skipped and counted.
 *     Pushes and texts never go out between 9 PM and 6 AM org-local; the 6 AM run does them. Brian's 1:37 PM clock-in puts the office's line on the
 *     bell at 11:37 PM, reaches twelve hours at 1:37 AM inside the hold, and is asked at 6:00 AM,
 *     16.4 hours in and still under the 18-hour ceiling his own picker allows.
 *
 * It never closes anything. A clock stops only at a time a person states (payroll does not invent
 * hours, and nothing here observed when the work ended).
 *
 * CLAIM FIRST, PER STEP. Each step has its own column (0291): long_shift_warned_at for the bell
 * line, long_shift_nudged_at for the question and the buzz. It is set with a guarded UPDATE before
 * anything is sent, and a zero-row claim is skipped, so two overlapping runs never tell anybody
 * twice, and the 10-hour line can never stand in for the 12-hour question. The office's list is
 * read BEFORE a claim (a failed lookup throws and spends nothing), and a bell line the database
 * refused gives its claim back, so the next hour tries again instead of the office never hearing.
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

  const counts = {
    orgs: 0,
    held: 0,
    bells_due: 0,
    nudges_due: 0,
    office_bells: 0,
    asked: 0,
    texted: 0,
    text_not_ready: 0,
    text_off: 0,
    office_buzzes: 0,
    failed: 0,
  };
  const { data: orgs, error: orgErr } = await supabase.from("organizations").select("id, name, settings");
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
          "id, profile_id, clock_in, long_shift_warned_at, long_shift_nudged_at, job:job_id(job_number, name), profiles:profile_id(full_name, role, active, phone)",
        )
        .eq("org_id", org.id)
        .eq("status", "open")
        .or("long_shift_warned_at.is.null,long_shift_nudged_at.is.null");
      if (error) throw error;

      type Person = { full_name?: string | null; role?: string | null; active?: boolean | null; phone?: string | null };
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

      // Throws on a failed lookup (never "nobody"), and is asked before any claim is spent.
      let staffIds: string[] | null = null;
      const office = async () => (staffIds ??= await orgStaffIdsOrThrow(org.id));
      const stamp = new Date(nowMs).toISOString();
      let texting: ReturnType<typeof smsReadiness> | undefined;

      /** The guarded claim: true only when THIS run set the column. */
      const claim = async (id: string, column: "long_shift_warned_at" | "long_shift_nudged_at") => {
        const { data: claimed, error: claimErr } = await supabase
          .from("time_entries")
          .update({ [column]: stamp })
          .eq("id", id)
          .eq("org_id", org.id)
          .eq("status", "open")
          .is(column, null)
          .select("id");
        if (claimErr) throw claimErr;
        return !!claimed?.length; // zero rows: another run took it, or the clock stopped meanwhile
      };
      /** Give back a claim THIS run took and could not deliver on, so the next run retries it. */
      const release = async (id: string, column: "long_shift_warned_at" | "long_shift_nudged_at") => {
        const { error: relErr } = await supabase
          .from("time_entries")
          .update({ [column]: null })
          .eq("id", id)
          .eq("org_id", org.id)
          .eq(column, stamp)
          .select("id");
        if (relErr) reportError("cron-long-shift", relErr, { orgId: org.id, entryId: id, release: column });
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
        const f = facts(r);
        const to = f.crew ? await office() : [];
        if (!(await claim(r.id, "long_shift_warned_at"))) continue;
        if (!f.crew || !to.length) continue;
        // The tail promises the question only while it is still ahead, and says when it will
        // really come: at 12 hours, or in the morning when 12 hours falls in the night's hold. A
        // row already at 12 (the job was down, or it is 0291's first run) is asked in step two of
        // this same run or the 6 AM one, so its bell line promises nothing.
        const askAtMs = Date.parse(r.clock_in) + LONG_SHIFT_HOURS * 3_600_000;
        const tail =
          f.person?.active === false || !(askAtMs > nowMs)
            ? ""
            : quietHold(askAtMs, tz)
              ? ` ${f.first} is asked in the morning.`
              : ` At ${LONG_SHIFT_HOURS} hours ${f.first} is asked.`;
        const ok = await createNotifications(org.id, to, {
          type: "long_shift",
          title: `${f.first} Is Still On The Clock`,
          body:
            `Clocked in ${f.since}${f.label ? ` at ${f.label}` : ""}, ${f.hours} hours ago. ` +
            `If the shift is over, ${f.door} on Timecards.${tail}`,
          url: `/timecards?entry=${r.id}`,
        });
        if (!ok) {
          // Its only output is that line: nothing was told, so nothing is counted and the claim
          // goes back for the next hour (createNotifications has already reported why).
          await release(r.id, "long_shift_warned_at");
          counts.failed++;
          continue;
        }
        counts.office_bells++;
      }

      // ── STEP TWO: at LONG_SHIFT_HOURS the person is asked and the office buzzes (never at night). ──
      for (const r of nudge) {
        const f = facts(r);
        const to = f.crew ? await office() : [];
        if (!(await claim(r.id, "long_shift_nudged_at"))) continue;

        if (f.person?.active !== false) {
          const title = "Still On The Clock?";
          const body = `You've been clocked in${f.label ? ` at ${f.label}` : ""} since ${f.since}. Tap to set when you stopped.`;
          await sendPushToProfiles([r.profile_id], "clock_out", { title, body, url: "/timeclock" });
          // The push has gone, so the claim stays spent (giving it back would push twice); a bell
          // line the database refused is reported by createNotifications and counted here.
          if (!(await createNotifications(org.id, [r.profile_id], { type: "long_shift", title, body, url: "/timeclock" }))) {
            counts.failed++;
          }
          counts.asked++;
          // THE SAME QUESTION BY TEXT, when the org can text and he has a number. Readiness is
          // asked once per org (texting ready = the same answer for every row).
          const phone = (f.person?.phone ?? "").trim();
          if (phone && !getOrgSettings(org.settings).remind_timeclock) {
            // The owner's "Text timeclock reminders" box is off (Settings, Scheduling): this text
            // rides that box, so no text goes out without one he can see. The push above stands.
            counts.text_off++;
          } else if (phone) {
            if (!(texting ??= smsReadiness(org)).ready) {
              counts.text_not_ready++;
            } else {
              const who = ((org as { name?: string | null }).name ?? "").trim();
              const text =
                `${who ? `${who}: ` : ""}You've been clocked in${f.label ? ` at ${f.label}` : ""} since ${f.since}, ` +
                `more than ${LONG_SHIFT_HOURS} hours. Open Timeclock to set when you stopped.`;
              // A refusal or a dropped connection answers false (sendSms logs why). The catch is the
              // belt: nothing about a text may cost the office its buzz below.
              try {
                if (await sendSms(phone, text, getOrgSettings(org.settings).sms_from_number)) counts.texted++;
                else counts.failed++;
              } catch (e) {
                counts.failed++;
                reportError("cron-long-shift", e, { orgId: org.id, entryId: r.id, step: "text" });
              }
            }
          }
        }

        if (f.crew && to.length) {
          await sendPushToProfiles(to, "long_shift", {
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
