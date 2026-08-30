import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { createNotifications } from "@/lib/notifications";
import { orgStaffIds, sendPushToProfiles } from "@/lib/push";
import { rateLimited } from "@/lib/rate-limit";

/**
 * THE BOOKING TELLS THE BOSS — the missing second half of the pick-a-time loop.
 *
 * choose_schedule_slot / choose_schedule_date run as pure SQL from the CUSTOMER's browser (anon
 * RPC), so no server code ever fired and the boss saw nothing: the visit just materialized on
 * the calendar whenever a page re-rendered. Erik: "the boss just gets a notification and its
 * already on the schedule." The pick page calls here (fire-and-forget) after its RPC succeeds;
 * this rings the in-app bell for every staff member and sends the "booked" web push.
 *
 * Trust model: the TOKEN is the capability — the same unguessable token that authorized the pick
 * itself. The server re-reads the proposal with the service client and speaks only when the DB
 * says a pick actually just happened (status confirmed, chosen minutes ago). boss_notified_at
 * (0238) is a compare-and-set latch: replays and double-fires can never ring the bell twice, and
 * a forged token matches nothing. Rate-limited like the other public doors.
 */
export async function POST(req: Request) {
  if (await rateLimited(`pick-confirmed:${req.headers.get("x-forwarded-for") ?? "anon"}`, 10, 60)) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }
  let token = "";
  try {
    token = String((await req.json())?.token ?? "");
  } catch {
    /* fall through to the guard */
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return NextResponse.json({ ok: false }, { status: 400 });

  const sb = createServiceClient();
  const { data: prop } = await sb
    .from("schedule_proposals")
    .select("id, org_id, status, chosen_date, chosen_at, appointment_id, job_id, boss_notified_at")
    .eq("token", token)
    .maybeSingle();
  if (!prop || prop.status !== "confirmed" || prop.boss_notified_at) return NextResponse.json({ ok: true });
  // Only a pick that JUST happened — an old confirmed proposal resurfacing must stay silent.
  if (!prop.chosen_at || Date.now() - new Date(prop.chosen_at).getTime() > 15 * 60_000) {
    return NextResponse.json({ ok: true });
  }

  // The latch: exactly one caller wins the null → now transition (SILENT-WRITE LAW: row-checked).
  const { data: won } = await sb
    .from("schedule_proposals")
    .update({ boss_notified_at: new Date().toISOString() })
    .eq("id", prop.id)
    .is("boss_notified_at", null)
    .select("id");
  if (!won?.length) return NextResponse.json({ ok: true });

  // Name the work: the visit's title or the job's name — whichever this proposal carried.
  let what = "A customer";
  let url = "/schedule";
  if (prop.appointment_id) {
    const { data: a } = await sb.from("appointments").select("title").eq("id", prop.appointment_id).maybeSingle();
    if (a?.title) what = a.title;
    url = `/appointments/${prop.appointment_id}`;
  } else if (prop.job_id) {
    const { data: j } = await sb.from("jobs").select("name, job_number").eq("id", prop.job_id).maybeSingle();
    if (j) what = (j as { name?: string | null; job_number?: string | null }).name ?? (j as { job_number?: string | null }).job_number ?? what;
    url = `/jobs/${prop.job_id}`;
  }
  const day = prop.chosen_date
    ? new Date(`${prop.chosen_date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })
    : "a day";

  const staff = await orgStaffIds(prop.org_id);
  const title = "They picked a time";
  const body = `${what} — booked ${day}. It's on the schedule.`;
  await createNotifications(prop.org_id, staff, { type: "job_scheduled", title, body, url });
  await sendPushToProfiles(staff, "booked", { title, body, url });
  return NextResponse.json({ ok: true });
}
