import { cache } from "react";
import { notFound } from "next/navigation";
import { FileText, FileSignature, Receipt, Briefcase, ChevronRight } from "lucide-react";
import { createServiceClient } from "@/lib/supabase/server";
import { invoiceBalance } from "@/lib/invoice-math";
import { reportError } from "@/lib/observe";
import { portalHomeOrg, portalHomeRunning, type PortalHomeOrgRaw, type PortalHomeRunningRaw } from "@/lib/portal/home-shape";
import { formatCurrency, formatDate } from "@/lib/utils";
import { statusTone, toneClasses } from "@/components/ui/badge";
import { NO_INDEX } from "@/lib/no-index";
import { PortalNotice, PortalSection, PortalShell, PortalTurnedOff } from "@/components/portal/portal-shell";
import { portalJobStatus } from "@/components/portal/portal-format";
import { readPortalAccess } from "@/lib/portal/access";
import { gateTitle, portalGate, portalSignOut } from "./gate";

export const dynamic = "force-dynamic";
// Live on every load, and never kept by a shared cache (one customer's account per response).
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * THE LINK IS THE CREDENTIAL, AND ONLY THE OFFICE HOLDS IT (0298). customer_portal is no longer
 * runnable by anon or a signed-in member: the token lives in customer_portal_access, which only
 * office staff can read, and this page asks as the service role. The gate (does this token exist,
 * is it switched on) is INSIDE the function, so there is nothing here to forget.
 *
 * No host check, on purpose (tenant-isolation-root-cause): a 128-bit token names exactly one
 * customer, and links already sit in inboxes on whatever host they were sent from.
 *
 * cache(): generateMetadata and the page read the same thing once per request.
 *
 * A READ THAT FAILED IS NOT A LINK THAT DOESN'T EXIST (audit v994 SI3). customer_portal answers a
 * bad token with SQL null, so an error here is the database or the service key failing: every
 * customer opening an emailed link got a bare 404 and the office never heard. Now it is reported
 * (error_events) and the customer reads "couldn't load just now", as on the job page (readPortalJob).
 *
 * THE LINK IS NO LONGER THE WHOLE KEY (0331). Erik opened Andrew's link himself: "it opened right up
 * with no email verification". The link still names the customer, but a device must also be signed
 * in (a code emailed to the address on file) before this page reads anything: readPortalAccess, then
 * portalGate, first thing in the page AND in generateMetadata.
 */
type PortalData = {
  disabled?: boolean;
  customer?: { name?: string | null; company_name?: string | null } | null;
  /** 0323: glass_tint, so the home wears the org's own glass (DD2). */
  org?: PortalHomeOrgRaw;
  invoices?: any[];
  contracts?: any[];
  quotes?: any[];
  /** Since 0301 each job carries its id, so the list can open /portal/<token>/jobs/<id>. */
  jobs?: any[];
  /** 0323: each job's running bill (its draft bills), which the invoice list leaves out. */
  running?: PortalHomeRunningRaw[];
};
type PortalRead = { kind: "ok"; data: PortalData | null } | { kind: "error" };
const TOKEN = /^[0-9a-f]{32,128}$/i;
const readPortal = cache(async (token: string): Promise<PortalRead> => {
  // Not a link's shape: no such link, and no reason to ask the database.
  if (typeof token !== "string" || !TOKEN.test(token)) return { kind: "ok", data: null };
  const { data, error } = await createServiceClient().rpc("customer_portal", { p_token: token });
  if (error) {
    reportError("portal.home", error);
    return { kind: "error" };
  }
  return { kind: "ok", data: (data ?? null) as PortalData | null };
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // The door first (0331): a device that isn't signed in reads no customer row, not even for a title.
  const access = await readPortalAccess(token);
  const shut = gateTitle(access);
  if (shut) return { title: shut, robots: NO_INDEX };
  const r = await readPortal(token);
  const data = r.kind === "ok" ? r.data : null;
  const name = data?.org?.name;
  // NEVER indexed. This page fans out to EVERY document that customer has — crawling one
  // portal token would expose their whole invoice/quote/contract history. See @/lib/no-index.
  return {
    title: data?.disabled
      ? `${name ? `${name} — ` : ""}Link turned off`
      : name ? `${name} — Your account` : "Your account",
    robots: NO_INDEX,
  };
}

// Colors come from the ONE palette (statusTone → toneClasses); the portal no longer
// hand-rolls its own status→color map. NB this now follows the app: 'sent' reads blue
// (was amber here), paid/signed/accepted green, overdue red, partial amber.
const statusColor = (s: string): string => toneClasses(statusTone(s));

export default async function CustomerPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ look?: string }>;
}) {
  const { token } = await params;
  const { look } = await searchParams;
  // THE DOOR (0331): not signed in on this device → the sign-in screen, and nothing is read.
  const access = await readPortalAccess(token);
  const shut = portalGate(access, token);
  if (shut) return shut;
  const r = await readPortal(token);
  if (r.kind === "error") {
    return (
      <PortalNotice title="This page couldn't load just now.">
        Pull down or reload to try again in a minute.
      </PortalNotice>
    );
  }
  const data = r.data;
  if (data?.disabled) return <PortalTurnedOff orgName={data.org?.name ?? null} />;
  if (!data || !data.customer) notFound();

  const org = portalHomeOrg(data.org ?? null);
  const running = portalHomeRunning(data.running);
  const invoices = data.invoices ?? [];
  const contracts = data.contracts ?? [];
  const quotes = data.quotes ?? [];
  const jobs = data.jobs ?? [];
  // The office's See What They See arrives on an office session (0331); ?look=office rides along on
  // its links. Last Opened is stamped by portal_session_check for a customer's own session only, so
  // neither a link preview (no session) nor the office's look reads as "they opened it".
  const office = access.kind === "in" && access.session === "office" ? true : look === "office";

  return (
    <PortalShell org={org} footer={portalSignOut(access, token)}>
      <h1 className="mb-1 px-1 text-2xl font-bold text-slate-900">
        Welcome{data.customer.name ? `, ${data.customer.name}` : ""}
      </h1>
      <p className="mb-2 px-1 text-sm text-slate-700">Your jobs and papers with {org.name}, up to date every time you open this page.</p>

      {/* Jobs first: each one opens its own page (work and payments, picks, photos, the bill). */}
      {jobs.length > 0 && (
        <PortalSection id="jobs" title="Your Jobs" icon={<Briefcase className="h-4 w-4" />}>
          <ul className="space-y-2">
            {jobs.map((j: any, idx: number) => (
              <li key={j.id ?? idx}>
                {j.id ? (
                  <a
                    href={`/portal/${token}/jobs/${j.id}${office ? "?look=office" : ""}`}
                    rel="nofollow"
                    className="portal-glass flex min-h-[56px] items-center gap-3 rounded-2xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-slate-900">{j.name}</span>
                      <span className="block text-sm text-slate-700">
                        {[j.job_number, portalJobStatus(j.status)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-[rgb(var(--glass-ink))]">
                      Open <ChevronRight className="h-4 w-4" aria-hidden />
                    </span>
                  </a>
                ) : (
                  <div className="portal-glass flex min-h-[56px] items-center gap-3 rounded-2xl px-4 py-3">
                    <span className="min-w-0 flex-1 truncate font-semibold text-slate-900">{j.name}</span>
                    <span className="text-sm text-slate-700">{portalJobStatus(j.status)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </PortalSection>
      )}

      {(invoices.length > 0 || running.length > 0) && (
        <PortalSection id="invoices" title="Bills" icon={<Receipt className="h-4 w-4" />}>
          <ul className="portal-glass divide-y divide-slate-200/70 overflow-hidden rounded-2xl">
            {/* A running bill (a draft the office keeps adding to) is not a bill yet, so it has no
                pay door here: it opens the job page, where the work and payments so far are. */}
            {running.map((rb) => (
              <Row
                key={`running-${rb.jobId}`}
                href={`/portal/${token}/jobs/${rb.jobId}${office ? "?look=office" : ""}`}
                sameTab
                label={rb.name}
                sub={`Running total, not a bill yet · ${
                  rb.balance < -0.005 ? `${formatCurrency(-rb.balance)} paid ahead` : `${formatCurrency(rb.balance)} left`
                }`}
                cta="See The Work"
              />
            ))}
            {invoices.map((i: any) => {
              const bal = invoiceBalance(i.total, i.amount_paid);
              return (
                <Row
                  key={i.public_token}
                  href={`/i/${i.public_token}`}
                  label={i.invoice_number}
                  sub={`${formatDate(i.created_at)} · ${bal > 0.005 ? `${formatCurrency(bal)} due` : "Paid"}`}
                  status={i.status}
                  cta={bal > 0.005 ? "View And Pay" : "View"}
                />
              );
            })}
          </ul>
        </PortalSection>
      )}

      {contracts.length > 0 && (
        <PortalSection id="contracts" title="Contracts" icon={<FileSignature className="h-4 w-4" />}>
          <ul className="portal-glass divide-y divide-slate-200/70 overflow-hidden rounded-2xl">
            {contracts.map((ct: any) => (
              <Row
                key={ct.public_token}
                href={`/c/${ct.public_token}`}
                label={ct.contract_number}
                sub={ct.signed_at ? `Signed ${formatDate(ct.signed_at)}` : "Waiting for your signature"}
                status={ct.status}
                cta={ct.status === "signed" ? "View" : "Read And Sign"}
              />
            ))}
          </ul>
        </PortalSection>
      )}

      {quotes.length > 0 && (
        <PortalSection id="quotes" title="Quotes And Estimates" icon={<FileText className="h-4 w-4" />}>
          <ul className="portal-glass divide-y divide-slate-200/70 overflow-hidden rounded-2xl">
            {quotes.map((q: any) => (
              <Row
                key={q.public_token}
                href={`/q/${q.public_token}`}
                label={q.quote_number}
                sub={`${q.doc_type === "estimate" ? "Estimate" : "Quote"} · ${formatCurrency(q.total)}`}
                status={q.status}
                cta={q.status === "accepted" ? "View" : "Read And Accept"}
              />
            ))}
          </ul>
        </PortalSection>
      )}

      {invoices.length === 0 && running.length === 0 && contracts.length === 0 && quotes.length === 0 && jobs.length === 0 && (
        <div className="portal-glass mt-4 rounded-2xl px-6 py-10 text-center text-sm text-slate-700">
          Nothing to show yet. Your jobs and papers will show here as they are sent to you.
        </div>
      )}
    </PortalShell>
  );
}


function Row({
  href,
  label,
  sub,
  status,
  cta,
  sameTab = false,
}: {
  href: string;
  label: string;
  sub: string;
  /** No status chip when there is none to say (a running bill says so in its own words). */
  status?: string;
  cta: string;
  /** A page of this portal (a job) opens in place, like the jobs list; a paper opens in a new tab. */
  sameTab?: boolean;
}) {
  return (
    <li>
      {/* nofollow: the portal links out to every sibling token document, so a crawler that ever
          reaches one portal URL must not fan out across the customer's whole document history. */}
      <a
        href={href}
        target={sameTab ? undefined : "_blank"}
        rel={sameTab ? "nofollow" : "noopener nofollow"}
        className="flex min-h-[56px] items-center justify-between gap-3 px-4 py-3 hover:bg-white/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900">{label}</span>
            {status ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColor(status)}`}>{status}</span> : null}
          </div>
          <div className="truncate text-sm text-slate-700">{sub}</div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-[rgb(var(--glass-ink))]">
          {cta} <ChevronRight className="h-4 w-4" aria-hidden />
        </span>
      </a>
    </li>
  );
}
