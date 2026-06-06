import Link from "next/link";
import {
  Users,
  FileText,
  ClipboardList,
  Clock,
  ArrowRight,
  DollarSign,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate, hoursBetween } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Pull a handful of counts + recents in parallel.
  const [customers, openQuotes, activeJobs, recentQuotes, recentJobs, myOpen] =
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
    ]);

  const pipeline =
    openQuotes.data?.reduce((sum, q) => sum + Number(q.total ?? 0), 0) ?? 0;

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
      href: "/work-orders",
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

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Your business at a glance."
      />

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
            <Link href="/work-orders" className="flex items-center gap-1 text-xs text-brand hover:underline">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {(recentJobs.data ?? []).map((j) => (
              <li key={j.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium text-slate-900">{j.name}</div>
                  <div className="text-xs text-slate-400">
                    {j.job_number} · {formatDate(j.scheduled_start)}
                  </div>
                </div>
                <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
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
    </div>
  );
}
