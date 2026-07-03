import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarCheck, ChevronLeft, ChevronRight, UserPlus, Receipt, Navigation, FolderClosed, ListTodo } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { RefreshOnVisible } from "@/components/refresh-on-visible";
import { WeatherWidget } from "@/components/weather-widget";
import { getMoneyPipeline } from "@/lib/billing-pipeline";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { hoursBetween, formatCurrency, formatTime } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { NavLink } from "@/components/nav-link";
import { toJobOptions, toCustomerOptions, toStaffOptions } from "@/lib/schedule-options";
import { todayBoundsInTz, prettyDay, tzDayStartUtc } from "@/lib/tz";
import { DayClock } from "./day-clock";
import { YourList } from "./your-list";
import { rankSix, SIX_SLOTS } from "@/lib/six-rank";
import { getActionItems } from "@/lib/action-items/query";
import { ActionList } from "@/components/action-items/action-list";
import { AppointmentButton, type ApptValue } from "../appointments/appointment-button";
import { JobMoveButton, ApptMoveButton } from "./agenda-move";
import { NewTaskBox } from "../tasks/tasks-view";
import { QuickCostButton } from "@/components/quick-cost-button";

export const dynamic = "force-dynamic";

const fmtTime = (iso: string) => formatTime(iso);

export default async function PlannerPage({ searchParams }: { searchParams: Promise<{ view?: string; actions?: string; week?: string }> }) {
  const { view: viewRaw, actions: actionsRaw, week: weekRaw } = await searchParams;
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

  // Pay-week boundary (MONDAY-start, org tz) computed upfront so the week-hours
  // query can ride the single parallel batch below. Monday matches Timecards/
  // payroll — the old Sunday-start figure made the DayClock "this week" mean a
  // different week than a timecard. Display-only: nothing here writes clock time.
  const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const payWeekStartDate = new Date(`${todayStr}T00:00:00Z`);
  payWeekStartDate.setUTCDate(payWeekStartDate.getUTCDate() - ((dow + 6) % 7)); // back to Monday
  const payWeekStartUtc = tzDayStartUtc(payWeekStartDate.toISOString().slice(0, 10), tz);

  // ONE parallel batch for everything that only needs the tz + the user id — was three sequential
  // rounds (day data → current job + week total → form/snapshot options). Latency audit 2026-06-27.
  const [
    { data: jobs }, { data: segJobs }, { data: appts }, { data: entries }, { data: openRows },
    { data: weekEntries },
    { data: customers }, { data: staff }, { data: jobOptRows }, { data: me }, leadsCount,
  ] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name, status, address, scheduled_start, customers(name)").gte("scheduled_start", dayStart.toISOString()).lt("scheduled_start", dayEnd.toISOString()).order("scheduled_start"),
    // Multi-range jobs whose segment covers today.
    supabase.from("job_schedule_segments").select("job_id, jobs(id, job_number, name, status, address, customers(name))").lte("start_date", todayStr).gte("end_date", todayStr),
    supabase.from("appointments").select("id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to, jobs(address)").gte("starts_at", dayStart.toISOString()).lt("starts_at", dayEnd.toISOString()).neq("status", "cancelled").order("starts_at"),
    supabase.from("time_entries").select("id, job_id, clock_in, clock_out, lunch_minutes, status").eq("profile_id", user?.id ?? "").gte("clock_in", dayStart.toISOString()).lt("clock_in", dayEnd.toISOString()),
    // The open entry, regardless of when it started (overnight shift, etc.). The job
    // on THIS entry is the "Now" hero — scoped to the caller, not the org's latest
    // in_progress job (which could be a coworker's site across town).
    supabase.from("time_entries").select("id, job_id, clock_in, clock_out, lunch_minutes, status").eq("profile_id", user?.id ?? "").eq("status", "open").order("clock_in", { ascending: false }).limit(1),
    // This pay week's logged hours (Monday-start — the same week a timecard means).
    supabase.from("time_entries").select("clock_in, clock_out, lunch_minutes, status").eq("profile_id", user?.id ?? "").gte("clock_in", payWeekStartUtc.toISOString()).lt("clock_in", dayEnd.toISOString()),
    // Options for the inline add/edit controls + the owner snapshot.
    supabase.from("customers").select("id, name").order("name"),
    supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    supabase.from("jobs").select("id, job_number, name, address").order("created_at", { ascending: false }).limit(200),
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("inquiries").select("id", { count: "exact", head: true }).is("converted_at", null).neq("status", "lost"),
  ]);

  const openEntry = (openRows ?? [])[0] as any | undefined;
  const isStaff = ["owner", "admin", "office"].includes((me as any)?.role ?? "");

  // THE week lives at /schedule for staff — My Day keeps a week only for techs,
  // who can't see /schedule (office-only). A role-gated single map ≠ duplication.
  if (view === "week" && isStaff) redirect("/schedule?view=week");

  // Merge scheduled-today jobs + segment-today jobs (dedup) — derived BEFORE the
  // next round because the six-slot pool cut reuses today's job ids (rank 4).
  const jobMap = new Map<string, any>();
  for (const j of jobs ?? []) jobMap.set(j.id, { ...j, time: j.scheduled_start });
  for (const s of (segJobs ?? []) as any[]) {
    const j = s.jobs;
    if (j && !jobMap.has(j.id)) jobMap.set(j.id, { ...j, time: null });
  }
  const todayJobs = [...jobMap.values()];
  const todayJobIds = todayJobs.map((j: any) => j.id as string);

  const uid = user?.id ?? "";
  // The ownership cut for MY tasks: techs see what's assigned to THEM; staff
  // additionally see their own unassigned captures (the boss's loose ends).
  const mineCut = <T,>(q: T): T =>
    (isStaff
      ? (q as any).or(`assigned_to.eq.${uid},and(created_by.eq.${uid},assigned_to.is.null)`)
      : (q as any).eq("assigned_to", uid)) as T;
  // TODAY'S 6 pool cut — only rows a rank can claim (pinned / overdue / due today /
  // riding today's jobs / flagged undated), so a deep dated backlog can't starve
  // the pool out of the 60-row cap. Plain undated tasks never fetch, never promote.
  const poolCut = [
    `focus_date.eq.${todayStr}`,
    `due_date.lte.${todayStr}`,
    "and(due_date.is.null,priority.gte.1)",
    ...(todayJobIds.length ? [`job_id.in.(${todayJobIds.join(",")})`] : []),
  ].join(",");
  const headCount = () => supabase.from("tasks").select("id", { count: "exact", head: true });

  // The reads that depend on a result above — the caller's current job (the job on
  // their OWN open time entry, so the "Now" hero is their site, not a coworker's),
  // the staff-only money pipeline, the six-slot pool, and the door/progress
  // head-counts — run together in one final round.
  const [curJobRes, pipeline, poolR, elseCountR, officeCountR, officeDueR, doneTodayR] = await Promise.all([
    openEntry?.job_id
      ? supabase.from("jobs").select("id, job_number, name, status, address, customers(name)").eq("id", openEntry.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
    // Money pipeline (staff only) — the daily "nothing got missed" nudge.
    isStaff ? getMoneyPipeline(supabase) : Promise.resolve(null),
    // TODAY'S 6 pool — my open TOP-LEVEL tasks a rank can claim (subtasks nest
    // under their parent and never count; children fetch below).
    mineCut(
      supabase
        .from("tasks")
        .select("id, title, category, priority, due_date, focus_date, job_id, jobs(job_number, name)")
        .eq("status", "open")
        .is("parent_id", null),
    )
      .or(poolCut)
      // Nulls (pins + flagged-undated) FIRST, then freshest dates — so the 60-cap
      // trims June zombies, not today's pins. rankSix re-sorts internally, so this
      // only governs what survives the cap, not display order (audit cn-v328).
      .order("due_date", { ascending: false, nullsFirst: true })
      .order("priority", { ascending: false })
      .limit(60),
    // "EVERYTHING ELSE" door count — the open top-level backlog. Staff: org-wide
    // minus office (the Office door counts that inventory). Techs: THEIR tasks,
    // because their door carries ?mine=1 so the number matches the page it opens.
    isStaff
      ? headCount().eq("status", "open").is("parent_id", null).neq("category", "office")
      : headCount().eq("status", "open").is("parent_id", null).eq("assigned_to", uid),
    // "OFFICE" door counts (staff only) — batch inventory + its due-now slice.
    isStaff
      ? headCount().eq("status", "open").is("parent_id", null).eq("category", "office")
      : Promise.resolve({ count: 0 } as { count: number | null }),
    isStaff
      ? headCount().eq("status", "open").is("parent_id", null).eq("category", "office").lte("due_date", todayStr)
      : Promise.resolve({ count: 0 } as { count: number | null }),
    // My tasks completed today — the durable half of the card's "2/6".
    mineCut(
      headCount()
        .eq("status", "done")
        .is("parent_id", null)
        .gte("completed_at", dayStart.toISOString())
        .lt("completed_at", dayEnd.toISOString()),
    ),
  ]);
  const currentJob = ((curJobRes as any)?.data as any) ?? undefined;
  const sixPool = ((poolR as any)?.data ?? []) as any[];
  // THE shared rank (lib/six-rank — the same function behind the morning digest,
  // pinned by tests/badge-economy.test.ts, so the phone and the card can never
  // disagree). The card's pin/on-site glyphs are derived HERE, keeping the pure
  // rank presentation-free.
  const scheduledJobSet = new Set(todayJobIds);
  const six = rankSix(sixPool, { todayStr, scheduledJobIds: scheduledJobSet }).map((t: any) => ({
    ...t,
    pinned: t.focus_date === todayStr,
    onSite: !!t.job_id && scheduledJobSet.has(t.job_id),
  }));
  // Pins beyond six wait behind the door — its label says so ("+N pinned").
  const pinnedOverflow = Math.max(0, sixPool.filter((t: any) => t.focus_date === todayStr).length - SIX_SLOTS);

  // The current job's materials (needs its id), the "Needs action" inbox (needs
  // the role), and the six's subtasks (need the chosen six) — one final round.
  const [mlRes, actionItems, kidsRes] = await Promise.all([
    currentJob
      ? supabase.from("material_lists").select("id, name").eq("job_id", currentJob.id).order("id", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    getActionItems({ todayStr, isStaff, userId: user?.id ?? "" }),
    six.length
      ? supabase
          .from("tasks")
          .select("id, title, status, parent_id")
          .in("parent_id", six.map((t) => t.id))
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const currentMaterials: { id: string; name: string } | null = ((mlRes as any)?.data as any) ?? null;
  const sixKids = ((kidsRes as any)?.data ?? []) as any[];

  // ── derived (no awaits) ──
  // DOOR NUMBERS — honest by subtraction: whatever the six show doesn't count as
  // "everything else"; office tasks IN the six stay in the office inventory count
  // (that door mirrors /tasks/office, which still lists them).
  const sixNonOffice = six.filter((t) => t.category !== "office").length;
  const elseCount = Math.max(0, (((elseCountR as any)?.count as number | null) ?? 0) - (isStaff ? sixNonOffice : six.length));
  const officeCount = (((officeCountR as any)?.count as number | null) ?? 0);
  const officeDue = (((officeDueR as any)?.count as number | null) ?? 0);
  const doneToday = (((doneTodayR as any)?.count as number | null) ?? 0);
  // Staff door counts NON-office tasks → open an office-free list (?else=1) so the
  // number matches the page; techs get their own assigned list (audit cn-v328).
  const elseHref = isStaff ? "/tasks?else=1" : "/tasks?mine=1";

  const hoursToday = (entries ?? []).reduce(
    (sum: number, e: any) =>
      e.status === "closed" && e.clock_out ? sum + hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : sum,
    0,
  );
  const hoursWeek = (weekEntries ?? []).reduce(
    (sum: number, e: any) =>
      e.status === "closed" && e.clock_out ? sum + hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : sum,
    0,
  );
  const findJob = (id: string) => jobMap.get(id) ?? (currentJob?.id === id ? currentJob : null);
  const openJobLabel =
    openEntry?.job_id && findJob(openEntry.job_id)
      ? `${findJob(openEntry.job_id).job_number} — ${findJob(openEntry.job_id).name}`
      : null;
  const clockJobs = todayJobs.map((j: any) => ({ id: j.id, label: `${j.job_number} — ${j.name}` }));

  const org = orgRow;
  const orgLocation = [(org as any)?.city, (org as any)?.state, (org as any)?.zip].filter(Boolean).join(", ") || null;
  const QUOTES = [
    "Service. Integrity. Reliability.",
    "Measure twice, cut once.",
    "Do the hard jobs first. The easy jobs will take care of themselves.",
    "Quality means doing it right when no one is looking.",
    "Take care of your customers and they'll take care of you.",
    "Safety first — go home the same way you came to work.",
    "Small daily improvements lead to stunning results.",
  ];
  const dailyQuote = QUOTES[new Date(`${todayStr}T12:00:00Z`).getUTCDate() % QUOTES.length];
  const jobOpts = toJobOptions(jobOptRows);
  const custOpts = toCustomerOptions(customers);
  const staffOpts = toStaffOptions(staff);
  const people = (staff ?? []).map((s: any) => ({ id: s.id, full_name: s.full_name }));
  const openInquiries = leadsCount.count ?? 0;

  const niceDay = prettyDay(todayStr);
  const empty = (label: string) => <p className="px-5 py-6 text-center text-sm text-slate-400">{label}</p>;

  // Needs-action shows the top 5 (the query already sorts urgent-first);
  // ?actions=all expands to the full list without a client component.
  const showAllActions = actionsRaw === "all";
  const visibleActions = showAllActions ? actionItems : actionItems.slice(0, 5);

  // ── Agenda (Now / Next / Later) ─────────────────────────────────────────────
  // One chronological stream of WHERE YOU'LL BE — timed jobs + appointments,
  // nothing else. Tasks live in Today's 6 above (doctrine law 2: a due-today task
  // rendering as slot AND agenda row would be a double map). The job you're ON is
  // the "Now" hero block; the rest groups into Next (soonest) and Later.
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
    // Row verbs (staff, day view only): the appt record powers the edit pencil +
    // move; jobs carry just what their move contract needs.
    appt?: ApptValue;
    jobId?: string;
  };
  const agenda: Agenda[] = [
    ...todayJobs
      .filter((j: any) => j.id !== currentJob?.id)
      .map((j: any) => ({
        key: `j-${j.id}`,
        kind: "job" as const,
        time: j.time,
        title: `${j.job_number} — ${j.name}`,
        sub: [j.customers?.name, j.address].filter(Boolean).join(" · ") || null,
        address: j.address ?? null,
        href: `/jobs/${j.id}`,
        status: j.status,
        jobId: j.id as string,
      })),
    ...(appts ?? []).map((a: any) => ({
      key: `a-${a.id}`,
      kind: "appt" as const,
      time: a.starts_at,
      title: a.title,
      sub: a.location ?? null,
      // Fall back to the linked job's address so the Navigate button appears on a
      // job appointment that has no explicit location (bug: NAV missing on appts).
      address: a.location ?? a.jobs?.address ?? null,
      href: a.job_id ? `/jobs/${a.job_id}` : `/schedule?view=day&date=${todayStr}`,
      apptType: a.type,
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
  const nowMs = Date.now();
  const timedAgenda = agenda.filter((i) => i.time).sort((a, b) => (a.time as string).localeCompare(b.time as string));
  const untimedAgenda = agenda.filter((i) => !i.time);
  const futureAgenda = timedAgenda.filter((i) => new Date(i.time as string).getTime() > nowMs);
  const nextAgenda = futureAgenda.slice(0, 2);
  // Everything else for the day — including jobs scheduled EARLIER today, which were being
  // dropped entirely — in time order, plus untimed items.
  const nextSet = new Set(nextAgenda);
  const laterAgenda = [...timedAgenda.filter((i) => !nextSet.has(i)), ...untimedAgenda];

  // Week view (techs only — staff were redirected above): the agenda widened to a
  // week (Sun–Sat), grouped by day, paged via ?week=. Sunday-start is the DISPLAY
  // week; the pay-week hours above are Monday-start on purpose.
  const weekDayGroups: { dayStr: string; label: string; items: Agenda[] }[] = [];
  if (view === "week") {
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
    const [{ data: wJobs }, { data: wAppts }, { data: wSegs }] = await Promise.all([
      supabase
        .from("jobs")
        .select("id, job_number, name, status, address, scheduled_start, customers(name)")
        .gte("scheduled_start", weekStartUtc.toISOString())
        .lt("scheduled_start", weekEndUtc.toISOString())
        .order("scheduled_start"),
      supabase
        .from("appointments")
        .select("id, type, title, starts_at, location, job_id, status")
        .gte("starts_at", weekStartUtc.toISOString())
        .lt("starts_at", weekEndUtc.toISOString())
        .neq("status", "cancelled")
        .order("starts_at"),
      // Multi-range jobs whose segment overlaps this week — so a Mon–Thu job shows on
      // every covered day (the day view does this too; without it the week view put
      // such jobs on their start day only).
      supabase
        .from("job_schedule_segments")
        .select("start_date, end_date, jobs(id, job_number, name, status, address, customers(name))")
        .lte("start_date", weekEndStr)
        .gte("end_date", weekStartStr),
    ]);
    const timedWeek: Agenda[] = [
      ...((wJobs ?? []) as any[]).map((j) => ({
        key: `wj-${j.id}`,
        kind: "job" as const,
        time: j.scheduled_start,
        title: `${j.job_number} — ${j.name}`,
        sub: [j.customers?.name, j.address].filter(Boolean).join(" · ") || null,
        address: j.address ?? null,
        href: `/jobs/${j.id}`,
        status: j.status,
      })),
      ...((wAppts ?? []) as any[]).map((a) => ({
        key: `wa-${a.id}`,
        kind: "appt" as const,
        time: a.starts_at,
        title: a.title,
        sub: a.location ?? null,
        address: a.location ?? null,
        href: a.job_id ? `/jobs/${a.job_id}` : `/schedule?view=day&date=${todayStr}`,
        apptType: a.type,
      })),
    ]
      .filter((i) => i.time)
      .sort((a, b) => (a.time as string).localeCompare(b.time as string));
    const tzDayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
    for (const dayStr of weekDayStrs) {
      const items: Agenda[] = timedWeek.filter((it) => tzDayOf(it.time as string) === dayStr);
      for (const s of (wSegs ?? []) as any[]) {
        const j = s.jobs;
        if (!j || s.start_date > dayStr || s.end_date < dayStr) continue;
        // Dedup: skip if this job already shows on this day via a timed row.
        if (items.some((it) => it.kind === "job" && it.href === `/jobs/${j.id}`)) continue;
        items.push({
          key: `ws-${j.id}-${dayStr}`,
          kind: "job",
          time: null,
          title: `${j.job_number} — ${j.name}`,
          sub: [j.customers?.name, j.address].filter(Boolean).join(" · ") || null,
          address: j.address ?? null,
          href: `/jobs/${j.id}`,
          status: j.status,
        });
      }
      weekDayGroups.push({ dayStr, label: prettyDay(dayStr), items });
    }
  }
  const weekOfLabel = weekDayGroups.length
    ? new Date(`${weekDayGroups[0].dayStr}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : "";

  const navBtnCls =
    "inline-flex shrink-0 items-center gap-1 rounded-lg border border-brand/30 bg-brand-light/40 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand-light";
  const agendaRows = (items: Agenda[]) =>
    items.map((i) => (
      <li key={i.key} className="flex items-center gap-3 px-5 py-3">
        <div className="w-14 shrink-0 text-sm font-medium text-slate-700">{i.time ? fmtTime(i.time) : "—"}</div>
        <Link href={i.href} className="min-w-0 flex-1 hover:opacity-80">
          <div className="flex items-center gap-2">
            {i.kind === "appt" ? (
              <Badge tone={i.apptType === "inspection" ? "amber" : "blue"}>{i.apptType}</Badge>
            ) : i.status ? (
              <Badge tone={statusTone(i.status)}>{i.status.replace("_", " ")}</Badge>
            ) : null}
            <span className="truncate text-sm font-medium text-slate-900">{i.title}</span>
          </div>
          {i.sub && <div className="truncate text-xs text-slate-400">{i.sub}</div>}
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          {i.address && (
            <NavLink address={i.address} className={navBtnCls}>
              <Navigation className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Navigate</span>
            </NavLink>
          )}
          {/* Row verbs (staff): the edit pencil kills the old dead-end (appt row →
              the job page's read-only tab); MoveToDay is the ONE reschedule
              grammar app-wide. Techs keep plain rows — the actions are
              staff-gated server-side. */}
          {isStaff && i.appt && (
            <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} appointment={i.appt} />
          )}
          {isStaff && i.appt && <ApptMoveButton id={i.appt.id} startsAt={i.appt.starts_at} endsAt={i.appt.ends_at} />}
          {isStaff && i.jobId && <JobMoveButton jobId={i.jobId} fromDate={todayStr} />}
        </div>
      </li>
    ));

  return (
    <div className="mx-auto max-w-3xl">
      {/* Reopen the app / return to this tab → pull fresh schedule data (no manual reload). */}
      <RefreshOnVisible />
      <PageHeader title="My Day" description={niceDay} />

      {/* Ambience strip (Erik-spec): SMALL weather + the daily quote in one slim line
          up top — never a card, never competing with the clock. Layout/content here is
          customize-on-request; tweak freely when he asks. */}
      <div className="mb-3 flex items-center gap-3">
        <WeatherWidget
          compact
          location={orgLocation}
          label={(org as any)?.city ?? undefined}
          source={getOrgSettings((org as any)?.settings).weather_source}
        />
        <p className="min-w-0 flex-1 truncate text-right text-xs italic text-slate-400">&ldquo;{dailyQuote}&rdquo;</p>
      </div>

      {/* Live time clock — clock in/out is the app's #1 impulse verb, so it sits
          first, at scroll position zero, doubling as the on-the-clock status line. */}
      <DayClock
        open={openEntry ? { id: openEntry.id, clock_in: openEntry.clock_in, jobLabel: openJobLabel } : null}
        closedHoursToday={hoursToday}
        closedHoursWeek={hoursWeek}
        currentJobId={currentJob?.id ?? ""}
        jobs={clockJobs}
        isStaff={isStaff}
      />

      {/* TODAY — the execution feed in slot 2, so the 3-second glance (clock
          status + what's happening when) fits in one viewport, zero scroll. */}
      {view === "week" ? (
        /* Tech week — the agenda grouped by day (Sun–Sat), paged via ?week=. */
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
              <CalendarCheck className="h-4 w-4 shrink-0 text-brand" />
              <span className="truncate">{weekOffset === 0 ? "This week" : `Week of ${weekOfLabel}`}</span>
            </div>
            <div className="-my-1 flex shrink-0 items-center gap-0.5">
              <Link
                href={`/planner?view=week&week=${weekOffset - 1}`}
                aria-label="Previous week"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <ChevronLeft className="h-4 w-4" />
              </Link>
              {weekOffset !== 0 && (
                <Link href="/planner?view=week" className="px-1 text-xs font-medium text-brand hover:underline">
                  This week
                </Link>
              )}
              <Link
                href={`/planner?view=week&week=${weekOffset + 1}`}
                aria-label="Next week"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
                  <ul className="divide-y divide-slate-100">{agendaRows(d.items)}</ul>
                ) : (
                  <p className="px-5 py-2 text-xs text-slate-300">Open</p>
                )}
              </div>
            ))
          )}
        </Card>
      ) : (
        /* Day — ONE card: the job you're ON as its header block (2×2 field
           actions intact), then Next / Later. */
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CalendarCheck className="h-4 w-4 text-brand" /> Today
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              {isStaff && <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} defaultDate={todayStr} compact />}
              {/* THE week lives at /schedule (staff); techs page their own week here. */}
              <Link
                href={isStaff ? "/schedule?view=week" : "/planner?view=week"}
                className="whitespace-nowrap text-xs font-medium text-brand hover:underline"
              >
                Week →
              </Link>
            </div>
          </div>

          {/* NOW — the job you're on, folded in as the card's header block. The
              full 2×2 action grid stays: Navigate / Open / Materials / Quick
              cost are the field crew's #1 affordances. */}
          {currentJob && (
            <div className="border-b border-brand/20 bg-brand-light/30 px-5 py-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">Now</div>
              <Link href={`/jobs/${currentJob.id}`} className="mt-0.5 block text-lg font-bold text-slate-900 hover:text-brand">
                {currentJob.job_number} — {currentJob.name}
              </Link>
              {(currentJob.customers?.name || currentJob.address) && (
                <div className="text-sm text-slate-500">
                  {currentJob.customers?.name ?? ""}{currentJob.address ? ` · ${currentJob.address}` : ""}
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm font-medium">
                {currentJob.address && (
                  <NavLink
                    address={currentJob.address}
                    className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg bg-brand text-white shadow-sm hover:bg-brand-dark"
                  >
                    <Navigation className="h-4 w-4" /> Navigate
                  </NavLink>
                )}
                <Link href={`/jobs/${currentJob.id}`} className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">
                  Open
                </Link>
                <Link
                  href={currentMaterials ? `/materials/${currentMaterials.id}` : `/jobs/${currentJob.id}?tab=materials`}
                  className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                >
                  Materials
                </Link>
                <QuickCostButton
                  orgId={(org as any)?.id ?? ""}
                  jobId={currentJob.id}
                  className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                />
              </div>
            </div>
          )}

          {nextAgenda.length === 0 && laterAgenda.length === 0 ? (
            empty(currentJob ? "Nothing else on the schedule today." : "Nothing left on the schedule today.")
          ) : (
            <>
              {nextAgenda.length > 0 && (
                <>
                  <div className="bg-slate-50/70 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">Next</div>
                  <ul className="divide-y divide-slate-100">{agendaRows(nextAgenda)}</ul>
                </>
              )}
              {laterAgenda.length > 0 && (
                <>
                  <div className="bg-slate-50/70 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Later</div>
                  <ul className="divide-y divide-slate-100">{agendaRows(laterAgenda)}</ul>
                </>
              )}
            </>
          )}
        </Card>
      )}

      {/* TODAY'S 6 — what must get done (the agenda above is where you'll be).
          Pins + the ranked pool fill six check rows; subtasks nest under their
          parent and never count anywhere. */}
      <YourList
        six={six as any}
        subtasks={sixKids as any}
        todayStr={todayStr}
        doneToday={doneToday}
        grabHref={elseCount + officeCount > 0 ? elseHref : null}
      />

      {/* DOOR LINES — #7+ never vanishes, it just doesn't scream. Grey inventory
          numbers are allowed on a door (a browse affordance), never on chrome. */}
      {(officeCount > 0 || elseCount > 0 || pinnedOverflow > 0) && (
        <div className="mb-4 space-y-2">
          {isStaff && officeCount > 0 && (
            <Link
              href="/tasks/office"
              className="flex min-h-[44px] items-center gap-x-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm hover:bg-slate-50"
            >
              <span className="flex items-center gap-1.5 font-semibold text-slate-900">
                <FolderClosed className="h-4 w-4 text-slate-400" /> Office
              </span>
              <span className="text-slate-600">
                <strong>{officeCount}</strong>
                {officeDue > 0 ? ` (${officeDue} due)` : ""}
              </span>
              <span className="ml-auto text-xs font-medium text-brand">→</span>
            </Link>
          )}
          {(elseCount > 0 || pinnedOverflow > 0) && (
            <Link
              href={elseHref}
              className="flex min-h-[44px] items-center gap-x-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm hover:bg-slate-50"
            >
              <span className="flex items-center gap-1.5 font-semibold text-slate-900">
                <ListTodo className="h-4 w-4 text-slate-400" /> Everything else
              </span>
              <span className="text-slate-600">
                <strong>{elseCount}</strong>
                {pinnedOverflow > 0 ? ` · +${pinnedOverflow} pinned` : ""}
              </span>
              <span className="ml-auto text-xs font-medium text-brand">→</span>
            </Link>
          )}
        </div>
      )}

      {/* Needs action — the pure DECISION inbox (money, leads, waiting, leak
          detectors), right under the day so pull-work follows the plan. Tasks
          live in Today's 6 + the doors above, never here. */}
      {actionItems.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Needs action</h2>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
              {actionItems.length}
            </span>
          </div>
          <div className="p-3">
            <ActionList items={visibleActions} people={people} />
          </div>
          {!showAllActions && actionItems.length > 5 && (
            <Link
              href={view === "week" ? `/planner?view=week${weekOffset ? `&week=${weekOffset}` : ""}&actions=all` : "/planner?actions=all"}
              className="block border-t border-slate-100 px-5 py-2.5 text-center text-sm font-medium text-brand hover:bg-slate-50"
            >
              Show all {actionItems.length} →
            </Link>
          )}
        </Card>
      )}

      {/* Quick add-a-task box — the mint door. Its toast says where the task
          landed (today's six / Office / Everything else) so capture stays honest. */}
      <NewTaskBox jobs={(jobOptRows ?? []) as any} people={people} todayStr={todayStr} />

      {/* MONEY LINE — the daily "nothing slipped" nudge. ONE money map on My Day:
          this line carries the pipeline totals (to invoice + unpaid/outstanding);
          draft/overdue invoices are NOT re-counted here — they surface as actionable
          rows in the Needs-action inbox above. Two maps of /billing on one page
          already disagreed once (the old parallel Outstanding sum). */}
      {pipeline && (pipeline.doneNotInvoiced.length > 0 || pipeline.unpaid.length > 0) && (
        <Link
          href="/billing"
          className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm hover:bg-slate-50"
        >
          <span className="flex items-center gap-1.5 font-semibold text-slate-900"><Receipt className="h-4 w-4 text-brand" /> Money</span>
          {pipeline.doneNotInvoiced.length > 0 && (
            <span className="text-rose-700"><strong>{pipeline.doneNotInvoiced.length}</strong> to invoice{pipeline.toInvoiceTotal > 0 ? ` · ${formatCurrency(pipeline.toInvoiceTotal)}` : ""}</span>
          )}
          {pipeline.unpaid.length > 0 && (
            <span className="text-slate-600"><strong>{pipeline.unpaid.length}</strong> unpaid · {formatCurrency(pipeline.outstandingTotal)}</span>
          )}
          <span className="ml-auto text-xs font-medium text-brand">Open Billing →</span>
        </Link>
      )}

      {/* Owner snapshot — what "Overview" used to surface, folded into My Day.
          No Outstanding card here: the money line above is the ONE money map. */}
      {isStaff && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <Link href="/leads" className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:bg-slate-50">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <UserPlus className="h-4 w-4" />
            </span>
            <div>
              <div className="text-lg font-bold text-slate-900">{openInquiries}</div>
              <div className="text-xs text-slate-500">Open leads</div>
            </div>
          </Link>
        </div>
      )}


    </div>
  );
}
