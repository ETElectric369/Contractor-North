import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { switchesFromRow } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";
import { notFound } from "next/navigation";
import { Mail, Phone, MapPin, Plus } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { NavLink } from "@/components/nav-link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { RowList } from "@/components/ui/row-list";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/tabs";
import { formatCurrency, formatCityStateZip, formatFullAddress } from "@/lib/utils";
import { InvoiceAmount, InvoiceAmountDetail } from "@/components/invoice-amount";
import { EditCustomerButton } from "./edit-customer-button";
import { MergeCustomerButton } from "./merge-customer-button";
import { PortalLinkButton } from "./portal-link-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { customerSectionTree } from "@/lib/nav-tree";
import { NewJobButton } from "../../schedule/new-job-button";
import { FIXED_PILL_CLASS, isFixedPrice } from "@/lib/doc-label";
import { AppointmentButton } from "../../appointments/appointment-button";
import { toJobOptions, toStaffOptions, listActiveTechs, readUsualBillingKind, unitStreetKeys } from "@/lib/schedule-options";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { deleteCustomer } from "../actions";
import type { Customer, Job, Quote } from "@/lib/types";
import { countOpen, isOpenInvoice, isOpenJob, isOpenQuote } from "@/lib/open-counts";

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
  // 0298 empties customers.portal_token; until that migration is applied this row still carries it,
  // and the row goes to EditCustomerButton in the browser for techs too. Never pass it on.
  const { portal_token: _portalToken, ...row } = customer as Customer & { portal_token?: string | null };
  void _portalToken;
  const c = row as Customer;

  // Viewer's role gates the staff-only verbs in the Actions menu (New quote/invoice),
  // matching the job page.
  const { data: { user } } = await supabase.auth.getUser();
  // The company's switches ride the same row (the switch board, 0352): Estimates off hides New
  // Estimate, Customer Portal off hides the portal link card. No extra round trip.
  const { data: meRow } = await supabase.from("profiles").select("role, active, organizations(settings)").eq("id", user?.id ?? "").maybeSingle();
  const viewerIsStaff = isStaffRole((meRow as any)?.role ?? "");
  const sw = switchesFromRow(meRow);
  // The company's settings off the same embed: New Job's clock (its timezone and work-day start).
  const orgEmbed = (meRow as { organizations?: unknown } | null)?.organizations;
  const orgSettingsRaw = ((Array.isArray(orgEmbed) ? orgEmbed[0] : orgEmbed) as { settings?: unknown } | null | undefined)?.settings;

  // ONE ROUND, NOT THREE (audit v921). The linked-jobs read depends only on `id` and the merge
  // pick-list only on viewerIsStaff — both already known — so they waited behind this batch for
  // nothing: two extra serial round trips on every contact open. And the two select("*")s shipped
  // columns nothing here renders (the job's description/notes, the estimate's circuits jsonb);
  // PROJECTION LAW cuts both ways — ask for the fields the tabs actually classify on.
  const [
    { data: jobs },
    { data: quotes },
    { data: invoices },
    { data: pricingLevels },
    { data: credits },
    { data: staffRows },
    { data: linkedRaw },
    { data: otherCustomers },
    { data: portalRow },
    { data: portalDevices },
    usualBilling,
  ] = await Promise.all([
    supabase
      .from("jobs")
      // address parts ride along for the appointment picker's site prefill (toJobOptions); the unit
      // for New Job's "another job here has a unit" hint.
      .select("id, name, job_number, status, address, city, state, zip, unit")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("quotes")
      // doc_type: the Estimates tab's Fixed chip (W1-25) turns on it (projection law).
      .select("id, quote_number, total, status, doc_type")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("invoices")
      .select("id, invoice_number, status, total, amount_paid")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    // A markup is a price: a tech never gets it (and has no Edit to pick one with).
    viewerIsStaff
      ? supabase.from("pricing_levels").select("id, name, markup_pct").order("created_at")
      : Promise.resolve({ data: [] as { id: string; name: string; markup_pct: number }[] }),
    supabase
      .from("customer_credits")
      .select("amount, disposition, status")
      .eq("customer_id", id)
      .eq("status", "open"),
    // Assignee options for the New-appointment modal in the impulse row.
    listActiveTechs(supabase),
    // The reverse of jobs.customer_id: jobs this contact is LINKED to as a sub / supplier /
    // inspector (so a subcontractor sees every job they're on, not just jobs where they're the client).
    supabase
      .from("job_contacts")
      .select("id, role, jobs(id, job_number, name, status)")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    // Other customers in the org (RLS-scoped) — the pick-list for "Merge into…".
    // Staff-only, since merge is destructive (it deletes the source record).
    viewerIsStaff
      ? supabase.from("customers").select("id, name").neq("id", id).order("name")
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    // The customer's portal link. Office only: the table's RLS already gives a tech nothing, and
    // the card isn't rendered for one either (0298).
    viewerIsStaff
      ? supabase
          .from("customer_portal_access")
          .select("token, enabled, last_opened_at")
          .eq("customer_id", id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // "Signed in on N devices" (0331). Staff of this org only, inside the function too. A failed
    // read leaves the count off the card (null), never a made-up 0.
    viewerIsStaff
      ? supabase.rpc("portal_link_devices", { p_customer_id: id }).then(
          (r) => ({ data: r.error ? null : (r.data as { devices?: number } | null) }),
          () => ({ data: null }),
        )
      : Promise.resolve({ data: null }),
    // New Job's Billing starts at the kind most of this company's jobs use (office only: New Job is).
    viewerIsStaff ? readUsualBillingKind(supabase) : Promise.resolve("tm" as const),
  ]);
  const deviceCount = Number(portalDevices?.devices);
  // CUSTOMER PORTAL OFF (0352, rule f): the office's link controls aren't drawn. The link row is
  // untouched, and the invoice pay link never depended on it.
  const portalOn = featureOn(sw.features, "customer_portal");
  const portal = portalRow
    ? {
        token: (portalRow as { token: string }).token,
        enabled: (portalRow as { enabled: boolean }).enabled,
        lastOpenedAt: (portalRow as { last_opened_at: string | null }).last_opened_at ?? null,
        devices: portalDevices && Number.isFinite(deviceCount) ? deviceCount : null,
      }
    : null;

  const linkedJobs = (linkedRaw ?? [])
    .filter((r: any) => r.jobs)
    .map((r: any) => ({ linkId: r.id, role: r.role as string, ...(r.jobs as any) }));

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
              <p className="text-slate-400">{viewerIsStaff ? "No contact details yet — use Edit to add them." : "No contact details yet."}</p>
            )}
            {/* Maintenance verbs live WITH the details they maintain (moved out of
                the header impulse row): Edit, and — staff-only, heavy-confirm — Merge,
                the cleanup verb for duplicate records. The portal link card below is
                staff-only too (0298: a tech never sees the link or its switches). */}
            {/* Edit Customer is requireStaff: a tech reads the details, the office changes them. */}
            {viewerIsStaff && (
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                <EditCustomerButton customer={c} pricingLevels={(pricingLevels ?? []) as any} />
                <MergeCustomerButton
                  customer={{ id: c.id, name: c.name }}
                  others={(otherCustomers ?? []) as { id: string; name: string }[]}
                />
              </div>
            )}
            {viewerIsStaff && portalOn && (
              <div className="border-t border-slate-100 pt-3">
                <PortalLinkButton
                  customerId={c.id}
                  customerName={c.name}
                  initial={portal}
                  hasEmail={!!c.email?.trim()}
                  addEmailDoor={
                    <EditCustomerButton customer={c} pricingLevels={(pricingLevels ?? []) as any} label="Add Their Email" />
                  }
                />
              </div>
            )}
          </CardContent>
        </Card>
      ),
    },
    {
      id: "jobs",
      label: "Jobs",
      // Jobs still in flight (Erik, 2026-09-27: "all badges only show whats open"), never how many
      // this customer has ever had; the linked ones (as a sub / contact) count the same way.
      count: countOpen([...((jobs ?? []) as { status?: string | null }[]), ...(linkedJobs as { status?: string | null }[])], (j) => isOpenJob(j.status)),
      content: (
        <Card className="overflow-hidden">
          <RowList
            items={((jobs as Job[] | null) ?? []).map((j) => ({
              key: j.id,
              label: j.name,
              sub: j.job_number,
              badge: { tone: statusTone(j.status), text: jobStatusLabel(j.status) },
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
                  badge: { tone: statusTone(j.status), text: jobStatusLabel(String(j.status)) },
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
      // A draft to send, or sent and waiting on the customer.
      count: countOpen((quotes ?? []) as { status?: string | null }[], (q) => isOpenQuote(q.status)),
      content: (
        <Card className="overflow-hidden">
          <RowList
            items={((quotes as Quote[] | null) ?? []).map((q) => ({
              key: q.id,
              // THE FIXED CHIP (W1-25): fixed-price rows only; Time & Material wears nothing.
              label: (
                <>
                  {q.quote_number}
                  {isFixedPrice(q) && <span className={FIXED_PILL_CLASS}>Fixed</span>}
                </>
              ),
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
      // Still owed: a draft not sent, or sent with a balance.
      count: countOpen((invoices ?? []) as any[], isOpenInvoice),
      content: (
        <Card className="overflow-hidden">
          <RowList
            items={(invoices ?? []).map((iv: any) => {
              // The billing board's amount, the same component: "$D due of $T" on one line with
              // what is paid beneath — on the right from sm up, under the invoice number on a
              // phone. A bare total here read as a different bill from the same invoice on the board.
              return {
                key: iv.id,
                label: iv.invoice_number,
                sub: <InvoiceAmountDetail total={iv.total} paid={iv.amount_paid} status={iv.status} />,
                value: <InvoiceAmount total={iv.total} paid={iv.amount_paid} status={iv.status} />,
                badge: { tone: statusTone(iv.status), text: iv.status },
                href: `/billing/${iv.id}`,
              };
            })}
            empty={empty("invoices")}
          />
        </Card>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink fallback="/crm" fallbackLabel="Back to Customers" />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{c.name}</h1>
            {/* "Lead", not "inquiry" — the nav says Leads and the table says lead; a third word for the
                same thing on the one page where it is most prominent was its own small confusion.
                And it is now TRUE: 0228 promotes a customer to active the moment they get a job,
                an accepted estimate or an invoice, so this can no longer say "lead" about somebody
                who has paid you (Lorraine Lim, $8,706, read "Inquiry" until tonight). */}
            <Badge tone={statusTone(c.status)}>{c.status === "lead" ? "lead" : c.status}</Badge>
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
          {/* New Job, Appointment and New Estimate all save through requireStaff: a tech gets Call. */}
          {viewerIsStaff && (
            <>
              <NewJobButton
                customers={[
                  {
                    id: c.id,
                    name: c.name,
                    address: formatFullAddress(c.address, c.city, c.state, c.zip) || null,
                    // The parts, so the street box gets the street and the rest ride hidden (W1-22),
                    // and the name line calls a business by its name.
                    company_name: c.company_name ?? null,
                    type: c.type ?? null,
                    street: c.address ?? null,
                    city: c.city ?? null,
                    state: c.state ?? null,
                    zip: c.zip ?? null,
                  },
                ]}
                defaultCustomerId={c.id}
                // The company's clock, its usual billing, and this customer's streets with a unit.
                workDay={workDayWindowHm(orgSettingsRaw)}
                todayStr={todayStrInTz(getOrgSettings(orgSettingsRaw).timezone)}
                usualBilling={usualBilling}
                unitStreets={unitStreetKeys((jobs ?? []) as { address?: string | null; unit?: string | null }[])}
              />
              <AppointmentButton
                jobs={toJobOptions(jobs)}
                customers={[{ id: c.id, label: c.name }]}
                staff={toStaffOptions(staffRows)}
                defaultCustomerId={c.id}
              />
              {featureOn(sw.features, "estimates") && (
                <Link href={`/quotes/new?customer=${c.id}`}>
                  <Button>
                    <Plus className="h-4 w-4" /> New Estimate
                  </Button>
                </Link>
              )}
            </>
          )}
          <SectionActionsMenu
            tree={customerSectionTree(
              c.name,
              {
                // confirmOrphans: the string below names the SET NULL tail this delete
                // orphans, so the user has actually seen it before agreeing. Programmatic
                // callers omit the flag and get the itemized refusal instead.
                run: deleteCustomer.bind(null, c.id, { confirmOrphans: true }),
                confirm:
                  `Delete ${c.name}? Only possible when nothing important still points at them — ` +
                  `jobs, estimates, invoices, contracts, account credits, or a link to a job as a ` +
                  `sub/supplier all block it. Appointments, documents, work orders and inquiries ` +
                  `survive but lose their contact.`,
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

      {/* Estimates and invoices are prices: a tech sees the customer's jobs, not what they cost. */}
      <Tabs tabs={viewerIsStaff ? tabs : tabs.filter((t) => t.id !== "quotes" && t.id !== "invoices")} urlSync />
    </div>
  );
}
