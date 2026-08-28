import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { CalendarPanel } from "./calendar-panel";
import { MapPanel } from "./map-panel";
import { CrewBoardPanel } from "./crew-board-panel";
import { PlaceRail } from "./place-rail";
import { PlacementProvider } from "./placement-context";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import type { Placeable } from "@/lib/schedule/place-by-town";
import { KIND_FROM_APPT_TYPE } from "@/lib/schedule/work-shape";

export const dynamic = "force-dynamic";

// THE forward-looking time map. No tabs: ?view=day|week|month are zoom levels
// of the ONE calendar (default week), url-synced shallowly by the client. The
// old Appointments tab is gone — appointments live on the calendar itself
// (chips + the day drill's edit/quick actions). Map survives as a header icon
// (a where-map with zero time interactions), not a lit tab row.

const CAL_VIEWS = ["day", "week", "2weeks", "month"] as const;

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; new?: string }>;
}) {
  const sp = await searchParams;

  // Office-only surface: the calendar shows org-wide appointments + crew
  // schedules. Techs land here from no nav link, but guard direct URLs too —
  // RLS would otherwise hand them a confusing half-empty view. Send them to My Day.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !isStaffRole(me.role)) {
    redirect("/planner");
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? sp.date : undefined;

  // ── Inbound-link contracts ────────────────────────────────────────────────
  // The retired Appointments tab still has inbound links (push notifications,
  // voice, activity, old bookmarks): plain ?view=appointments folds into the
  // calendar; its &new=1 create-intent carries over as ?new=appointment.
  if (sp.view === "appointments") redirect(sp.new === "1" ? "/schedule?new=appointment" : "/schedule");
  // ?new=appointment (quick-add's door) → today's day drill with the create
  // modal auto-opened: the day view mounts the one create AppointmentButton,
  // and ?new=1 is the claim-guard param it answers. The date is pinned
  // EXPLICITLY (org-tz today) — a dateless day view keys off the client's
  // "today", and the server→client day correction would remount the button
  // and close the just-opened modal whenever the two clocks disagree.
  if (sp.new === "appointment" || (sp.new === "1" && (sp.view !== "day" || !date))) {
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    const tz = getOrgSettings((org as any)?.settings).timezone;
    redirect(`/schedule?view=day&date=${date ?? todayStrInTz(tz)}&new=1`);
  }

  // Map: demoted from a tab to the header's MapPin icon, but it keeps a real
  // URL so the icon is a plain link and Back works.
  if (sp.view === "map") {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="mb-3 flex items-center gap-1">
          <Link
            href="/schedule"
            className="inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <ChevronLeft className="h-4 w-4 shrink-0" /> Calendar
          </Link>
          <span className="text-sm font-semibold text-slate-900">Job map</span>
        </div>
        <MapPanel />
      </div>
    );
  }

  // "Everyone's Day" — the all-crew swimlane board (one lane per person for the day).
  if (sp.view === "crew") {
    return <CrewBoardPanel date={date} />;
  }

  // Unknown/legacy views (calendar, board, voice's view=calendar, …)
  // canonicalize to the default week — never a 404-shaped surprise.
  if (sp.view && !(CAL_VIEWS as readonly string[]).includes(sp.view)) {
    redirect(date ? `/schedule?date=${date}` : "/schedule");
  }

  /**
   * THE RAIL — everything waiting for a day, beside the calendar.
   *
   * Erik: "how do I put these on the schedule is the big denny". Nothing put the leads and the
   * calendar in one view; the old "To schedule" tray held only dateless JOBS and a lead had never
   * been in it. This absorbs that tray — he doesn't think of leads and jobs as two piles.
   *
   * RLS scopes both reads to his org. A lead counts as "waiting" when it is open and has no
   * inspection booked yet; a job when it is in flight with no date.
   */
  const [{ data: leadRows }, { data: dateless }, { data: undated }, { data: orgRow }] = await Promise.all([
    supabase
      .from("inquiries")
      .select("id, name, address, city, phone, email, message, notes, next_follow_up_at, work_kind, planned_minutes")
      .is("converted_at", null)
      .neq("status", "lost")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("jobs")
      .select("id, job_number, name, address, city, planned_minutes")
      .is("scheduled_start", null)
      .in("status", ACTIVE_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(200),
    // A booking with no time on it yet — proposed, or created without a date.
    supabase
      .from("appointments")
      .select("id, title, type, location, planned_minutes")
      .is("starts_at", null)
      .not("status", "in", "(cancelled,completed)")
      .order("created_at", { ascending: false })
      .limit(200),
    // WAS A SERIAL ROUND TRIP, buried inside a template literal below — one extra sequential hop
    // on every single schedule load, for one settings row. Erik: "the app froze for me a few
    // times". This page is the heaviest read in the app; it does not get to wait on a fourth
    // query it could have asked for at the same time as the other three.
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);

  /* ── A LEAD WITH A DAY ON IT IS NOT WAITING FOR A DAY ─────────────────────────────────────
     The comment above claims this list is leads with "no inspection booked yet". The query said
     no such thing — only converted_at IS NULL and status <> 'lost' — and booking from this very
     rail leaves converted_at NULL BY DESIGN (an inspected lead can still go on to be an estimate,
     leads/actions.ts). So a lead he had just placed reappeared here looking untouched.

     That is worse than cosmetic now that the tick IS the booking. He taps Thursday, the lead comes
     straight back on the board, and the natural read is either "it didn't take" or "I'll move it to
     Friday" — either way he ticks it again, and convertInquiry's inspection branch has no existence
     check, so that is a SECOND walk-through inserted, a second Google push, and two calendar chips
     with nobody able to say which one the customer was told about.

     /leads already carries exactly this cross-check — added when Erik reported the same thing
     ("the sarah cain lead was already converted to an inspection but still shows up as a new
     lead"). THE PROJECTION LAW: the bug was never a missing column, it was a select list. The
     booked ones are on the calendar four inches to the right, so this is a move, not a dead end. */
  const leadIds = ((leadRows ?? []) as { id: string }[]).map((r) => String(r.id));
  const { data: bookedRows } = leadIds.length
    ? await supabase
        .from("appointments")
        .select("inquiry_id")
        .in("inquiry_id", leadIds)
        // ANY booking, not just an inspection-typed one. 0231 lets a lead book as a JOB or a
        // service call, and a type filter would have left exactly those still sitting on the board
        // looking unscheduled — the same duplicate-visit hole, reopened by widening the vocabulary.
        // What matters is whether a day was chosen, never which word was chosen with it.
        .neq("status", "cancelled")
        .limit(500)
    : { data: [] as { inquiry_id: string | null }[] };
  const alreadyBooked = new Set(
    ((bookedRows ?? []) as { inquiry_id: string | null }[]).map((r) => String(r.inquiry_id)),
  );

  const today = todayStrInTz(getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone);
  const waiting: Placeable[] = [
    ...((leadRows ?? []) as Record<string, string | null>[])
      .filter((r) => !alreadyBooked.has(String(r.id)))
      .map((r) => ({
      id: String(r.id),
      kind: "lead" as const,
      name: String(r.name ?? "Lead"),
      address: r.address ?? null,
      city: r.city ?? null,
      phone: r.phone ?? null,
      email: r.email ?? null,
      note: r.message ?? r.notes ?? null,
      urgent: !!r.next_follow_up_at && String(r.next_follow_up_at) < today,
      // The kind and the size the office chose ON THE LEAD (0230) — the rail shows what they
      // said rather than deciding again.
      workKind: r.work_kind ?? null,
      planned_minutes: r.planned_minutes == null ? null : Number(r.planned_minutes),
      })),
    ...((dateless ?? []) as Record<string, string | null>[]).map((r) => ({
      id: String(r.id),
      kind: "job" as const,
      name: `${r.job_number ? `${r.job_number} · ` : ""}${r.name ?? "Job"}`,
      address: r.address ?? null,
      city: r.city ?? null,
      planned_minutes: r.planned_minutes == null ? null : Number(r.planned_minutes),
    })),
    // ── THE BOOKED-BUT-UNPLANNED WALK-THROUGHS. Erik: "we have to roll in the 'to be scheduled'
    //    stuff somehow for example i have a couple inspections that already link to the leads i
    //    inputted." An appointment with NO start is a decision already taken and a day not yet
    //    chosen — which is exactly what this rail is for. Without it they were invisible: not on
    //    the calendar (no date) and not in the rail (not a lead, not a dateless job).
    ...((undated ?? []) as Record<string, string | null>[]).map((r) => ({
      id: String(r.id),
      // ITS OWN KIND, because it is its own write. Calling it a lead ran an appointment id through
      // convertInquiry — the one thing on this board that was already agreed was the one thing that
      // could not be placed. It is dated via rescheduleAppointment instead.
      kind: "appointment" as const,
      name: String(r.title ?? "Site visit"),
      address: r.location ?? null,
      city: null,
      type: r.type ?? null,
      // Its saved kind, so the rail's dropdown shows what it IS rather than an empty "Kind?" beside
      // a badge already reading "Service call".
      workKind: r.type ? (KIND_FROM_APPT_TYPE[String(r.type)] ?? null) : null,
      planned_minutes: r.planned_minutes == null ? null : Number(r.planned_minutes),
    })),
  ];

  return (
    /* ONE PROVIDER OVER BOTH HALVES. Ticking work in the rail arms the calendar; tapping a day in
       the calendar places what the rail has ticked. They can only be one gesture if they share
       state, and this is the smallest client shell that both sit inside. */
    <PlacementProvider items={waiting} todayISO={today}>
      <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0">
        <aside className="lg:sticky lg:top-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">
            Waiting for a day <span className="font-normal text-slate-400">({waiting.length})</span>
          </h2>
          <PlaceRail items={waiting} />
        </aside>
        <div className="min-w-0">
          <CalendarPanel />
        </div>
      </div>
    </PlacementProvider>
  );
}
