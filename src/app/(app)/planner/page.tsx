import Link from "next/link";
import { Briefcase, CalendarCheck, ClipboardCheck, Clock, ListTodo, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { hoursBetween, formatDuration } from "@/lib/utils";

export const dynamic = "force-dynamic";

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export default async function PlannerPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const todayStr = dayStart.toISOString().slice(0, 10);

  const [{ data: jobs }, { data: segJobs }, { data: appts }, { data: tasks }, { data: entries }] =
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
        .select("id, type, title, starts_at, ends_at, location, status, job_id")
        .gte("starts_at", dayStart.toISOString())
        .lt("starts_at", dayEnd.toISOString())
        .neq("status", "cancelled")
        .order("starts_at"),
      supabase
        .from("tasks")
        .select("id, title, category, priority, due_date, job_id, jobs(name)")
        .eq("status", "open")
        .lte("due_date", todayStr)
        .order("priority", { ascending: false }),
      supabase
        .from("time_entries")
        .select("clock_in, clock_out, lunch_minutes, status")
        .eq("profile_id", user?.id ?? "")
        .gte("clock_in", dayStart.toISOString()),
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
  const clockedIn = (entries ?? []).some((e: any) => e.status === "open");

  const niceDay = dayStart.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const empty = (label: string) => <p className="px-5 py-6 text-center text-sm text-slate-400">{label}</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="My Day" description={niceDay} />

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

      {/* Quick stats */}
      <div className="mb-4 grid grid-cols-3 gap-3">
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
        <Card className="flex flex-col items-center py-4">
          <Clock className={`mb-1 h-5 w-5 ${clockedIn ? "text-green-600" : "text-slate-400"}`} />
          <div className="text-2xl font-bold text-slate-900">{formatDuration(hoursToday)}</div>
          <div className="text-xs text-slate-500">{clockedIn ? "Logged · on the clock" : "Logged today"}</div>
        </Card>
      </div>

      {/* Today's appointments */}
      <Card className="mb-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          <CalendarCheck className="h-4 w-4 text-purple-600" /> Appointments &amp; inspections
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

      {/* Tasks due */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          <ListTodo className="h-4 w-4 text-amber-600" /> Tasks due
        </div>
        <ul className="divide-y divide-slate-100">
          {(tasks ?? []).map((t: any) => (
            <li key={t.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
              <span className="text-slate-800">
                {t.title}
                {t.jobs?.name && <span className="ml-2 text-xs text-slate-400">· {t.jobs.name}</span>}
              </span>
              <Badge tone="slate">{t.category}</Badge>
            </li>
          ))}
          {(tasks ?? []).length === 0 && empty("Nothing due. Nice.")}
        </ul>
      </Card>
    </div>
  );
}
