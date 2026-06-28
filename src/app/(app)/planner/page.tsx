import Link from "next/link";
import { Briefcase, CalendarCheck, UserPlus, Receipt, Navigation } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { RefreshOnVisible } from "@/components/refresh-on-visible";
import { WeatherWidget } from "@/components/weather-widget";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { hoursBetween, formatCurrency, formatTime } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { NavLink } from "@/components/nav-link";
import { toJobOptions, toCustomerOptions, toStaffOptions } from "@/lib/schedule-options";
import { todayBoundsInTz, prettyDay, tzDayStartUtc } from "@/lib/tz";
import { DayClock } from "./day-clock";
import { getActionItems } from "@/lib/action-items/query";
import { ActionList } from "@/components/action-items/action-list";
import { AppointmentButton } from "../appointments/appointment-button";
import { NewTaskBox } from "../tasks/tasks-view";
import { QuickCostButton } from "@/components/quick-cost-button";

export const dynamic = "force-dynamic";

const fmtTime = (iso: string) => formatTime(iso);

export default async function PlannerPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: viewRaw } = await searchParams;
  const view = viewRaw === "week" ? "week" : "day";
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

  // Week boundary (payroll week = Sunday → today, org tz) computed upfront so the week-hours query
  // can ride the single parallel batch below instead of waiting for a later round.
  const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const weekStartDate = new Date(`${todayStr}T00:00:00Z`);
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - dow);
  const weekStartUtc = tzDayStartUtc(weekStartDate.toISOString().slice(0, 10), tz);

  // ONE parallel batch for everything that only needs the tz + the user id — was three sequential
  // rounds (day data → current job + week total → form/snapshot options). Latency audit 2026-06-27.
  const [
    { data: jobs }, { data: segJobs }, { data: appts }, { data: tasks }, { data: entries }, { data: openRows },
    { data: curRows }, { data: weekEntries },
    { data: customers }, { data: staff }, { data: jobOptRows }, { data: me }, leadsCount, { data: invRows },
  ] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name, status, address, scheduled_start, customers(name)").gte("scheduled_start", dayStart.toISOString()).lt("scheduled_start", dayEnd.toISOString()).order("scheduled_start"),
    // Multi-range jobs whose segment covers today.
    supabase.from("job_schedule_segments").select("job_id, jobs(id, job_number, name, status, address, customers(name))").lte("start_date", todayStr).gte("end_date", todayStr),
    supabase.from("appointments").select("id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to").gte("starts_at", dayStart.toISOString()).lt("starts_at", dayEnd.toISOString()).neq("status", "cancelled").order("starts_at"),
    supabase.from("tasks").select("id, title, category, status, priority, due_date, job_id, assigned_to, jobs(job_number, name), assignee:assigned_to(full_name)").eq("status", "open").lte("due_date", todayStr).order("priority", { ascending: false }),
    supabase.from("time_entries").select("id, job_id, clock_in, clock_out, lunch_minutes, status").eq("profile_id", user?.id ?? "").gte("clock_in", dayStart.toISOString()).lt("clock_in", dayEnd.toISOString()),
    // The open entry, regardless of when it started (overnight shift, etc.).
    supabase.from("time_entries").select("id, job_id, clock_in, clock_out, lunch_minutes, status").eq("profile_id", user?.id ?? "").eq("status", "open").order("clock_in", { ascending: false }).limit(1),
    // The job you're actually on right now.
    supabase.from("jobs").select("id, job_number, name, status, address, customers(name)").eq("status", "in_progress").order("scheduled_start", { ascending: false }).limit(1),
    // This week's logged hours.
    supabase.from("time_entries").select("clock_in, clock_out, lunch_minutes, status").eq("profile_id", user?.id ?? "").gte("clock_in", weekStartUtc.toISOString()).lt("clock_in", dayEnd.toISOString()),
    // Options for the inline add/edit controls + the owner snapshot.
    supabase.from("customers").select("id, name").order("name"),
    supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    supabase.from("jobs").select("id, job_number, name, address").order("created_at", { ascending: false }).limit(200),
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("inquiries").select("id", { count: "exact", head: true }).is("converted_at", null).neq("status", "lost"),
    supabase.from("invoices").select("total, amount_paid, status"),
  ]);

  const currentJob = (curRows ?? [])[0] as any | undefined;
  const isStaff = ["owner", "admin", "office"].includes((me as any)?.role ?? "");

  // The two reads that depend on a result above — the current job's materials (needs its id) and the
  // "Needs action" inbox (needs the role) — run together in one final round instead of two more awaits.
  const [mlRes, actionItems] = await Promise.all([
    currentJob
      ? supabase.from("material_lists").select("id, name").eq("job_id", currentJob.id).order("id", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    getActionItems({ todayStr, isStaff, userId: user?.id ?? "" }),
  ]);
  const currentMaterials: { id: string; name: string } | null = ((mlRes as any)?.data as any) ?? null;

  // ── derived (no awaits) ──
  // Merge scheduled-today jobs + segment-today jobs (dedup).
  const jobMap = new Map<string, any>();
  for (const j of jobs ?? []) jobMap.set(j.id, { ...j, time: j.scheduled_start });
  for (const s of (segJobs ?? []) as any[]) {
    const j = s.jobs;
    if (j && !jobMap.has(j.id)) jobMap.set(j.id, { ...j, time: null });
  }
  const todayJobs = [...jobMap.values()];

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
  const openEntry = (openRows ?? [])[0] as any | undefined;
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
  const outstanding = (invRows ?? [])
    .filter((i: any) => !["paid", "void"].includes(i.status))
    .reduce((s: number, i: any) => s + (Number(i.total) - Number(i.amount_paid)), 0);

  const niceDay = prettyDay(todayStr);
  const empty = (label: string) => <p className="px-5 py-6 text-center text-sm text-slate-400">{label}</p>;

  // ── Agenda (Now / Next / Later) ─────────────────────────────────────────────
  // One chronological stream of the day — timed jobs + appointments. (Tasks live in
  // the "Needs action" inbox above, so they're not duplicated here.) The job you're
  // ON is the "Now" hero card; the rest groups into Next (soonest) and Later.
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
      })),
    ...(appts ?? []).map((a: any) => ({
      key: `a-${a.id}`,
      kind: "appt" as const,
      time: a.starts_at,
      title: a.title,
      sub: a.location ?? null,
      address: a.location ?? null,
      href: a.job_id ? `/jobs/${a.job_id}` : "/schedule?view=appointments",
      apptType: a.type,
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

  // Week view: the same agenda widened to this week (Sun–Sat), grouped by day.
  const weekDayGroups: { dayStr: string; label: string; items: Agenda[] }[] = [];
  if (view === "week") {
    // The 7 day strings (Sun–Sat) of this week, in the org tz.
    const weekDayStrs: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartDate);
      d.setUTCDate(d.getUTCDate() + i);
      weekDayStrs.push(d.toISOString().slice(0, 10));
    }
    const weekStartStr = weekDayStrs[0];
    const weekEndStr = weekDayStrs[6];
    const weekEndExcl = new Date(weekStartDate);
    weekEndExcl.setUTCDate(weekEndExcl.getUTCDate() + 7);
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
        href: a.job_id ? `/jobs/${a.job_id}` : "/schedule?view=appointments",
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
        {i.address && (
          <NavLink address={i.address} className={navBtnCls}>
            <Navigation className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Navigate</span>
          </NavLink>
        )}
      </li>
    ));

  return (
    <div className="mx-auto max-w-3xl">
      {/* Reopen the app / return to this tab → pull fresh schedule data (no manual reload). */}
      <RefreshOnVisible />
      <PageHeader title="My Day" description={niceDay} />

      <div className="mb-3 flex gap-1">
        {(["day", "week"] as const).map((v) => (
          <Link
            key={v}
            href={`/planner?view=${v}`}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium ${
              view === v ? "bg-brand text-white shadow-sm" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {v === "day" ? "Day" : "Week"}
          </Link>
        ))}
      </div>

      <div className="mb-3">
        <WeatherWidget
          location={orgLocation}
          label={(org as any)?.city ?? undefined}
          source={getOrgSettings((org as any)?.settings).weather_source}
        />
      </div>
      <p className="mb-4 text-center text-sm italic text-slate-400">&ldquo;{dailyQuote}&rdquo;</p>

      {/* NOW — the job you're on, front and center. Buttons share one size so the
          Navigate button no longer towers over Open / Materials. */}
      {currentJob && (
        <Card className="mb-4 border-brand/40 bg-brand-light/30">
          <div className="px-5 py-4">
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
        </Card>
      )}

      {view === "week" ? (
        /* Week view — the agenda grouped by day (Sun–Sat), today highlighted. */
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CalendarCheck className="h-4 w-4 text-brand" /> This week
            </div>
            <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} defaultDate={todayStr} compact />
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
        /* Day view — one chronological agenda (Next, then Later): jobs +
           appointments interleaved by time. Tasks live in "Needs action" below. */
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CalendarCheck className="h-4 w-4 text-brand" /> Coming up today
            </div>
            <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} defaultDate={todayStr} compact />
          </div>
          {nextAgenda.length === 0 && laterAgenda.length === 0 ? (
            empty("Nothing left on the schedule today.")
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

      {/* Live time clock — tick + one-tap clock in/out */}
      <DayClock
        open={openEntry ? { id: openEntry.id, clock_in: openEntry.clock_in, jobLabel: openJobLabel } : null}
        closedHoursToday={hoursToday}
        closedHoursWeek={hoursWeek}
        currentJobId={currentJob?.id ?? ""}
        jobs={clockJobs}
        isStaff={isStaff}
      />

      {/* Needs action — the one unified inbox (tasks, jobs to schedule,
          inquiries, appointments to finish, captures to file). */}
      {actionItems.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Needs action</h2>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
              {actionItems.length}
            </span>
          </div>
          <div className="p-3">
            <ActionList items={actionItems} people={people} />
          </div>
        </Card>
      )}

      {/* Quick stats */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Card className="flex flex-col items-center py-4">
          <Briefcase className="mb-1 h-5 w-5 text-brand" />
          <div className="text-2xl font-bold text-slate-900">{todayJobs.length}</div>
          <div className="text-xs text-slate-500">Jobs</div>
        </Card>
        <Card className="flex flex-col items-center py-4">
          <CalendarCheck className="mb-1 h-5 w-5 text-purple-600" />
          <div className="text-2xl font-bold text-slate-900">{(appts ?? []).length}</div>
          <div className="text-xs text-slate-500">Appointments</div>
        </Card>
      </div>

      {/* Owner snapshot — what "Overview" used to surface, folded into My Day */}
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
          <Link href="/billing" className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:bg-slate-50">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
              <Receipt className="h-4 w-4" />
            </span>
            <div>
              <div className="text-lg font-bold text-slate-900">{formatCurrency(outstanding)}</div>
              <div className="text-xs text-slate-500">Outstanding</div>
            </div>
          </Link>
        </div>
      )}

      {/* Tasks due now live in the unified "Needs action" inbox above; this just
          keeps a quick add-a-task box on My Day. */}
      <NewTaskBox jobs={(jobOptRows ?? []) as any} people={people} />
    </div>
  );
}
