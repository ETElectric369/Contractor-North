import Link from "next/link";
import { MapPin, ClipboardCheck, CalendarClock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSchedulePickerOptions } from "@/lib/schedule-options";
import { NavLink } from "@/components/nav-link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AppointmentButton, type ApptValue } from "../appointments/appointment-button";
import { ApptQuickActions } from "../appointments/appointment-status";

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Appointments & inspections view of the unified Schedule hub (was /appointments). */
export async function AppointmentsPanel() {
  const supabase = await createClient();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);

  const [{ data: appts }, { jobOpts, custOpts, staffOpts }] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to, jobs(job_number, name), customers(name), profiles!appointments_assigned_to_fkey(full_name)")
      .gte("starts_at", startToday.toISOString())
      .neq("status", "cancelled")
      .order("starts_at"),
    getSchedulePickerOptions(supabase),
  ]);

  // Group by day.
  const byDay = new Map<string, any[]>();
  for (const a of appts ?? []) {
    const k = fmtDay(a.starts_at as string);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(a);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex justify-end">
        <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} />
      </div>

      {(appts ?? []).length === 0 ? (
        <Card className="py-12 text-center text-sm text-slate-400">
          Nothing scheduled. Tap <span className="font-medium text-slate-600">New appointment</span> to add a site visit or inspection.
        </Card>
      ) : (
        <div className="space-y-5">
          {[...byDay.entries()].map(([day, rows]) => (
            <div key={day}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{day}</div>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-slate-100">
                  {rows.map((a: any) => {
                    const appt: ApptValue = {
                      id: a.id, type: a.type, title: a.title, starts_at: a.starts_at, ends_at: a.ends_at,
                      job_id: a.job_id, customer_id: a.customer_id, location: a.location, notes: a.notes, assigned_to: a.assigned_to,
                    };
                    return (
                      <li key={a.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                        <div className="w-16 shrink-0 text-sm font-medium text-slate-700">{fmtTime(a.starts_at)}{a.ends_at ? <span className="block text-[11px] font-normal text-slate-400">{fmtTime(a.ends_at)}</span> : null}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Badge tone={a.type === "inspection" ? "amber" : "blue"}>
                              {a.type === "inspection" ? <ClipboardCheck className="mr-1 inline h-3 w-3" /> : <CalendarClock className="mr-1 inline h-3 w-3" />}
                              {a.type}
                            </Badge>
                            <span className="truncate text-sm font-medium text-slate-900">{a.title}</span>
                            {a.status === "completed" && <Badge tone="green">done</Badge>}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                            {a.customers?.name && <span>{a.customers.name}</span>}
                            {a.jobs && <Link href={`/jobs/${a.job_id}`} className="text-brand hover:underline">{a.jobs.job_number} {a.jobs.name}</Link>}
                            {a.profiles?.full_name && <span>· {a.profiles.full_name}</span>}
                            {a.location && (
                              <NavLink address={a.location} className="inline-flex items-center gap-0.5 text-brand hover:underline">
                                <MapPin className="h-3 w-3" /> {a.location}
                              </NavLink>
                            )}
                          </div>
                          {a.notes && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-slate-500">{a.notes}</p>}
                        </div>
                        <div className="flex items-center gap-1">
                          <ApptQuickActions id={a.id} status={a.status} />
                          <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} appointment={appt} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
