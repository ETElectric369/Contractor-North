import Link from "next/link";
import { Briefcase, FileText, Receipt, CalendarCheck, CheckCircle2, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { hoursBetween, formatDuration } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Item = {
  when: string;
  icon: "job" | "quote" | "invoice" | "appt" | "task" | "time";
  text: string;
  href?: string;
};

const ICONS = {
  job: { I: Briefcase, c: "text-brand bg-brand/10" },
  quote: { I: FileText, c: "text-amber-600 bg-amber-50" },
  invoice: { I: Receipt, c: "text-green-600 bg-green-50" },
  appt: { I: CalendarCheck, c: "text-purple-600 bg-purple-50" },
  task: { I: CheckCircle2, c: "text-green-600 bg-green-50" },
  time: { I: Clock, c: "text-slate-600 bg-slate-100" },
} as const;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default async function ActivityPage() {
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [jobs, quotes, invoices, appts, tasks, times] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(40),
    supabase.from("quotes").select("id, quote_number, status, total, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(40),
    supabase.from("invoices").select("id, invoice_number, status, total, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(40),
    supabase.from("appointments").select("id, type, title, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(40),
    supabase.from("tasks").select("id, title, completed_at").eq("status", "done").gte("completed_at", since).order("completed_at", { ascending: false }).limit(40),
    supabase.from("time_entries").select("id, job_id, clock_in, clock_out, lunch_minutes, status, profiles(full_name), jobs(name)").eq("status", "closed").gte("clock_out", since).order("clock_out", { ascending: false }).limit(40),
  ]);

  const items: Item[] = [];
  for (const j of jobs.data ?? []) items.push({ when: j.created_at as string, icon: "job", text: `Job created — ${j.job_number} ${j.name}`, href: `/jobs/${j.id}` });
  for (const q of quotes.data ?? []) items.push({ when: q.created_at as string, icon: "quote", text: `Quote ${q.quote_number} (${q.status})`, href: `/quotes/${q.id}` });
  for (const iv of invoices.data ?? []) items.push({ when: iv.created_at as string, icon: "invoice", text: `Invoice ${iv.invoice_number} (${iv.status})`, href: `/billing/${iv.id}` });
  for (const a of appts.data ?? []) items.push({ when: a.created_at as string, icon: "appt", text: `${a.type === "inspection" ? "Inspection" : "Appointment"} booked — ${a.title}`, href: `/schedule?view=appointments` });
  for (const t of (tasks.data ?? []) as any[]) if (t.completed_at) items.push({ when: t.completed_at, icon: "task", text: `Task done — ${t.title}` });
  for (const e of (times.data ?? []) as any[]) {
    if (!e.clock_out) continue;
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    const who = e.profiles?.full_name ?? "Crew";
    items.push({ when: e.clock_out, icon: "time", text: `${who} logged ${formatDuration(h)}${e.jobs?.name ? ` on ${e.jobs.name}` : ""}`, href: e.job_id ? `/jobs/${e.job_id}` : undefined });
  }

  items.sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());
  const feed = items.slice(0, 60);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Activity" description="Recent business activity across the shop — last 30 days." />

      {feed.length === 0 ? (
        <Card className="py-12 text-center text-sm text-slate-400">No recent activity.</Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {feed.map((it, i) => {
              const { I, c } = ICONS[it.icon];
              const inner = (
                <div className="flex items-center gap-3 px-5 py-3">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${c}`}>
                    <I className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{it.text}</span>
                  <span className="shrink-0 text-xs text-slate-400">{ago(it.when)}</span>
                </div>
              );
              return (
                <li key={i}>
                  {it.href ? <Link href={it.href} className="block hover:bg-slate-50">{inner}</Link> : inner}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
