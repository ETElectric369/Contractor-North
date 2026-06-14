import Link from "next/link";
import {
  Users,
  UserPlus,
  FileText,
  ClipboardList,
  Clock,
  ArrowRight,
  DollarSign,
  Receipt,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { DashboardGreeting } from "./dashboard-greeting";
import { DashboardViewToggle } from "./dashboard-view-toggle";
import { MindMapNav } from "@/components/mind-map-nav";
import { NAV_TREE } from "@/lib/nav-tree";
import { WeatherWidget } from "@/components/weather-widget";
import { TasksWidget } from "@/components/tasks-widget";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate, hoursBetween, formatDuration } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Pull a handful of counts + recents in parallel.
  const [customers, openQuotes, activeJobs, recentQuotes, recentJobs, myOpen, profile] =
    await Promise.all([
      supabase.from("customers").select("id", { count: "exact", head: true }),
      supabase
        .from("quotes")
        .select("total", { count: "exact" })
        .in("status", ["draft", "sent"]),
      supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .in("status", ["scheduled", "in_progress"]),
      supabase
        .from("quotes")
        .select("id, quote_number, status, total, created_at")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("jobs")
        .select("id, job_number, name, status, scheduled_start")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("time_entries")
        .select("clock_in")
        .eq("profile_id", user?.id ?? "")
        .eq("status", "open")
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user?.id ?? "")
        .maybeSingle(),
    ]);

  // First name for the dashboard greeting (the greeting's time-of-day half is
  // computed client-side so it matches the user's local clock).
  const firstName =
    (profile.data?.full_name ?? "").trim().split(/\s+/)[0] || undefined;

  const pipeline =
    openQuotes.data?.reduce((sum, q) => sum + Number(q.total ?? 0), 0) ?? 0;

  // ── My Day: what's on YOUR plate — assigned jobs + work orders ──────────
  const dayEnd = new Date();
  dayEnd.setHours(23, 59, 59, 999);
  const [{ data: myJobs }, { data: myWos }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, job_number, name, status, address, city, description, scheduled_start")
      .contains("assigned_to", [user?.id ?? ""])
      .in("status", ["scheduled", "in_progress"])
      .lte("scheduled_start", dayEnd.toISOString())
      .order("scheduled_start"),
    supabase
      .from("work_orders")
      .select("id, wo_number, title, description, status, scheduled_for, jobs(job_number, name, address)")
      .eq("assigned_to", user?.id ?? "")
      .in("status", ["assigned", "in_progress"])
      .order("scheduled_for", { ascending: true, nullsFirst: false }),
  ]);
  const myDay = [
    ...((myJobs ?? []) as any[]).map((j) => ({
      kind: "job" as const,
      href: `/jobs/${j.id}`,
      title: `${j.job_number} — ${j.name}`,
      address: [j.address, j.city].filter(Boolean).join(", "),
      instructions: j.description,
      status: j.status,
    })),
    ...((myWos ?? []) as any[]).map((w) => ({
      kind: "wo" as const,
      href: `/work-orders/${w.id}`,
      title: `${w.wo_number} — ${w.title}`,
      address: w.jobs?.address ?? "",
      instructions: w.description,
      status: w.status,
    })),
  ];

  // Current / next job quick-jump (org-wide — works for a solo shop too).
  const nowIso = new Date().toISOString();
  const [{ data: curRows }, { data: nextRows }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, job_number, name, status, scheduled_start")
      .eq("status", "in_progress")
      .order("scheduled_start", { ascending: false })
      .limit(1),
    supabase
      .from("jobs")
      .select("id, job_number, name, status, scheduled_start")
      .in("status", ["scheduled", "in_progress"])
      .gt("scheduled_start", nowIso)
      .order("scheduled_start", { ascending: true })
      .limit(1),
  ]);
  const currentJob = (curRows ?? [])[0] ?? null;
  const nextJob = (nextRows ?? [])[0] ?? null;

  // "Needs attention" widgets: open inquiries, outstanding A/R, my hours this week.
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [leadsCount, invoiceRows, weekEntries] = await Promise.all([
    supabase
      .from("inquiries")
      .select("id", { count: "exact", head: true })
      .is("converted_at", null)
      .neq("status", "lost"),
    supabase.from("invoices").select("total, amount_paid, status"),
    supabase
      .from("time_entries")
      .select("clock_in, clock_out, lunch_minutes, status")
      .eq("profile_id", user?.id ?? "")
      .gte("clock_in", weekAgo),
  ]);

  const outstanding = (invoiceRows.data ?? [])
    .filter((i: any) => !["paid", "void"].includes(i.status))
    .reduce((s: number, i: any) => s + (Number(i.total) - Number(i.amount_paid)), 0);
  const weekHours = (weekEntries.data ?? []).reduce(
    (s: number, e: any) =>
      e.status === "closed" && e.clock_out
        ? s + hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes)
        : s,
    0,
  );

  const attention = [
    { label: "Open inquiries", value: leadsCount.count ?? 0, icon: UserPlus, href: "/leads", tone: "bg-indigo-50 text-indigo-600" },
    { label: "Outstanding", value: formatCurrency(outstanding), icon: Receipt, href: "/billing", tone: "bg-red-50 text-red-600" },
    { label: "My hours this week", value: formatDuration(weekHours), icon: Clock, href: "/timeclock", tone: "bg-green-50 text-green-600" },
  ];

  // Today's jobs + a daily motivational quote.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const { data: todayJobs } = await supabase
    .from("jobs")
    .select("id, name, job_number, status, scheduled_start, customers(name)")
    .gte("scheduled_start", todayStart.toISOString())
    .lt("scheduled_start", todayEnd.toISOString())
    .order("scheduled_start");

  const QUOTES = [
    "Service. Integrity. Reliability.",
    "Measure twice, cut once.",
    "The bitterness of poor quality remains long after the sweetness of low price is forgotten.",
    "Do the hard jobs first. The easy jobs will take care of themselves.",
    "Quality means doing it right when no one is looking.",
    "A job worth doing is worth doing well.",
    "Take care of your customers and they'll take care of you.",
    "Safety first — go home the same way you came to work.",
    "Small daily improvements lead to stunning results.",
    "Hard work beats talent when talent doesn't work hard.",
  ];
  const quote = QUOTES[new Date().getDate() % QUOTES.length];

  // Org location for the weather widget (RLS returns only the user's org).
  const { data: org } = await supabase
    .from("organizations")
    .select("name, city, state, zip")
    .limit(1)
    .maybeSingle();
  const orgLocation = [org?.city, org?.state, org?.zip].filter(Boolean).join(", ") || null;

  // Top 6 priority tasks for the dashboard widget.
  const { data: priorityTasks } = await supabase
    .from("tasks")
    .select("id, title, category, priority, due_date, job_id, jobs(name)")
    .eq("status", "open")
    .order("priority", { ascending: false })
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(6);

  // Compliance items expiring within 45 days (or already expired) — renewal nudge.
  const soonDate = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  const { data: expiringCompliance } = await supabase
    .from("compliance_items")
    .select("id, type, name, expires_date")
    .not("expires_date", "is", null)
    .lte("expires_date", soonDate)
    .order("expires_date", { ascending: true });

  const stats = [
    {
      label: "Customers",
      value: customers.count ?? 0,
      icon: Users,
      href: "/crm",
      tone: "bg-blue-50 text-blue-600",
    },
    {
      label: "Open quotes",
      value: openQuotes.count ?? 0,
      icon: FileText,
      href: "/quotes",
      tone: "bg-amber-50 text-amber-600",
    },
    {
      label: "Active jobs",
      value: activeJobs.count ?? 0,
      icon: ClipboardList,
      href: "/jobs",
      tone: "bg-green-50 text-green-600",
    },
    {
      label: "Quote pipeline",
      value: formatCurrency(pipeline),
      icon: DollarSign,
      href: "/quotes",
      tone: "bg-purple-50 text-purple-600",
    },
  ];

  const unpaidCount = (invoiceRows.data ?? []).filter(
    (i: any) => !["paid", "void"].includes(i.status) && Number(i.total) - Number(i.amount_paid) > 0.005,
  ).length;
  const mmCounts: Record<string, number> = {
    jobs: activeJobs.count ?? 0,
    customers: customers.count ?? 0,
    quotes: openQuotes.count ?? 0,
    money: unpaidCount,
  };

  return (
    <div>
      <PageHeader
        title={<DashboardGreeting name={firstName} />}
        description="Your business at a glance."
      />

      <DashboardViewToggle map={<MindMapNav tree={NAV_TREE} counts={mmCounts} />}>

      <WeatherWidget location={orgLocation} label={org?.city ?? undefined} />

      {(currentJob || nextJob) && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          {currentJob && (
            <Link
              href={`/jobs/${currentJob.id}`}
              className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 transition-shadow hover:shadow-md"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-100 text-green-700">▶</span>
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-green-700">Current job</span>
                <span className="block truncate text-sm font-medium text-slate-900">{currentJob.job_number} — {currentJob.name}</span>
              </span>
            </Link>
          )}
          {nextJob && (
            <Link
              href={`/jobs/${nextJob.id}`}
              className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 transition-shadow hover:shadow-md"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-700">⏭</span>
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-blue-700">Next job{nextJob.scheduled_start ? ` · ${formatDate(nextJob.scheduled_start)}` : ""}</span>
                <span className="block truncate text-sm font-medium text-slate-900">{nextJob.job_number} — {nextJob.name}</span>
              </span>
            </Link>
          )}
        </div>
      )}

      {myDay.length > 0 && (
        <Card className="mb-4 border-brand/30">
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            My day — your assignments
          </div>
          <ul className="divide-y divide-slate-100">
            {myDay.map((a) => (
              <li key={a.href} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={a.href} className="text-sm font-medium text-slate-900 hover:text-brand">
                    {a.title}
                  </Link>
                  <Badge tone={statusTone(a.status)}>{a.status.replace("_", " ")}</Badge>
                </div>
                {a.address && (
                  <a
                    href={`https://maps.apple.com/?q=${encodeURIComponent(a.address)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-brand hover:underline"
                  >
                    📍 {a.address}
                  </a>
                )}
                {a.instructions && (
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-slate-500">{a.instructions}</p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(expiringCompliance ?? []).length > 0 && (() => {
        const today = new Date().toISOString().slice(0, 10);
        const hasExpired = (expiringCompliance ?? []).some((c: any) => c.expires_date < today);
        return (
          <Link
            href="/compliance"
            className={`mb-4 block rounded-xl border px-4 py-3 text-sm ${hasExpired ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}
          >
            <span className="font-semibold">⚠️ Renewals due:</span>{" "}
            {(expiringCompliance ?? [])
              .slice(0, 4)
              .map((c: any) => `${c.name} (${formatDate(c.expires_date)})`)
              .join(" · ")}
            {(expiringCompliance ?? []).length > 4 ? " …" : ""}
            <span className="ml-1 underline">Review compliance →</span>
          </Link>
        );
      })()}

      <div className="mb-6 rounded-xl bg-brand-light/50 px-4 py-3 text-sm italic text-brand-dark">
        “{quote}”
      </div>

      {myOpen.data && (
        <Card className="mb-6 border-green-200 bg-green-50">
          <CardContent className="flex items-center gap-3 py-4">
            <Clock className="h-5 w-5 text-green-600" />
            <div className="flex-1 text-sm">
              <span className="font-medium text-green-900">
                You're clocked in
              </span>{" "}
              <span className="text-green-700">
                — {hoursBetween(myOpen.data.clock_in, new Date())} hrs so far
              </span>
            </div>
            <Link
              href="/timeclock"
              className="text-sm font-medium text-green-700 hover:underline"
            >
              Timeclock →
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.label} href={s.href}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-5">
                  <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${s.tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-900">
                      {s.value}
                    </div>
                    <div className="text-xs text-slate-500">{s.label}</div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {attention.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.label} href={s.href}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-5">
                  <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${s.tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-900">{s.value}</div>
                    <div className="text-xs text-slate-500">{s.label}</div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="mt-6">
        <TasksWidget tasks={(priorityTasks ?? []) as any} />
      </div>

      <Card className="mt-6">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-900">Today's jobs</h3>
          <Link href="/schedule" className="flex items-center gap-1 text-xs text-brand hover:underline">
            Scheduler <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <ul className="divide-y divide-slate-100">
          {(todayJobs ?? []).map((j: any) => (
            <li key={j.id}>
              <Link href={`/jobs/${j.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                <div>
                  <div className="text-sm font-medium text-slate-900">{j.name}</div>
                  <div className="text-xs text-slate-400">
                    {j.scheduled_start && new Date(j.scheduled_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                    {j.customers?.name ? ` · ${j.customers.name}` : ""}
                  </div>
                </div>
                <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
              </Link>
            </li>
          ))}
          {(!todayJobs || todayJobs.length === 0) && (
            <li className="px-5 py-8 text-center text-sm text-slate-400">No jobs scheduled today.</li>
          )}
        </ul>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-slate-900">Recent quotes</h3>
            <Link href="/quotes" className="flex items-center gap-1 text-xs text-brand hover:underline">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {(recentQuotes.data ?? []).map((q) => (
              <li key={q.id}>
                <Link
                  href={`/quotes/${q.id}`}
                  className="flex items-center justify-between px-5 py-3 hover:bg-slate-50"
                >
                  <div>
                    <div className="text-sm font-medium text-slate-900">{q.quote_number}</div>
                    <div className="text-xs text-slate-400">{formatDate(q.created_at)}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-slate-700">
                      {formatCurrency(q.total)}
                    </span>
                    <Badge tone={statusTone(q.status)}>{q.status}</Badge>
                  </div>
                </Link>
              </li>
            ))}
            {(!recentQuotes.data || recentQuotes.data.length === 0) && (
              <li className="px-5 py-8 text-center text-sm text-slate-400">
                No quotes yet.
              </li>
            )}
          </ul>
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-slate-900">Recent jobs</h3>
            <Link href="/jobs" className="flex items-center gap-1 text-xs text-brand hover:underline">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {(recentJobs.data ?? []).map((j) => (
              <li key={j.id}>
                <Link href={`/jobs/${j.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{j.name}</div>
                    <div className="text-xs text-slate-400">
                      {j.job_number} · {formatDate(j.scheduled_start)}
                    </div>
                  </div>
                  <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
                </Link>
              </li>
            ))}
            {(!recentJobs.data || recentJobs.data.length === 0) && (
              <li className="px-5 py-8 text-center text-sm text-slate-400">
                No jobs yet.
              </li>
            )}
          </ul>
        </Card>
      </div>
      </DashboardViewToggle>
    </div>
  );
}
