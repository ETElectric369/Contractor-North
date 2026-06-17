import Link from "next/link";
import { Briefcase, CalendarCheck, ClipboardCheck, MapPin, UserPlus, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { WeatherWidget } from "@/components/weather-widget";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { hoursBetween, formatCurrency } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz, prettyDay, tzDayStartUtc } from "@/lib/tz";
import { DayClock } from "./day-clock";
import { getActionItems } from "@/lib/action-items/query";
import { ActionList } from "@/components/action-items/action-list";
import { AppointmentButton } from "../appointments/appointment-button";
import { NewTaskBox } from "../tasks/tasks-view";

export const dynamic = "force-dynamic";

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export default async function PlannerPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // "Today" must be the business's local day, not the server's UTC day —
  // otherwise afternoon work in the Americas falls into "tomorrow".
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("city, state, zip, settings")
    .limit(1)
    .maybeSingle();
  const tz = getOrgSettings((orgRow as any)?.settings).timezone || "America/Los_Angeles";
  const { dayStart, dayEnd, todayStr } = todayBoundsInTz(tz);

  const [{ data: jobs }, { data: segJobs }, { data: appts }, { data: tasks }, { data: entries }, { data: openRows }] =
    await Promise.all([
      supabase
        .from("jobs")
        .select("id, job_number, name, status, address, scheduled_start, customers(name)")
        .gte("scheduled_start", dayStart.toISOString())
        .lt("scheduled_start", dayEnd.toISOString())
        .order("scheduled_start"),
      // Multi-range jobs whose segment covers today.
      supabase
        .from("job_schedule_segments")
        .select("job_id, jobs(id, job_number, name, status, address, customers(name))")
        .lte("start_date", todayStr)
        .gte("end_date", todayStr),
      supabase
        .from("appointments")
        .select("id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to")
        .gte("starts_at", dayStart.toISOString())
        .lt("starts_at", dayEnd.toISOString())
        .neq("status", "cancelled")
        .order("starts_at"),
      supabase
        .from("tasks")
        .select("id, title, category, status, priority, due_date, job_id, assigned_to, jobs(job_number, name), assignee:assigned_to(full_name)")
        .eq("status", "open")
        .lte("due_date", todayStr)
        .order("priority", { ascending: false }),
      supabase
        .from("time_entries")
        .select("id, job_id, clock_in, clock_out, lunch_minutes, status")
        .eq("profile_id", user?.id ?? "")
        .gte("clock_in", dayStart.toISOString())
        .lt("clock_in", dayEnd.toISOString()),
      // The open entry, regardless of when it started (overnight shift, etc.).
      supabase
        .from("time_entries")
        .select("id, job_id, clock_in, clock_out, lunch_minutes, status")
        .eq("profile_id", user?.id ?? "")
        .eq("status", "open")
        .order("clock_in", { ascending: false })
        .limit(1),
    ]);

  // Merge scheduled-today jobs + segment-today jobs (dedup).
  const jobMap = new Map<string, any>();
  for (const j of jobs ?? []) jobMap.set(j.id, { ...j, time: j.scheduled_start });
  for (const s of (segJobs ?? []) as any[]) {
    const j = s.jobs;
    if (j && !jobMap.has(j.id)) jobMap.set(j.id, { ...j, time: null });
  }
  const todayJobs = [...jobMap.values()];

  // The job you're actually on right now — put it up front, with its materials.
  const { data: curRows } = await supabase
    .from("jobs")
    .select("id, job_number, name, status, address, customers(name)")
    .eq("status", "in_progress")
    .order("scheduled_start", { ascending: false })
    .limit(1);
  const currentJob = (curRows ?? [])[0] as any | undefined;
  let currentMaterials: { id: string; name: string } | null = null;
  if (currentJob) {
    const { data: ml } = await supabase
      .from("material_lists")
      .select("id, name")
      .eq("job_id", currentJob.id)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    currentMaterials = (ml as any) ?? null;
  }

  const hoursToday = (entries ?? []).reduce(
    (sum: number, e: any) =>
      e.status === "closed" && e.clock_out ? sum + hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : sum,
    0,
  );

  // This week's logged hours (payroll week = Sunday → today, in the org tz), so
  // My Day shows a day total AND a running week total.
  const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const weekStartDate = new Date(`${todayStr}T00:00:00Z`);
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - dow);
  const weekStartUtc = tzDayStartUtc(weekStartDate.toISOString().slice(0, 10), tz);
  const { data: weekEntries } = await supabase
    .from("time_entries")
    .select("clock_in, clock_out, lunch_minutes, status")
    .eq("profile_id", user?.id ?? "")
    .gte("clock_in", weekStartUtc.toISOString())
    .lt("clock_in", dayEnd.toISOString());
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

  // Options for the inline add/edit controls (appointments + tasks) + the owner
  // snapshot (this page now also covers what "Overview" used to show).
  const [{ data: customers }, { data: staff }, { data: jobOptRows }, { data: me }, leadsCount, { data: invRows }] =
    await Promise.all([
      supabase.from("customers").select("id, name").order("name"),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
      supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(200),
      supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
      supabase.from("inquiries").select("id", { count: "exact", head: true }).is("converted_at", null).neq("status", "lost"),
      supabase.from("invoices").select("total, amount_paid, status"),
    ]);
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
  const jobOpts = (jobOptRows ?? []).map((j: any) => ({ id: j.id, label: `${j.job_number} · ${j.name}` }));
  const custOpts = (customers ?? []).map((c: any) => ({ id: c.id, label: c.name }));
  const staffOpts = (staff ?? []).map((s: any) => ({ id: s.id, label: s.full_name ?? "Unnamed" }));
  const people = (staff ?? []).map((s: any) => ({ id: s.id, full_name: s.full_name }));
  const isStaff = ["owner", "admin", "office"].includes((me as any)?.role ?? "");
  // The unified "Needs action" inbox — one list across tasks, jobs to schedule,
  // inquiries, appointments to finish, and captures to file.
  const actionItems = await getActionItems({ todayStr, isStaff, userId: user?.id ?? "" });
  const openInquiries = leadsCount.count ?? 0;
  const outstanding = (invRows ?? [])
    .filter((i: any) => !["paid", "void"].includes(i.status))
    .reduce((s: number, i: any) => s + (Number(i.total) - Number(i.amount_paid)), 0);

  const niceDay = prettyDay(todayStr);
  const empty = (label: string) => <p className="px-5 py-6 text-center text-sm text-slate-400">{label}</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="My Day" description={niceDay} />

      <div className="mb-3">
        <WeatherWidget location={orgLocation} label={(org as any)?.city ?? undefined} />
      </div>
      <p className="mb-4 text-center text-sm italic text-slate-400">&ldquo;{dailyQuote}&rdquo;</p>

      {/* Current job — front and center */}
      {currentJob && (
        <Card className="mb-4 border-brand/40 bg-brand-light/30">
          <div className="px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">Current job</div>
            <Link href={`/jobs/${currentJob.id}`} className="mt-0.5 block text-lg font-bold text-slate-900 hover:text-brand">
              {currentJob.job_number} — {currentJob.name}
            </Link>
            {(currentJob.customers?.name || currentJob.address) && (
              <div className="text-sm text-slate-500">
                {currentJob.customers?.name ?? ""}{currentJob.address ? ` · ${currentJob.address}` : ""}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2 text-sm font-medium">
              <Link href={`/jobs/${currentJob.id}`} className="rounded-lg bg-brand px-3 py-1.5 text-white hover:bg-brand-dark">
                Open job
              </Link>
              <Link
                href={currentMaterials ? `/materials/${currentMaterials.id}` : `/jobs/${currentJob.id}?tab=materials`}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
              >
                Materials list
              </Link>
              {currentJob.address && (
                <a
                  href={`https://maps.apple.com/?q=${encodeURIComponent(currentJob.address)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  Directions
                </a>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Live time clock — tick + one-tap clock in/out */}
      <DayClock
        open={openEntry ? { id: openEntry.id, clock_in: openEntry.clock_in, jobLabel: openJobLabel } : null}
        closedHoursToday={hoursToday}
        closedHoursWeek={hoursWeek}
        currentJobId={currentJob?.id ?? ""}
        jobs={clockJobs}
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
              <div className="text-xs text-slate-500">Open inquiries</div>
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

      {/* Today's appointments */}
      <Card className="mb-4 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <CalendarCheck className="h-4 w-4 text-purple-600" /> Appointments &amp; inspections
          </div>
          <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} defaultDate={todayStr} />
        </div>
        <ul className="divide-y divide-slate-100">
          {(appts ?? []).map((a: any) => (
            <li key={a.id} className="flex items-start gap-3 px-5 py-3">
              <div className="w-14 shrink-0 text-sm font-medium text-slate-700">{fmtTime(a.starts_at)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge tone={a.type === "inspection" ? "amber" : "blue"}>
                    {a.type === "inspection" ? <ClipboardCheck className="mr-1 inline h-3 w-3" /> : null}{a.type}
                  </Badge>
                  <span className="truncate text-sm font-medium text-slate-900">{a.title}</span>
                </div>
                {a.location && (
                  <a href={`https://maps.apple.com/?q=${encodeURIComponent(a.location)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-brand hover:underline">
                    <MapPin className="h-3 w-3" /> {a.location}
                  </a>
                )}
              </div>
              <AppointmentButton
                jobs={jobOpts}
                customers={custOpts}
                staff={staffOpts}
                appointment={{
                  id: a.id,
                  type: a.type,
                  title: a.title,
                  starts_at: a.starts_at,
                  ends_at: a.ends_at,
                  job_id: a.job_id,
                  customer_id: a.customer_id,
                  location: a.location,
                  notes: a.notes,
                  assigned_to: a.assigned_to,
                }}
              />
            </li>
          ))}
          {(appts ?? []).length === 0 && empty("Nothing booked today.")}
        </ul>
      </Card>

      {/* Today's jobs */}
      <Card className="mb-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          <Briefcase className="h-4 w-4 text-brand" /> Jobs today
        </div>
        <ul className="divide-y divide-slate-100">
          {todayJobs.map((j: any) => (
            <li key={j.id}>
              <Link href={`/jobs/${j.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-slate-50">
                <div className="w-14 shrink-0 text-sm font-medium text-slate-700">{j.time ? fmtTime(j.time) : "—"}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">{j.job_number} — {j.name}</span>
                    <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
                  </div>
                  <div className="text-xs text-slate-400">
                    {j.customers?.name ?? ""}{j.address ? ` · ${j.address}` : ""}
                  </div>
                </div>
              </Link>
            </li>
          ))}
          {todayJobs.length === 0 && empty("No jobs scheduled today.")}
        </ul>
      </Card>

      {/* Tasks due now live in the unified "Needs action" inbox above; this just
          keeps a quick add-a-task box on My Day. */}
      <NewTaskBox jobs={(jobOptRows ?? []) as any} people={people} />
    </div>
  );
}
