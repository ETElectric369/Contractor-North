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

export const dynamic = "force-dynamic";

// THE forward-looking time map. No tabs: ?view=day|week|month are zoom levels
// of the ONE calendar (default week), url-synced shallowly by the client. The
// old Appointments tab is gone — appointments live on the calendar itself
// (chips + the day drill's edit/quick actions). Map survives as a header icon
// (a where-map with zero time interactions), not a lit tab row.

const CAL_VIEWS = ["day", "week", "month"] as const;

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

  return <CalendarPanel />;
}
