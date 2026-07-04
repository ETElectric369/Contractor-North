import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone, MapPin, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { NavLink } from "@/components/nav-link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { RowList } from "@/components/ui/row-list";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/tabs";
import { formatCurrency, formatCityStateZip, formatFullAddress } from "@/lib/utils";
import { EditCustomerButton } from "./edit-customer-button";
import { MergeCustomerButton } from "./merge-customer-button";
import { PortalLinkButton } from "./portal-link-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { customerSectionTree } from "@/lib/nav-tree";
import { NewJobButton } from "../../schedule/new-job-button";
import { AppointmentButton } from "../../appointments/appointment-button";
import { toJobOptions, toStaffOptions, listActiveTechs } from "@/lib/schedule-options";
import { deleteCustomer } from "../actions";
import type { Customer, Job, Quote } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: customer, error: customerErr } = await supabase
    .from("customers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (customerErr) throw customerErr; // a real failure shouldn't masquerade as 404
  if (!customer) notFound();
  const c = customer as Customer;

  // Viewer's role gates the staff-only verbs in the Actions menu (New quote/invoice),
  // matching the job page.
  const { data: { user } } = await supabase.auth.getUser();
  const { data: meRow } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  const viewerIsStaff = isStaffRole((meRow as any)?.role ?? "");

  const [{ data: jobs }, { data: quotes }, { data: invoices }, { data: pricingLevels }, { data: credits }, { data: staffRows }] = await Promise.all([
    supabase.from("jobs").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
    supabase.from("quotes").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
    supabase
      .from("invoices")
      .select("id, invoice_number, status, total")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    supabase.from("pricing_levels").select("id, name, markup_pct").order("created_at"),
    supabase
      .from("customer_credits")
      .select("amount, disposition, status")
      .eq("customer_id", id)
      .eq("status", "open"),
    // Assignee options for the New-appointment modal in the impulse row.
    listActiveTechs(supabase),
  ]);

  // The reverse of jobs.customer_id: jobs this contact is LINKED to as a sub / supplier / inspector
  // (so a subcontractor sees every job they're on, not just jobs where they're the client).
  const { data: linkedRaw } = await supabase
    .from("job_contacts")
    .select("id, role, jobs(id, job_number, name, status)")
    .eq("customer_id", id)
    .order("created_at", { ascending: false });
  const linkedJobs = (linkedRaw ?? [])
    .filter((r: any) => r.jobs)
    .map((r: any) => ({ linkId: r.id, role: r.role as string, ...(r.jobs as any) }));

  // Other customers in the org (RLS-scoped) — the pick-list for "Merge into…".
  // Staff-only, since merge is destructive (it deletes the source record).
  const { data: otherCustomers } = viewerIsStaff
    ? await supabase
        .from("customers")
        .select("id, name")
        .neq("id", id)
        .order("name")
    : { data: [] as { id: string; name: string }[] };

  const accountCredit = (credits ?? [])
    .filter((x: any) => x.disposition === "credit")
    .reduce((s: number, x: any) => s + Number(x.amount), 0);
  const refundPending = (credits ?? [])
    .filter((x: any) => x.disposition === "refund")
    .reduce((s: number, x: any) => s + Number(x.amount), 0);

  const empty = (label: string) => (
    <p className="px-1 py-6 text-center text-sm text-slate-400">No {label} yet.</p>
  );

  const tabs = [
    {
      id: "details",
      label: "Details",
      content: (
        <Card>
          <CardContent className="space-y-3 py-5 text-sm">
            {c.email ? (
              <a href={`mailto:${c.email}`} className="flex items-center gap-2 text-slate-600 hover:text-brand">
                <Mail className="h-4 w-4 text-slate-400" /> {c.email}
              </a>
            ) : null}
            {c.phone ? (
              <a href={`tel:${c.phone}`} className="flex items-center gap-2 text-slate-600 hover:text-brand">
                <Phone className="h-4 w-4 text-slate-400" /> {c.phone}
              </a>
            ) : null}
            {(c.address || c.city || c.state || c.zip) && (
              <NavLink
                address={formatFullAddress(c.address, c.city, c.state, c.zip)}
                className="flex items-start gap-2 text-slate-600 hover:text-brand"
              >
                <MapPin className="mt-0.5 h-4 w-4 text-slate-400" />
                <span>
                  {c.address}
                  {c.address && <br />}
                  {formatCityStateZip(c.city, c.state, c.zip)}
                </span>
              </NavLink>
            )}
            {c.notes && (
              <div className="border-t border-slate-100 pt-3 text-slate-500">{c.notes}</div>
            )}
            {!c.email && !c.phone && !c.address && !c.notes && (
              <p className="text-slate-400">No contact details yet — use Edit to add them.</p>
            )}
            {/* Maintenance verbs live WITH the details they maintain (moved out of
                the header impulse row): Edit + the portal link, and — staff-only,
                heavy-confirm — Merge, the cleanup verb for duplicate records. */}
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
              <EditCustomerButton customer={c} pricingLevels={(pricingLevels ?? []) as any} />
              <PortalLinkButton
                customerId={c.id}
                portalToken={(customer as any).portal_token}
                hasEmail={!!(customer as any).email}
              />
              {viewerIsStaff && (
                <MergeCustomerButton
                  customer={{ id: c.id, name: c.name }}
                  others={(otherCustomers ?? []) as { id: string; name: string }[]}
                />
              )}
            </div>
          </CardContent>
        </Card>
      ),
    },
    {
      id: "jobs",
      label: "Jobs",
      count: (jobs?.length ?? 0) + linkedJobs.length,
      content: (
        <Card className="overflow-hidden">
          <RowList
            items={((jobs as Job[] | null) ?? []).map((j) => ({
              key: j.id,
              label: j.name,
              sub: j.job_number,
              badge: { tone: statusTone(j.status), text: j.status.replace("_", " ") },
              href: `/jobs/${j.id}`,
            }))}
            empty={(!jobs || jobs.length === 0) && linkedJobs.length === 0 ? empty("jobs") : null}
          />
          {linkedJobs.length > 0 && (
            <>
              <div className="border-t border-slate-100 bg-slate-50 px-5 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Linked to (as a sub / contact)
              </div>
              <RowList
                items={linkedJobs.map((j: any) => ({
                  key: j.linkId,
                  label: j.name,
                  sub: `${j.job_number} · ${j.role}`,
                  badge: { tone: statusTone(j.status), text: String(j.status).replace("_", " ") },
                  href: `/jobs/${j.id}`,
                }))}
              />
            </>
          )}
        </Card>
      ),
    },
    {
      id: "quotes",
      label: "Estimates",
      count: quotes?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <RowList
            items={((quotes as Quote[] | null) ?? []).map((q) => ({
              key: q.id,
              label: q.quote_number,
              value: formatCurrency(q.total),
              badge: { tone: statusTone(q.status), text: q.status },
              href: `/quotes/${q.id}`,
            }))}
            empty={empty("estimates")}
          />
        </Card>
      ),
    },
    {
      id: "invoices",
      label: "Invoices",
      count: invoices?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <RowList
            items={(invoices ?? []).map((iv: any) => ({
              key: iv.id,
              label: iv.invoice_number,
              value: formatCurrency(iv.total),
              badge: { tone: statusTone(iv.status), text: iv.status },
              href: `/billing/${iv.id}`,
            }))}
            empty={empty("invoices")}
          />
        </Card>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/crm" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4 shrink-0" /> Back to Customers
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{c.name}</h1>
            <Badge tone={statusTone(c.status)}>{c.status === "lead" ? "inquiry" : c.status}</Badge>
          </div>
          {c.company_name && <p className="mt-1 text-sm text-slate-500">{c.company_name}</p>}
          <Badge tone="slate" className="mt-2">{c.type}</Badge>
        </div>
        {/* The impulse row: the gloves-on customer verbs (Call / New job / New
            estimate) plus the ⋯ Actions seek door, LAST — New invoice + Delete
            (danger). Edit / Portal / Merge moved into the Details tab, with the
            details they maintain. */}
        <div className="flex flex-wrap items-center gap-2">
          {c.phone && (
            <a
              href={`tel:${c.phone}`}
              className="btn-gloss inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[rgb(var(--glass-ink))] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[rgb(var(--glass-ink))]/90"
            >
              <Phone className="h-4 w-4 shrink-0" /> Call
            </a>
          )}
          <NewJobButton customers={[{ id: c.id, name: c.name }]} defaultCustomerId={c.id} />
          <AppointmentButton
            jobs={toJobOptions(jobs)}
            customers={[{ id: c.id, label: c.name }]}
            staff={toStaffOptions(staffRows)}
            defaultCustomerId={c.id}
          />
          <Link href={`/quotes/new?customer=${c.id}`}>
            <Button>
              <Plus className="h-4 w-4" /> New Estimate
            </Button>
          </Link>
          <SectionActionsMenu
            tree={customerSectionTree(
              c.name,
              {
                run: deleteCustomer.bind(null, c.id),
                confirm: `Delete ${c.name}? This only works when no jobs, estimates, or invoices reference them.`,
              },
              c.id, // → New invoice opens with this customer preset
            )}
            isStaff={viewerIsStaff}
          />
        </div>
      </div>

      {(accountCredit > 0 || refundPending > 0) && (
        <div className="mb-4 flex flex-wrap gap-3">
          {accountCredit > 0 && (
            <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-2.5">
              <div className="text-xs font-medium text-green-700">Account credit</div>
              <div className="text-xl font-bold text-green-900">{formatCurrency(accountCredit)}</div>
            </div>
          )}
          {refundPending > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
              <div className="text-xs font-medium text-amber-700">Refund pending (accounting)</div>
              <div className="text-xl font-bold text-amber-900">{formatCurrency(refundPending)}</div>
            </div>
          )}
        </div>
      )}

      <Tabs tabs={tabs} urlSync />
    </div>
  );
}
