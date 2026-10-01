import Link from "next/link";
import { splitAgenda } from "@/lib/agenda-split";
import { isInspectionType, appointmentTypeLabel } from "@/lib/statuses";
import { isStaffRole } from "@/lib/actions/perms";
import { redirect } from "next/navigation";
import { CalendarCheck, ChevronLeft, ChevronRight, ClipboardList, Navigation, MessageSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { RefreshOnVisible } from "@/components/refresh-on-visible";
import { WeatherWidget } from "@/components/weather-widget";
import { NowCard } from "./now-card";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { formatTime, formatCityStateZip, formatFullAddress, formatDate, formatDuration } from "@/lib/utils";
import { directionsTarget } from "@/lib/maps";
import { getOrgSettings } from "@/lib/org-settings";
import { NavLink } from "@/components/nav-link";
import { toJobOptions, toCustomerOptions, toStaffOptions, listActiveTechs, listCustomerOptions, jobLabel } from "@/lib/schedule-options";
import { todayBoundsInTz, prettyDay, tzDayStartUtc, todayStrInTz } from "@/lib/tz";
import { YourList } from "./your-list";
import { RANK_POOL_SELECT, rankPoolQuery, rankSix } from "@/lib/six-rank";
import { getActionItems } from "@/lib/action-items/query";
import { ActionList } from "@/components/action-items/action-list";
import { WaitingFold } from "@/components/action-items/waiting-fold";
import { smsReadiness } from "@/lib/sms";
import { SupplierPaperDoneTrail, SUPPLIER_PAPERS_SCOPE } from "@/components/supplier-paper-cards";
import type { ApptValue } from "../appointments/appointment-button";
import { AgendaRowMenu } from "./agenda-move";
import { NowTasks } from "./now-tasks";
import { QuickCostButton } from "@/components/quick-cost-button";
import { MarkReportReviewedButton } from "./mark-report-reviewed-button";
import type { DailyReportSummary } from "../timeclock/actions";
import { loadShiftChains } from "@/lib/shift-chain";
import { reportError } from "@/lib/observe";
import { featureOn, offFeatureKey } from "@/lib/features";
import { FeatureOffLine } from "@/components/feature-off-line";
import { buyMaterials } from "@/lib/materials-checklist";
import { workDayWindowHm } from "@/lib/org-settings";
import { tzDateTimeUtc } from "@/lib/tz";
import { hmWords, jobDayBlock, workDayMinutes } from "@/lib/schedule/job-block";
import { minutesToHm } from "@/lib/schedule/fit-day";
import { crewChips, dayRowsByDay, placeLine, streetOf, townOf, visitPlace, type CrewChip, type CrewDayRow } from "@/lib/schedule/block-info";
import { jobWords } from "@/lib/action-items/words";
import { ownHoursByJobDay, segmentCols, withDayHours, type SegmentRow } from "@/lib/schedule/segment-hours";
import type { DayHours } from "@/lib/schedule-math";
import { CrewInitials } from "@/components/crew-initials";

export const dynamic = "force-dynamic";

/** A job as an agenda row reads it: its block (start, end, size), its crew, where it is. */
const AGENDA_JOB_COLS = "id, job_number, name, status, address, city, scheduled_start, scheduled_end, planned_minutes, assigned_to";

export default async function PlannerPage({ searchParams }: { searchParams: Promise<{ view?: string; week?: string }> }) {
  const { view: viewRaw, week: weekRaw } = await searchParams;
  const view = viewRaw === "week" ? "week" : "day";
  // Tech week paging (?week= signed offset from this week). Staff never render
  // a week here — they're redirected to THE week at /schedule below.
  const weekOffset = Math.max(-52, Math.min(52, parseInt(weekRaw ?? "0", 10) || 0));
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // "Today" must be the business's local day, not the server's UTC day —
  // otherwise afternoon work in the Americas falls into "tomorrow".
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("id, city, state, zip, settings")
    .limit(1)
    .maybeSingle();
  const tz = getOrgSettings((orgRow as any)?.settings).timezone || "America/Los_Angeles";
  const { dayStart, dayEnd, todayStr } = todayBoundsInTz(tz);
  // THE SWITCH BOARD (0352): a switched-off feature's cards leave My Day (the Daily Reports card
  // once nothing is left to review). No stored map = everything on = My Day as it was.
  // Leads have no card of their own here: a new request is a Needs You row, and the Sales tile's
  // badge counts the new, uncontacted ones. leadsOn stays because Needs You's rows hear it.
  const features = getOrgSettings((orgRow as any)?.settings).features;
  const leadsOn = featureOn(features, "leads");

  // ONE parallel batch for everything that only needs the tz + the user id — was three sequential
  // rounds (day data → current job + week total → form/snapshot options). Latency audit 2026-06-27.
  // (The DayClock's today/pay-week hour queries left with it — /timeclock owns those now.)
  const [
    { data: jobs }, { data: segJobs }, { data: appts }, { data: openRows },
    { data: customers }, { data: staff }, { data: jobOptRows }, { data: me }, { data: todayCrewRows },
    { data: everyone },
  ] = await Promise.all([
    // The block's end, its size and its crew and town ride along: every agenda row says where, when
    // (start to end) and who (lib/schedule/block-info), for the crew as for the office. No money.
    supabase.from("jobs").select(`${AGENDA_JOB_COLS}, customers(name, phone)`).gte("scheduled_start", dayStart.toISOString()).lt("scheduled_start", dayEnd.toISOString()).order("scheduled_start"),
    // Multi-range jobs whose segment covers today, with today's own hours (0370; without them before).
    withDayHours((h) =>
      supabase
        .from("job_schedule_segments")
        .select(`${segmentCols("job_id, start_date, end_date", h)}, jobs(${AGENDA_JOB_COLS}, customers(name, phone))`)
        .lte("start_date", todayStr)
        .gte("end_date", todayStr),
    ),
    supabase.from("appointments").select("id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to, jobs(address), customers(name, phone), inquiries(phone), profiles!appointments_assigned_to_fkey(full_name)").gte("starts_at", dayStart.toISOString()).lt("starts_at", dayEnd.toISOString()).not("status", "in", "(cancelled,completed)").eq("absorbed", false).order("starts_at"),
    // The open entry, regardless of when it started (overnight shift, etc.). The job
    // on THIS entry is the Now card's job — scoped to the caller, not the org's latest
    // in_progress job (which could be a coworker's site across town).
    // notes rides along so the My Day one-tap clock-out can round-trip a mid-shift note.
    supabase.from("time_entries").select("id, profile_id, job_id, clock_in, clock_out, lunch_minutes, status, notes, split_from").eq("profile_id", user?.id ?? "").eq("status", "open").order("clock_in", { ascending: false }).limit(1),
    // Options for the inline add/edit controls + the owner snapshot.
    listCustomerOptions(supabase),
    listActiveTechs(supabase),
    // status rides along for the Tasks & Reminders Add line: its job chip offers only jobs still being worked.
    supabase.from("jobs").select("id, job_number, name, address, status").order("created_at", { ascending: false }).limit(200),
    // full_name rides along for the setup card — it's the first thing it asks and the first thing
    // that would otherwise be asked again after it was already answered at signup.
    supabase.from("profiles").select("role, full_name").eq("id", user?.id ?? "").maybeSingle(),
    // (No leads read: the Open Leads card is gone. A new request reaches Needs You below through
    // its own feeder, and the Sales tile's badge counts the new, uncontacted ones.)
    // Everyone's Day's rows for today (both kinds): the day row wins on the rows' crew chips (someone
    // off today, or on another job today, is dimmed). Names only, for the crew as for the office.
    supabase.from("crew_day_assignments").select("profile_id, work_date, kind, job_id").eq("work_date", todayStr).limit(500),
    /* EVERYONE THE COMPANY EVER HAD (id, name only), so a job still assigned to someone who LEFT shows
       their name and "No Longer On The Team" instead of a "U" chip titled "Unnamed" — the schedule names
       them, and My Day has to say the same thing about the same job. Deactivating a member only flips
       profiles.active (settings/actions setMemberActive); nothing strips jobs.assigned_to, so the id
       stays on the job. Names only: no role, no rate, nothing a tech may not see. */
    supabase.from("profiles").select("id, full_name").limit(1000),
  ]);

  const openEntry = (openRows ?? [])[0] as any | undefined;
  const isStaff = isStaffRole((me as any)?.role ?? "");
  // THE SHIFT, NOT THE PIECE (audit v994 SW1): after a Switch Job the running entry began at the
  // switch; "Set When You Stopped" appears at twelve hours of the shift, as the server refuses.
  let openShiftStart: string | null = null;
  if (openEntry?.split_from) {
    try {
      openShiftStart = (await loadShiftChains(supabase as any, [openEntry], null)).get(openEntry.id)?.startIso ?? null;
    } catch (e) {
      reportError("planner-shift-chain", e);
    }
  }

  // THE week lives at /schedule for staff — My Day keeps a week only for techs,
  // who can't see /schedule (office-only). A role-gated single map ≠ duplication.
  if (view === "week" && isStaff) redirect("/schedule?view=week");

  // Merge scheduled-today jobs + segment-today jobs (dedup) for the agenda below. (The rank no longer
  // reads today's jobs: job tasks left this card in 0358, so the old "on site" rank is gone.)
  const jobMap = new Map<string, any>();
  for (const j of jobs ?? []) jobMap.set(j.id, { ...j, time: j.scheduled_start });
  for (const s of (segJobs ?? []) as any[]) {
    const j = s.jobs;
    if (j && !jobMap.has(j.id)) jobMap.set(j.id, { ...j, time: null });
  }
  /* TODAY'S BLOCK FOR EACH JOB, as the calendar draws it (lib/schedule/job-block jobDayBlock): its own
     hours today when the day keeps them (0370), else the job's usual hours. A day with its own hours
     is timed at them; otherwise the row keeps the time it always had (the job's start, or none for a
     day in the middle of a run). */
  const workDay = workDayWindowHm((orgRow as any)?.settings);
  const wd = workDayMinutes(workDay);
  const ownToday = ownHoursByJobDay(((segJobs ?? []) as unknown as SegmentRow[]));
  const todayJobs = [...jobMap.values()].map((j: any) => {
    const own = ownToday.get(j.id)?.get(todayStr) ?? null;
    return { ...j, time: own ? tzDateTimeUtc(todayStr, own.start, tz) : j.time };
  });

  const uid = user?.id ?? "";
  // MY REMINDERS (0358): a task with no job, that is for me, or that I made for nobody else. The
  // same cut for every role now (a tech's own "remind me" lands in his six, not only what the office
  // assigned him), and job tasks never ride it: they are the JOB's list, worked from the job and from
  // the Now card above, never a person's six (Erik, 2026-09-26: My Day is "stockpiled with things i
  // cant act on"). 0358's RLS makes a Reminder private to its maker and its person; this cut says the
  // same on a database without it.
  const mineCut = <T,>(q: T): T =>
    (q as any).is("job_id", null).or(`assigned_to.eq.${uid},and(created_by.eq.${uid},assigned_to.is.null)`) as T;
  // THE POOL CUT LIVES IN ONE PLACE NOW (lib/six-rank rankPoolQuery): the arms, the order the bound
  // has to cut in, and the bound itself. It used to be written here as `focus_date.eq.<today>`, which
  // is why a pin vanished overnight — the row stopped matching and was never fetched again (Erik,
  // 2026-09-30: "the tasks keep disappearing even the pinned ones").
  const headCount = () => supabase.from("tasks").select("id", { count: "exact", head: true });

  // The reads that depend on a result above — the caller's current job (the job on
  // their OWN open time entry, so the Now card is their site, not a coworker's),
  // the ranked Reminders pool, and the head-counts that feed Tasks & Reminders — run together in
  // one final round. (The money-pipeline fetch left with the Money line — the AR
  // page owns that view now; the office/else DOOR links left too, so the only
  // count consumers below are the Tasks & Reminders card's Grab-One gate + its progress marks,
  // which count the DAY's own total, not a six.)
  //
  // The daily-report window: 14 ORG-local days back from today (lib/tz, never the
  // UTC server's day — a Pacific evening debrief must not fall out of the window a
  // day early).
  const reportsSince = todayStrInTz(tz, new Date(Date.now() - 14 * 86_400_000));
  // (An open punch with NO job reads no job list here: the Now card's Pick The Job opens the
  // clock's own "Which Job Are You On?" sheet, which loads its list when it opens: the job he
  // punched last, today's schedule, the jobs in progress. One list at every door.)
  const [curJobRes, poolR, restCountR, doneTodayR, dailyReportsR] = await Promise.all([
    openEntry?.job_id
      ? supabase.from("jobs").select("id, job_number, name, status, address, customers(name, address, city, state, zip)").eq("id", openEntry.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
    // TASKS & REMINDERS pool — my open TOP-LEVEL Reminders a rank can claim (subtasks nest
    // under their parent and never count; children fetch below). The cut, the order and the bound
    // are THE shared rule (lib/six-rank), so the card and the morning push read the same rows.
    rankPoolQuery(
      mineCut(
        supabase
          .from("tasks")
          .select(RANK_POOL_SELECT)
          .eq("status", "open")
          .is("parent_id", null),
      ),
      { todayStr, scope: "my_day" },
    ),
    // MY OPEN REMINDERS, all of them (top-level): what's behind the six feeds the card's Grab One
    // and All Reminders links. The ones FOR ME: /tasks also lists the Reminders I made for someone
    // else (theirs to do, never in my six), so the link says "More For You", not a /tasks count.
    mineCut(headCount().eq("status", "open").is("parent_id", null)),
    // My Reminders completed today — the durable half of the card's six marks.
    mineCut(
      headCount()
        .eq("status", "done")
        .is("parent_id", null)
        .gte("completed_at", dayStart.toISOString())
        .lt("completed_at", dayEnd.toISOString()),
    ),
    // Crew-lead daily reports (staff only) — the clock-out debriefs Nort filed, and
    // the surface the daily_report bell/push (url "/planner") lands on. Last 14
    // ORG-LOCAL days, newest first: this card used to show TODAY only and sent the
    // office to /timecards for the rest, but the review list moved here (cn-v958),
    // so yesterday's report has to be reachable on this page or the link is a dead
    // end. PROJECTION: gps_summary + status ride along because the card classifies
    // on them (the day story, and the filed→reviewed check-off). Fails soft (empty)
    // until migration 0128 lands.
    isStaff
      ? supabase
          .from("daily_reports")
          .select("id, profile_id, report_date, did_today, materials_tomorrow, gps_summary, status, created_at, profiles:profile_id(full_name)")
          .gte("report_date", reportsSince)
          .order("report_date", { ascending: false })
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const dailyReports = (((dailyReportsR as any)?.data ?? []) as any[]).map((r) => ({
    id: r.id as string,
    report_date: r.report_date as string,
    did_today: (r.did_today ?? null) as string | null,
    materials_tomorrow: (r.materials_tomorrow ?? null) as string | null,
    gps: (r.gps_summary ?? null) as DailyReportSummary | null,
    status: (r.status ?? "filed") as string,
    name: (r.profiles?.full_name ?? "Crew member") as string,
  }));
  const reportsToReview = dailyReports.filter((r) => r.status !== "reviewed").length;
  const reportsOn = featureOn(features, "daily_reports");
  const isOwner = (me as any)?.role === "owner";
  const currentJob = ((curJobRes as any)?.data as any) ?? undefined;
  // Navigate target for the Now card: structured address → customer address → job
  // name (so the button never vanishes when the address lives in the name). Same rule
  // the job dock uses (directionsTarget).
  const currentNavTarget = currentJob
    ? directionsTarget(
        currentJob.address,
        formatFullAddress(currentJob.customers?.address, currentJob.customers?.city, currentJob.customers?.state, currentJob.customers?.zip),
        currentJob.name,
      )
    : "";
  const sixPool = ((poolR as any)?.data ?? []) as any[];
  // THE shared rank (lib/six-rank — the same function behind the morning digest, so the phone and
  // the card can never disagree). NO DISPLAY CAP: every open Reminder a rank claims is drawn (Erik's
  // own call, 2026-09-30: "lets not limit it and call it something more clear like Tasks &
  // Reminders"). focus_date crosses into the card as-is; the card asks lib/six-rank whether it is a
  // pin and whether it carried, so that rule has exactly one home.
  const six = rankSix(sixPool, { todayStr });
  // NOTHING SILENT ABOUT THE BOUND. The fetch is still capped (MY_DAY_POOL_LIMIT) so a company with
  // thousands of open Reminders doesn't pull them all, and the order (lib/six-rank RANK_POOL_ORDER)
  // puts both every pin AND the freshest deadline out of the cut's reach: it takes from the oldest end
  // of a backlog, never from today. What the cut DID leave behind is never hidden: restCount below is
  // an independent head count of ALL my open Reminders minus the ones drawn, so the card's
  // "All Reminders · N More For You" line tells the truth whether N is a backlog, a day next month,
  // or the bound.

  // The current job's materials and its open tasks (need its id), the Needs You inbox (needs
  // the role), and the six's subtasks (need the chosen six) — one final round.
  const [mlRes, needsYou, kidsRes, nowTasksRes] = await Promise.all([
    // NEWEST by created_at — the same pick the job tab and ensureJobMaterialList make, so the
    // Materials button below lands on the ONE list the crew and the office both call "the"
    // list. order("id") sorted UUIDs: arbitrary, and on a two-list job a different list from
    // the one the job page shows (Erik: "just one, the same one"). Its lines' two checklist columns
    // ride along (no money: purchased and is_tool) for the Now card's live Buy Materials row.
    currentJob
      ? supabase
          .from("material_lists")
          .select("id, name, material_list_items(purchased, is_tool)")
          .eq("job_id", currentJob.id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // audit v921: the feeder's day cuts are calendar-day decisions — hand it the ORG tz so
    // "before today" means org midnight, not UTC's (a 5:30 PM visit surfaced a day late).
    // `off`: the same plain string the app shell's badge passes, so both share one fan-out.
    // TWO LISTS, ONE BUILD (Wave 1, NY-list): Now (the card, and the badge) and Waiting (the fold).
    getActionItems({ todayStr, isStaff, userId: user?.id ?? "", tz, off: offFeatureKey(features) }),
    six.length
      ? supabase
          .from("tasks")
          .select("id, title, status, parent_id")
          .in("parent_id", six.map((t) => t.id))
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as any[] }),
    // THE CLOCKED-IN JOB'S TASKS for the Now card (0358): how many are left and the next three,
    // in the list's order. Off the clock (no currentJob) there is nothing to read. A head count and
    // three rows, one query; a lost read shows no Tasks line rather than a wrong "0 left".
    currentJob
      ? supabase
          .from("tasks")
          .select("id, title", { count: "exact" })
          .eq("job_id", currentJob.id)
          .eq("status", "open")
          .order("created_at", { ascending: true })
          .limit(3)
      : Promise.resolve({ data: [] as any[], count: 0, error: null }),
  ]);
  const currentMaterials: { id: string; name: string; material_list_items?: { purchased?: boolean; is_tool?: boolean }[] } | null =
    ((mlRes as any)?.data as any) ?? null;
  const sixKids = ((kidsRes as any)?.data ?? []) as any[];
  // THE JOB'S MATERIALS, AS ONE TASK (lib/materials-checklist): "Buy Materials · N Open" leads the
  // Now card while anything on the list is left to buy, and counts as one of the tasks left. It opens
  // the same list the Materials button does.
  const nowBuy = buyMaterials(currentMaterials?.material_list_items ?? []);
  const currentMaterialsHref = currentMaterials
    ? `/materials/${currentMaterials.id}`
    : currentJob
      ? `/jobs/${currentJob.id}?tab=materials`
      : "/materials";
  const nowBuyOpen = nowBuy && nowBuy.open > 0 ? nowBuy.open : 0;
  const nowTasks = (nowTasksRes as any)?.error
    ? null
    : {
        left: (((nowTasksRes as any)?.count as number | null) ?? 0) + (nowBuyOpen > 0 ? 1 : 0),
        next: (((nowTasksRes as any)?.data ?? []) as { id: string; title: string }[]).map((t) => ({ id: t.id, title: t.title })),
      };

  // ── derived (no awaits) ──
  // Reminders behind the six, honest by subtraction: whatever the six show isn't "more". Gates the
  // card's Grab One (when the six are empty) and All Reminders (when there are more) links.
  const restCount = Math.max(0, ((((restCountR as any)?.count as number | null) ?? 0) - six.length));
  const doneToday = (((doneTodayR as any)?.count as number | null) ?? 0);
  // The Add line's job chip: the jobs the crew works right now, the one on the clock first.
  const addJobs = (() => {
    const active = ((jobOptRows ?? []) as any[]).filter((j) => !["complete", "invoiced", "cancelled"].includes(String(j.status ?? "")));
    const first = currentJob ? active.filter((j) => j.id === currentJob.id) : [];
    return [...first, ...active.filter((j) => j.id !== currentJob?.id)].map((j) => ({
      id: String(j.id),
      label: jobLabel(j),
      number: (j.job_number as string | null) ?? null,
    }));
  })();

  const org = orgRow;
  const orgLocation = formatCityStateZip((org as any)?.city, (org as any)?.state, (org as any)?.zip) || null;
  // Simple, deep, spiritual — timeless wisdom (public-domain sources + universal proverbs),
  // grounding for a crew starting the day. Rotated by day-of-YEAR so it advances every day
  // instead of repeating on the same date each month.
  const QUOTES = [
    "Be still, and know.",
    "This too shall pass.",
    "Wherever you are, be all there.",
    "The quieter you become, the more you can hear.",
    "What you seek is seeking you. —Rumi",
    "Nature does not hurry, yet everything is accomplished. —Lao Tzu",
    "The wound is the place where the light enters you. —Rumi",
    "Peace comes from within; do not seek it without. —Buddha",
    "Fall seven times, stand up eight.",
    "A journey of a thousand miles begins with a single step. —Lao Tzu",
    "Silence is a source of great strength. —Lao Tzu",
    "Do your work, then step back. —Tao Te Ching",
    "Water is soft, yet it wears away stone.",
    "Let go, or be dragged.",
    "Empty your cup, and it can be filled.",
    "Gratitude turns what we have into enough.",
    "When the student is ready, the teacher appears.",
    "Still waters run deep.",
    "As you think, so you become.",
    "The mountain is climbed one step at a time.",
    "Where there is love, there is life. —Gandhi",
    "Tend your own garden.",
    "Kindness is a language the blind can see and the deaf can hear.",
    "Rest is part of the work, not a break from it.",
    "Trust the timing of your life.",
    "The light you are looking for is within you.",
    "Do everything with a mind that lets go. —Ajahn Chah",
    "What we give, we grow.",
    "The obstacle is the way. —Marcus Aurelius",
    "Be like water: patient, yielding, unstoppable.",
    "Slow is smooth, and smooth is fast.",
    "Every morning we are born again; what we do today matters most.",
    "Presence is the greatest gift you bring to your work.",
    "Do good, and good comes back around.",
  ];
  const _qNow = Date.parse(`${todayStr}T12:00:00Z`);
  const _qYearStart = Date.parse(`${todayStr.slice(0, 4)}-01-01T12:00:00Z`);
  const dayOfYear = Math.max(0, Math.round((_qNow - _qYearStart) / 86_400_000));
  const dailyQuote = QUOTES[dayOfYear % QUOTES.length];
  const jobOpts = toJobOptions(jobOptRows);
  const custOpts = toCustomerOptions(customers);
  const staffOpts = toStaffOptions(staff);
  const people = (staff ?? []).map((s: any) => ({ id: s.id, full_name: s.full_name }));
  /** Everyone the company ever had, for a chip whose person has left ("No Longer On The Team"). */
  const everPeople = ((everyone ?? []) as any[]).map((p) => ({ id: p.id, full_name: p.full_name }));
  /* EACH DAY'S CREW ROWS (Everyone's Day), by day: today's now, the week's in the week view below. The
     day row wins on that day's chips (lib/schedule/block-info crewChips). */
  const crewRowsByDay: Record<string, CrewDayRow[]> = dayRowsByDay((todayCrewRows ?? []) as unknown as CrewDayRow[]);
  /** Job words by id, for a chip whose person is on another job that day ("On 12 Elm St · J-048 That Day"). */
  const jobNames = new Map<string, string>(((jobOptRows ?? []) as any[]).map((j) => [String(j.id), jobWords(j)]));

  /** A job's row on `day`: where (the street, or who when the name is the street; the town small),
   *  that day's block start to end as the calendar draws it (its own hours when it keeps them), and the
   *  crew as initials. The same words the job's block on the schedule says (lib/schedule/block-info). */
  const jobRowInfo = (j: any, day: string, own: DayHours | null) => {
    const b = jobDayBlock({
      day,
      scheduledStart: j.scheduled_start ?? null,
      scheduledEnd: j.scheduled_end ?? null,
      plannedMinutes: j.planned_minutes ?? null,
      tz,
      wd,
      dayHours: own,
    });
    return {
      place: placeLine({ name: j.name, street: j.address, customer: j.customers?.name })?.text ?? null,
      town: (j.city as string | null) ?? null,
      span: b.allDay ? "All day" : `${hmWords(minutesToHm(b.startMin))} – ${hmWords(minutesToHm(b.endMin))}`,
      crew: crewChips(j.assigned_to, people, { rows: crewRowsByDay[day], jobId: j.id, jobNames, people: everPeople }),
    };
  };
  /** A visit's row: its street (its job's, with no place of its own), who, start to end (an hour when
   *  it has no end, the calendar's rule), and the one person going (a dashed Nobody). */
  const visitRowInfo = (a: any) => {
    const endsAt = a.ends_at && new Date(a.ends_at).getTime() > new Date(a.starts_at).getTime()
      ? a.ends_at
      : new Date(new Date(a.starts_at).getTime() + 3_600_000).toISOString();
    return {
      place: placeLine({ name: a.title, street: streetOf(visitPlace(a)), customer: a.customers?.name })?.text ?? null,
      town: townOf(visitPlace(a)) || null,
      span: `${formatTime(a.starts_at, tz)} – ${formatTime(endsAt, tz)}`,
      // The one person going; an 'off' row that day dims them (a visit reads only that kind).
      crew: a.assigned_to
        ? crewChips([a.assigned_to], [...people, { id: a.assigned_to, full_name: a.profiles?.full_name ?? null }], {
            rows: crewRowsByDay[todayStrInTz(tz, new Date(a.starts_at))],
            jobId: null,
            people: everPeople,
          })
        : [],
    };
  };

  const niceDay = prettyDay(todayStr);
  const empty = (label: string) => <p className="px-5 py-6 text-center text-sm text-slate-400">{label}</p>;

  // NEEDS YOU, WHOLE (Wave 1, NY-list): no five-row cut and no Show All. The same-kind piles keep it
  // short ("Estimates Not Sent · 6" is one row), and everything waiting sits in the Waiting fold.
  // The Send sheet's Text It hears the company's texting, read once here.
  const textReady = smsReadiness(orgRow as { name?: string | null; settings?: unknown } | null).ready;

  // ── Agenda (Earlier / Next / Later) ─────────────────────────────────────────
  // One chronological stream of WHERE YOU'LL BE — timed jobs + appointments,
  // nothing else. Tasks live in Tasks & Reminders above (doctrine law 2: a due-today task
  // rendering as slot AND agenda row would be a double map). The job you're ON is
  // the Now card at the top; the rest groups into Earlier, Next (soonest) and Later.
  type Agenda = {
    key: string;
    kind: "job" | "appt";
    time: string | null;
    title: string;
    sub: string | null;
    address: string | null;
    href: string;
    status?: string;
    apptType?: string;
    // The row's ⋯ (staff, day view AND week view): a visit's record powers Mark Done, Move and Edit
    // Details; a job carries just what its move contract needs (its id; the row's day is handed to
    // agendaRows). The week view's visits carry no record, so they get no ⋯.
    appt?: ApptValue;
    jobId?: string;
    /** The person waiting — powers the running-late one-tap text on the NEXT visit. */
    phone?: string | null;
    /** WHERE AND WHO (lib/schedule/block-info), the same words the job's block on the calendar says:
     *  the street (or who, when the name is the street), the town small, start to end, the crew. */
    place?: string | null;
    town?: string | null;
    span?: string | null;
    crew?: CrewChip[] | null;
  };
  const agenda: Agenda[] = [
    ...todayJobs
      .filter((j: any) => j.id !== currentJob?.id)
      .map((j: any) => ({
        key: `j-${j.id}`,
        kind: "job" as const,
        time: j.time,
        title: jobLabel(j),
        sub: [j.customers?.name, j.address].filter(Boolean).join(" · ") || null,
        address: directionsTarget(j.address, j.name) || null,
        href: `/jobs/${j.id}`,
        status: j.status,
        jobId: j.id as string,
        phone: j.customers?.phone ?? null,
        ...jobRowInfo(j, todayStr, ownToday.get(j.id)?.get(todayStr) ?? null),
      })),
    ...(appts ?? []).map((a: any) => ({
      key: `a-${a.id}`,
      kind: "appt" as const,
      time: a.starts_at,
      title: a.title,
      sub: a.location ?? null,
      ...visitRowInfo(a),
      // Fall back to the linked job's address so the Navigate button appears on a
      // job appointment that has no explicit location (bug: NAV missing on appts).
      address: a.location ?? a.jobs?.address ?? null,
      // ALWAYS the appointment. This used to fall back to the schedule grid when there was no
      // job — but a pre-sale inspection has no job by design (verified in prod: ET 1 of 8,
      // Tahoe Deck 0 of 20), so the fallback fired almost every time and tapping today's
      // inspection dumped you on the grid you were just looking at. /appointments/<id> is the
      // hub: capture, photos, the question sheet, navigate, start estimate.
      href: `/appointments/${a.id}`,
      apptType: a.type,
      // audit v921: carry the appointment's status so a PROPOSED (unconfirmed) visit reads as
      // tentative here too — the calendar day drill, the appointment page and /inspections all
      // badge it "pending pick"; My Day was the one surface drawing it as a firm booking.
      status: a.status,
      // A pre-sale visit's person lives on the LEAD; a sold one's on the customer card.
      phone: a.customers?.phone ?? a.inquiries?.phone ?? null,
      appt: {
        id: a.id,
        type: a.type,
        title: a.title,
        starts_at: a.starts_at,
        ends_at: a.ends_at ?? null,
        job_id: a.job_id ?? null,
        customer_id: a.customer_id ?? null,
        location: a.location ?? null,
        notes: a.notes ?? null,
        assigned_to: a.assigned_to ?? null,
      } satisfies ApptValue,
    })),
  ];
  // Earlier / Next / Later, decided by the clock — see lib/agenda-split.ts for why this
  // rule lives in a tested function and not in filters here.
  const {
    earlier: earlierAgenda,
    next: nextAgenda,
    later: laterAgenda,
  } = splitAgenda(agenda, new Date());

  /* RUNNING LATE? TEXT THEM — Andrew's co-pilot idea, the honest v1. When the NEXT visit is
     inside twenty minutes (or already started) and the person waiting has a phone, the row grows
     a one-tap prefilled text. No geolocation, no background tracking, nothing automatic — the
     app can't know traffic, but it CAN make the two-second courtesy text a single tap at a red
     light. "Communication is better than none." The ETA-aware version (am I far enough away to
     BE late?) needs address geocoding + background location — native-shell territory. */
  const lateNudge = (() => {
    const nx = nextAgenda[0] as Agenda | undefined;
    if (!nx?.phone || !nx.time) return null;
    // audit v921: never offer "on my way" to a customer who hasn't picked a time yet — a
    // proposed visit's starts_at is only the FIRST offered slot, not an agreed appointment.
    if (nx.kind === "appt" && nx.status === "proposed") return null;
    const mins = (new Date(nx.time).getTime() - Date.now()) / 60_000;
    return mins < 20 ? nx.key : null;
  })();

  // Week view (techs only — staff were redirected above): the agenda widened to a
  // week (Sun–Sat), grouped by day, paged via ?week=. Sunday-start is the DISPLAY
  // week; the pay-week hours above are Monday-start on purpose.
  const weekDayGroups: { dayStr: string; label: string; items: Agenda[] }[] = [];
  if (view === "week") {
    const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday (display week start)
    const viewWeekStart = new Date(`${todayStr}T00:00:00Z`);
    viewWeekStart.setUTCDate(viewWeekStart.getUTCDate() - dow + weekOffset * 7);
    // The 7 day strings (Sun–Sat) of the viewed week, in the org tz.
    const weekDayStrs: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(viewWeekStart);
      d.setUTCDate(d.getUTCDate() + i);
      weekDayStrs.push(d.toISOString().slice(0, 10));
    }
    const weekStartStr = weekDayStrs[0];
    const weekEndStr = weekDayStrs[6];
    const weekEndExcl = new Date(viewWeekStart);
    weekEndExcl.setUTCDate(weekEndExcl.getUTCDate() + 7);
    const weekStartUtc = tzDayStartUtc(weekStartStr, tz);
    const weekEndUtc = tzDayStartUtc(weekEndExcl.toISOString().slice(0, 10), tz);
    const [{ data: wJobs }, { data: wAppts }, { data: wSegs }, { data: wCrewRows }] = await Promise.all([
      supabase
        .from("jobs")
        .select(`${AGENDA_JOB_COLS}, customers(name)`)
        .gte("scheduled_start", weekStartUtc.toISOString())
        .lt("scheduled_start", weekEndUtc.toISOString())
        .order("scheduled_start"),
      supabase
        .from("appointments")
        .select("id, type, title, starts_at, ends_at, location, job_id, status, assigned_to, jobs(address), customers(name), profiles!appointments_assigned_to_fkey(full_name)")
        .gte("starts_at", weekStartUtc.toISOString())
        .lt("starts_at", weekEndUtc.toISOString())
        // audit v921 (+ review): the day view hides a COMPLETED visit because "today" is always
        // now. The week view pages BACKWARD (weekOffset -52..52), and a past week is nothing but
        // completed visits — hiding them emptied every previous week, while the sibling jobs query
        // (no status filter) still drew the job you finished. So: cancelled is never a booking,
        // but completed stays visible here.
        .neq("status", "cancelled")
        .eq("absorbed", false) // 0237: a booking absorbed into its job must not draw beside it
        .order("starts_at"),
      // Multi-range jobs whose segment overlaps this week — so a Mon–Thu job shows on
      // every covered day (the day view does this too; without it the week view put
      // such jobs on their start day only).
      // Each day's own hours ride along (0370; without them before the migration).
      withDayHours((h) =>
        supabase
          .from("job_schedule_segments")
          .select(`${segmentCols("job_id, start_date, end_date", h)}, jobs(${AGENDA_JOB_COLS}, customers(name))`)
          .lte("start_date", weekEndStr)
          .gte("end_date", weekStartStr),
      ),
      // The week's crew rows (Everyone's Day, both kinds), so each day's chips read that day.
      supabase
        .from("crew_day_assignments")
        .select("profile_id, work_date, kind, job_id")
        .gte("work_date", weekStartStr)
        .lte("work_date", weekEndStr)
        .limit(2000),
    ]);
    Object.assign(crewRowsByDay, dayRowsByDay((wCrewRows ?? []) as unknown as CrewDayRow[]));
    for (const j of (wJobs ?? []) as any[]) jobNames.set(String(j.id), jobWords(j));
    const ownWeek = ownHoursByJobDay((wSegs ?? []) as unknown as SegmentRow[]);
    const timedWeek: Agenda[] = [
      ...((wJobs ?? []) as any[]).map((j) => ({
        key: `wj-${j.id}`,
        kind: "job" as const,
        jobId: j.id,
        time: j.scheduled_start,
        title: jobLabel(j),
        sub: [j.customers?.name, j.address].filter(Boolean).join(" · ") || null,
        address: directionsTarget(j.address, j.name) || null,
        href: `/jobs/${j.id}`,
        status: j.status,
        ...jobRowInfo(j, todayStrInTz(tz, new Date(j.scheduled_start)), null),
      })),
      ...((wAppts ?? []) as any[]).map((a) => ({
        key: `wa-${a.id}`,
        kind: "appt" as const,
        time: a.starts_at,
        title: a.title,
        sub: a.location ?? null,
        address: a.location ?? null,
        ...visitRowInfo(a),
        // ALWAYS the appointment. This used to fall back to the schedule grid when there was no
      // job — but a pre-sale inspection has no job by design (verified in prod: ET 1 of 8,
      // Tahoe Deck 0 of 20), so the fallback fired almost every time and tapping today's
      // inspection dumped you on the grid you were just looking at. /appointments/<id> is the
      // hub: capture, photos, the question sheet, navigate, start estimate.
      href: `/appointments/${a.id}`,
        apptType: a.type,
        // audit v921: same tentative marker as the day view — a proposed visit is not a booking.
        status: a.status,
      })),
    ]
      .filter((i) => i.time)
      .sort((a, b) => (a.time as string).localeCompare(b.time as string));
    const tzDayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
    // Segment-first dedup (mirrors calendar-view.byDay + the day view): a job that
    // has ANY segment rows is placed ONLY on its segment days for this week — its
    // scheduled_start-derived (timed) row is dropped so it can't double-list on a
    // different day, and can't collide with itself on the same day. Jobs with no
    // segments still place by scheduled_start as before. Keyed by JOB ID, not href.
    const segJobIds = new Set(((wSegs ?? []) as any[]).map((s) => s.jobs?.id).filter(Boolean));
    for (const dayStr of weekDayStrs) {
      const items: Agenda[] = timedWeek.filter(
        (it) => tzDayOf(it.time as string) === dayStr && !(it.kind === "job" && it.jobId && segJobIds.has(it.jobId)),
      );
      // Per-day set of job IDs already placed, so a job covered by two overlapping
      // segments (or a lingering timed row) appears exactly once per covered day.
      const placedJobIds = new Set<string>(
        items.filter((it) => it.kind === "job" && it.jobId).map((it) => it.jobId as string),
      );
      for (const s of (wSegs ?? []) as any[]) {
        const j = s.jobs;
        if (!j || s.start_date > dayStr || s.end_date < dayStr) continue;
        if (placedJobIds.has(j.id)) continue;
        placedJobIds.add(j.id);
        // That day's block (its own hours when it keeps them), and timed at them when it does.
        const own = ownWeek.get(j.id)?.get(dayStr) ?? null;
        items.push({
          key: `ws-${j.id}-${dayStr}`,
          kind: "job",
          jobId: j.id,
          time: own ? tzDateTimeUtc(dayStr, own.start, tz) : null,
          title: jobLabel(j),
          sub: [j.customers?.name, j.address].filter(Boolean).join(" · ") || null,
          address: directionsTarget(j.address, j.name) || null,
          href: `/jobs/${j.id}`,
          status: j.status,
          ...jobRowInfo(j, dayStr, own),
        });
      }
      weekDayGroups.push({ dayStr, label: prettyDay(dayStr), items });
    }
  }
  const weekOfLabel = weekDayGroups.length
    ? new Date(`${weekDayGroups[0].dayStr}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : "";

  const navBtnCls =
    "inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-brand/30 bg-brand-light/40 px-3 text-xs font-medium text-brand hover:bg-brand-light";
  // `day` is the ROW's own day (org tz): today in the day view, that day in the week view. A job's
  // Move moves the range that day sits in (moveJobDay's fromDate), so Thursday's row of a Mon-Tue +
  // Thu-Fri job moves Thu-Fri, never Mon-Tue.
  const fmtTime = (iso: string) => formatTime(iso, tz); // the company's clock, never the server's
  const agendaRows = (items: Agenda[], day: string) =>
    items.map((i) => (
      <li key={i.key} className="flex items-center gap-3 px-5 py-3">
        <div className="w-14 shrink-0 text-sm font-medium text-slate-700">{i.time ? fmtTime(i.time) : "—"}</div>
        {/* 44px to the thumb (py-1 over the row's own padding), the row's height unchanged. The
            title has its own line, so the verbs on the right can never squeeze it to nothing at
            375px; the kind badge sits with the where. Under it, the block's own words (the same the
            schedule's block says): start to end, and who's on it as initials. No money. */}
        <Link href={i.href} className="-my-1 min-w-0 flex-1 py-1 hover:opacity-80">
          <div className="truncate text-sm font-medium text-slate-900">{i.title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {i.kind === "appt" ? (
              <>
                <Badge tone={isInspectionType(i.apptType) ? "amber" : "blue"} className="shrink-0">
                  {appointmentTypeLabel(i.apptType)}
                </Badge>
                {/* audit v921: the same "pending pick" marker the calendar and the appointment
                    page carry — My Day drew an unconfirmed visit like a firm booking. */}
                {i.status === "proposed" && (
                  <Badge tone="amber" className="shrink-0">
                    pending pick
                  </Badge>
                )}
              </>
            ) : i.status ? (
              <Badge tone={statusTone(i.status)} className="shrink-0">
                {jobStatusLabel(i.status)}
              </Badge>
            ) : null}
            {/* WHERE: the street number and name (never the city or the zip), or who when the name
                already is the street; the town small. */}
            {i.place ? (
              <span className="min-w-0 truncate text-xs text-slate-500">{i.place}</span>
            ) : i.sub && !i.span ? (
              <span className="min-w-0 truncate text-xs text-slate-400">{i.sub}</span>
            ) : null}
            {i.town && <span className="shrink-0 text-[11px] text-slate-400">· {i.town}</span>}
          </div>
          {(i.span || i.crew) && (
            <div className="mt-1 flex min-w-0 items-center gap-2">
              {i.span && <span className="min-w-0 truncate text-xs tabular-nums text-slate-600">{i.span}</span>}
              {i.crew && <CrewInitials crew={i.crew} />}
            </div>
          )}
        </Link>
        {/* WRAP, don't cover. Andrew (mobile): "the Navigate field/button covers up the other
            items on the Today view." A shrink-0 no-wrap cluster of up to four 44px buttons ate the
            row's text at 375px. Wrapping keeps every verb reachable and the words readable; below
            sm the Navigate label drops to the icon so the common case never wraps at all. */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {i.key === lateNudge && i.phone && (
            <a
              href={`sms:${i.phone}&body=${encodeURIComponent("On my way — running a few minutes behind. See you soon.")}`}
              className={navBtnCls}
              title="Running late? Opens a heads-up text from this phone"
            >
              <MessageSquare className="h-4 w-4 shrink-0" /> <span className="hidden sm:inline">Running Late?</span>
            </a>
          )}
          {i.address && (
            <NavLink address={i.address} className={navBtnCls}>
              <Navigation className="h-4 w-4 shrink-0" /> <span className="hidden sm:inline">Navigate</span>
            </NavLink>
          )}
          {/* THE OFFICE'S VERBS, behind one 44px ⋯ (the app's one row sheet): a visit's Mark Done,
              Move To Another Day… and Edit Details… (the edit kills the old dead end, appt row →
              the job page's read-only tab); a job's Move To Another Day… only. MoveToDay is the ONE
              reschedule grammar app-wide. Techs keep plain rows, no ⋯: the actions are staff-gated
              server-side. A week-view visit carries no record, so it gets no ⋯. */}
          {isStaff && (i.appt || i.jobId) && (
            <AgendaRowMenu
              title={i.title}
              subline={[i.time ? fmtTime(i.time) : null, i.sub].filter(Boolean).join(" · ") || null}
              appt={i.appt}
              jobId={i.jobId}
              fromDate={day}
              tz={tz}
              jobs={jobOpts}
              customers={custOpts}
              staff={staffOpts}
            />
          )}
        </div>
      </li>
    ));

  return (
    <div className="mx-auto max-w-3xl">
      {/* Reopen the app / return to this tab → pull fresh schedule data (no manual reload). */}
      <RefreshOnVisible />
      {/* Header + weather (Erik-spec): the bigger weather widget fills the space to the RIGHT
          of the date at EVERY width (a plain flex row, not PageHeader's stack-on-mobile). The
          daily quote gets its OWN line, now ABOVE the clock (next comment), so it never
          truncates or crowds anything. */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">My Day</h1>
          <p className="mt-1 text-sm text-slate-500">{niceDay}</p>
        </div>
        <WeatherWidget
          compact
          location={orgLocation}
          label={(org as any)?.city ?? undefined}
          source={getOrgSettings((org as any)?.settings).weather_source}
        />
      </div>

      {/* THE QUOTE OF THE DAY, ABOVE THE CLOCK (Erik, 2026-09-30: "move the quote of the day up over
          time clock"). It used to sit under the Now card, where the first thing he read on opening the
          app was a timer. */}
      <p className="mb-4 text-sm italic text-slate-400">&ldquo;{dailyQuote}&rdquo;</p>

      {/* THE NOW CARD, full width, for every role: the clock, the job on the punch and its doors, in
          one card (it replaced the clock card, the Today card's Now block and the Which Job block).
          The Open Leads card that once sat beside the clock for staff is gone too: a lead is a Needs
          You row below, and the Sales tile's badge counts the new, uncontacted ones.
          The card is keyed to the OPEN PUNCH's job. A punch that carries none asks "Which job are you
          on?" with one Pick The Job door (the clock's own sheet), so the doors are never gone without
          a sentence (Erik 2026-09-11, "what happened to my materials button").
          Only the job's name, customer · address and its href cross into the client card; the doors
          below render here, on the server. */}
      <NowCard
        userId={user?.id ?? null}
        open={
          openEntry
            ? {
                id: openEntry.id,
                clock_in: openEntry.clock_in,
                notes: openEntry.notes ?? null,
                shift_start: openShiftStart,
                onJob: !!openEntry.job_id,
              }
            : null
        }
        job={
          currentJob
            ? {
                name: jobLabel(currentJob),
                sub: [currentJob.customers?.name, currentJob.address].filter(Boolean).join(" · ") || null,
                href: `/jobs/${currentJob.id}`,
              }
            : null
        }
      >
        {currentJob && (
          <>
            {/* THE JOB'S DOORS, each 44px: Navigate (only when there is somewhere to go), Materials
                (the job's one list) and, for the office, Add Cost. Add Cost is the office's —
                createBill is requireStaff — so a tech never fills a form that refuses on save (NO
                DEAD ENDS). Two columns for a tech, three for the office (two below ~360px). */}
            <div className={`mt-3 grid gap-2 text-sm font-medium ${isStaff ? "grid-cols-2 min-[360px]:grid-cols-3" : "grid-cols-2"}`}>
              {currentNavTarget && (
                <NavLink
                  address={currentNavTarget}
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[rgb(var(--glass-ink))] text-white shadow-sm hover:bg-[rgb(var(--glass-ink))]/90"
                >
                  <Navigation className="h-4 w-4 shrink-0" /> Navigate
                </NavLink>
              )}
              <Link
                href={currentMaterialsHref}
                className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              >
                Materials
              </Link>
              {/* snapFirst: on the clock, a cost is a bill in his hand, so the sheet opens on
                  Snap the Bill instead of a focused Supplier field. */}
              {isStaff && (
                <QuickCostButton
                  orgId={(org as any)?.id ?? ""}
                  jobId={currentJob.id}
                  snapFirst
                  nortOn={featureOn(features, "nort")}
                  className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                />
              )}
            </div>
            {/* THE JOB'S TASKS, while he's on it (0358): "Tasks: 3 left", the next three to check
                off right here, and All Tasks for the rest. Only on the clock, only this job;
                nothing when the list is done or empty. */}
            {nowTasks && nowTasks.left > 0 && (
              <NowTasks
                jobId={currentJob.id}
                left={nowTasks.left}
                next={nowTasks.next}
                materials={nowBuyOpen > 0 ? { open: nowBuyOpen, href: currentMaterialsHref } : null}
              />
            )}
          </>
        )}
      </NowCard>

      {/* The CrewBoard that sat here is GONE (Erik changed his mind, cn-v503):
          crew presence + hours live together on /timecards now — the "on the
          clock" strip above its week grid. My Day keeps the Now card + reports. */}

      {/* CREW-LEAD DAILY REPORTS (staff only) — THE debrief surface, moved here whole from
          /timecards (cn-v958). A debrief answers "what got done" and "WHAT MATERIALS DO WE NEED
          TOMORROW", and tomorrow is a My Day question; on a payroll-review page it was the
          biggest block standing between Erik and the money he opens that page for. It sits in
          slot 2, straight under the Now card: the debrief is the other end of the same shift, and
          it has to be read BEFORE today's agenda, not after it — the materials line is what
          changes the morning.
          The footer link to /timecards is gone with the move: this IS the review list now, so
          the 14-day window lives here and a daily_report bell/push (url "/planner") lands on
          the report it is about.
          KNOWN GAP, unchanged by the move (audit 2026-07-16): 0128's design says "filed for
          office EDITING" and the update RLS grants staff that write, but no UI anywhere edits a
          report's did_today/materials_tomorrow — this is read + check-off only. Build the edit
          affordance here if the office ever needs to correct a filed report. */}
      {/* DAILY REPORTS SWITCHED OFF (0352): the card stays while a filed report still waits to be
          reviewed (it is somebody's end-of-day, already sent), with the Off line on top; once
          they're all checked off it goes with the switch. */}
      {isStaff && dailyReports.length > 0 && (reportsOn || reportsToReview > 0) && (
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-slate-400" />
              <span className="text-sm font-semibold text-slate-800">Daily reports</span>
            </div>
            {/* NOTHING SILENT: the right-hand line says what is left to do AND what window
                this list covers, so "only three" is never mistaken for "only three exist". */}
            <span className="shrink-0 text-xs font-medium text-slate-500">
              {reportsToReview > 0 ? `${reportsToReview} to review · ` : ""}last 14 days
            </span>
          </div>
          <FeatureOffLine feature="daily_reports" features={features} isOwner={isOwner} className="mx-5 mt-3" />
          <ul className="divide-y divide-slate-100">
            {dailyReports.map((r) => {
              const reviewed = r.status === "reviewed";
              // The debrief itself — what got done, what to buy tomorrow, and the day story.
              const body = (
                <>
                  {r.did_today && (
                    <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{r.did_today}</p>
                  )}
                  {r.materials_tomorrow && (
                    <p className="mt-1 whitespace-pre-line text-sm text-amber-700">
                      <span className="font-medium">Materials for tomorrow:</span> {r.materials_tomorrow}
                    </p>
                  )}
                  {r.gps && (
                    <div className="mt-1.5 text-xs text-slate-500">
                      <span className="font-medium text-slate-600">{formatDuration(Number(r.gps.total_hours) || 0)}</span>
                      {Number(r.gps.miles) > 0 && <span> · {Number(r.gps.miles).toFixed(1)} mi</span>}
                      {r.gps.first_in && <span> · first in {formatTime(r.gps.first_in, tz)}</span>}
                      {r.gps.last_out && <span> · last out {formatTime(r.gps.last_out, tz)}</span>}
                      {(r.gps.jobs ?? []).length > 0 && (
                        <span>
                          {" · "}
                          {(r.gps.jobs ?? [])
                            .map((jr) => `${jr.label} ${formatDuration(Number(jr.hours) || 0)}`)
                            .join(" · ")}
                        </span>
                      )}
                    </div>
                  )}
                </>
              );
              // A REVIEWED REPORT HAS ALREADY DONE ITS JOB. Moving this card to the page Erik
              // opens every morning only helps if it does not rebuild the wall it left: 14 days
              // of debriefs rendered whole (did-today and materials are whitespace-pre-line and
              // uncapped) is a dozen full-height blocks standing between the clock and today's
              // agenda on a 375px phone, most of them already checked off. So an unreviewed
              // report stays open — it is the thing that still needs him — and a reviewed one
              // shrinks to its identity row.
              // NOT A DEAD END, and nothing silent: the row is a <details> disclosure, so the
              // debrief is one tap away in place (no page, no fetch, no client JS), the header
              // still counts "N to review · last 14 days", and the 14-day reach is untouched.
              if (reviewed) {
                return (
                  <li key={r.id}>
                    <details className="group">
                      {/* Whole row is the target (44px), not a control inside it. */}
                      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-5 py-3 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
                        <div className="min-w-0 flex-1 truncate text-sm">
                          <span className="font-semibold text-slate-900">{r.name}</span>
                          <span className="ml-2 text-slate-500">{formatDate(r.report_date, tz)}</span>
                        </div>
                        <Badge tone="green" className="shrink-0">reviewed</Badge>
                      </summary>
                      <div className="px-5 pb-3">{body}</div>
                    </details>
                  </li>
                );
              }
              return (
                <li key={r.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 text-sm">
                      <span className="font-semibold text-slate-900">{r.name}</span>
                      <span className="ml-2 text-slate-500">{formatDate(r.report_date, tz)}</span>
                    </div>
                    <MarkReportReviewedButton id={r.id} />
                  </div>
                  {body}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* TODAY — the execution feed right under the Now card (and the office's debriefs), so the
          3-second glance (where I am + what's happening when) fits in one viewport. It holds only
          Earlier / Next / Later: the job you're on is the Now card. */}
      {view === "week" ? (
        /* Tech week — the agenda grouped by day (Sun–Sat), paged via ?week=. */
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
              <CalendarCheck className="h-4 w-4 shrink-0 text-brand" />
              <span className="truncate">{weekOffset === 0 ? "This week" : `Week of ${weekOfLabel}`}</span>
            </div>
            {/* 44px, all three (the paging arrows were 36px): -my-3 keeps the header its height. */}
            <div className="-my-3 flex shrink-0 items-center gap-0.5">
              <Link
                href={`/planner?view=week&week=${weekOffset - 1}`}
                aria-label="Previous week"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <ChevronLeft className="h-4 w-4" />
              </Link>
              {weekOffset !== 0 && (
                <Link href="/planner?view=week" className="inline-flex min-h-11 items-center px-1 text-xs font-medium text-brand hover:underline">
                  This Week
                </Link>
              )}
              <Link
                href={`/planner?view=week&week=${weekOffset + 1}`}
                aria-label="Next week"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
          {weekDayGroups.every((d) => d.items.length === 0) ? (
            empty("Nothing scheduled this week.")
          ) : (
            weekDayGroups.map((d) => (
              <div key={d.dayStr}>
                <div
                  className={`px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide ${
                    d.dayStr === todayStr ? "bg-brand-light/40 text-brand" : "bg-slate-50/70 text-slate-400"
                  }`}
                >
                  {d.label}{d.dayStr === todayStr ? " · Today" : ""}
                </div>
                {d.items.length > 0 ? (
                  <ul className="divide-y divide-slate-100">{agendaRows(d.items, d.dayStr)}</ul>
                ) : (
                  <p className="px-5 py-2 text-xs text-slate-300">Open</p>
                )}
              </div>
            ))
          )}
        </Card>
      ) : (
        /* Day — the Today card holds only Earlier / Next / Later: the job you're ON is the Now
           card at the top of the page, with its doors. */
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CalendarCheck className="h-4 w-4 text-brand" /> Today
            </div>
            {/* A tech pages his own week here. The office has no doors in this header: a new
                appointment is + › New Appointment, and THE week is the Schedule tile (a staff
                /planner?view=week still lands on /schedule?view=week, above). */}
            {!isStaff && (
              <Link
                href="/planner?view=week"
                className="-my-3 inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-2 text-xs font-medium text-brand hover:underline"
              >
                Week →
              </Link>
            )}
          </div>


          {nextAgenda.length === 0 && laterAgenda.length === 0 && earlierAgenda.length === 0 ? (
            empty(currentJob ? "Nothing else on the schedule today." : "Nothing left on the schedule today.")
          ) : (
            <>
              {earlierAgenda.length > 0 && (
                <>
                  <div className="bg-slate-50/70 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Earlier today</div>
                  <ul className="divide-y divide-slate-100">{agendaRows(earlierAgenda, todayStr)}</ul>
                </>
              )}
              {nextAgenda.length > 0 && (
                <>
                  <div className="bg-slate-50/70 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">Next</div>
                  <ul className="divide-y divide-slate-100">{agendaRows(nextAgenda, todayStr)}</ul>
                </>
              )}
              {laterAgenda.length > 0 && (
                <>
                  <div className="bg-slate-50/70 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Later</div>
                  <ul className="divide-y divide-slate-100">{agendaRows(laterAgenda, todayStr)}</ul>
                </>
              )}
            </>
          )}
        </Card>
      )}

      {/* TASKS & REMINDERS — what must get done (the agenda above is where you'll be). ONE card
          (Erik, 2026-09-26: "fold that into Today's 6 with an add reminder/task up top as that will
          be the most useful"): the Add line leads it — type the words; pick a job and it goes on that
          job's Tasks, leave it and it's my own Reminder. The rows below are my Reminders, uncapped and
          in rank order (Erik, 2026-09-30: "lets not limit it"); job tasks live on their job and in the
          Now card above. */}
      <YourList
        rows={six as any}
        subtasks={sixKids as any}
        todayStr={todayStr}
        doneToday={doneToday}
        restCount={restCount}
        jobs={addJobs}
      />

      {/* The office/else DOOR LINES that sat here were removed (Erik's declutter):
          office tasks live at /tasks, and flagged items already surface via
          Needs You below. The backlog stays reachable through Tasks & Reminders'
          Grab-One / All Reminders links + the dock. */}

      {/* NEEDS YOU — the pure DECISION inbox (money, leads, waiting, leak
          detectors), right under the day so pull-work follows the plan. Tasks
          live in Tasks & Reminders + the doors above, never here. */}
      {/* A supplier paper filed from the LAST card leaves no "Supplier Bills" line to hold its
          sentence and Undo; they land here instead, until he leaves the page. */}
      <SupplierPaperDoneTrail scope={SUPPLIER_PAPERS_SCOPE} />
      {(needsYou.now.length > 0 || needsYou.waiting.length > 0) && (
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Needs You</h2>
            {/* The open count (a pile counts one), the same number as the dock's badge. Nothing to
                act on now: no pill (zero shows no badge). */}
            {needsYou.now.length > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">{needsYou.now.length}</span>
            )}
          </div>
          <div className="p-3">
            <ActionList
              items={needsYou.now}
              people={people}
              todayStr={todayStr}
              tz={tz}
              leadsOn={leadsOn}
              isStaff={isStaff}
              textReady={textReady}
              emptyLabel="Nothing needs you right now."
            />
          </div>
          {/* WAITING (N): each thing waiting, why, and the day it comes back. Grey, never a badge. */}
          <WaitingFold items={needsYou.waiting} />
        </Card>
      )}

      {/* (The 6-field task box that sat here went in 0358: its one line leads Tasks & Reminders.) */}

      {/* The MONEY LINE (getMoneyPipeline totals) left this page — the AR page owns
          that view now, and overdue/draft invoices already surface as actionable
          rows in the Needs You inbox above. My Day carries no money map. */}

      {/* No leads snapshot anywhere on this page (the "Owner snapshot" tile, then the Open Leads
          card beside the clock, are both gone): leads live in Needs You's rows and on the Sales
          tile's badge, which counts the new, uncontacted ones. */}
    </div>
  );
}
