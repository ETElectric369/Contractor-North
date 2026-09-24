import { cache } from "react";
import { notFound } from "next/navigation";
import { FileText, FileSignature, Receipt, Briefcase } from "lucide-react";
import { createServiceClient } from "@/lib/supabase/server";
import { invoiceBalance } from "@/lib/invoice-math";
import { accentHex } from "@/lib/org-settings";
import { formatCurrency, formatDate } from "@/lib/utils";
import { statusTone, toneClasses } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { NO_INDEX } from "@/lib/no-index";
import { OpenedBeacon } from "./opened-beacon";

export const dynamic = "force-dynamic";

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
 */
type PortalData = {
  disabled?: boolean;
  customer?: { name?: string | null; company_name?: string | null } | null;
  org?: { name?: string | null; logo_url?: string | null; phone?: string | null; email?: string | null; license?: string | null; glass_tint?: string } | null;
  invoices?: any[];
  contracts?: any[];
  quotes?: any[];
  jobs?: any[];
};
const readPortal = cache(async (token: string): Promise<PortalData | null> => {
  const { data, error } = await createServiceClient().rpc("customer_portal", { p_token: token });
  if (error) return null;
  return (data ?? null) as PortalData | null;
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await readPortal(token);
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
  const data = await readPortal(token);
  if (data?.disabled) return <TurnedOff orgName={data.org?.name ?? null} />;
  if (!data || !data.customer) notFound();

  const org = data.org ?? {};
  const brand = accentHex((org as { glass_tint?: string }).glass_tint);
  const invoices = data.invoices ?? [];
  const contracts = data.contracts ?? [];
  const quotes = data.quotes ?? [];
  const jobs = data.jobs ?? [];

  return (
    <div className="min-h-screen bg-slate-100 py-8">
      {/* Last Opened: stamped from the customer's own browser, so a mail scanner or a link preview
          that never runs the page doesn't read as "they opened it". The office's own look
          (See What They See adds ?look=office) doesn't count either. */}
      {look !== "office" && <OpenedBeacon token={token} />}
      <div className="mx-auto max-w-2xl px-4">
        {/* Branded header */}
        <div className="mb-5 flex items-center gap-3 rounded-2xl px-6 py-5 text-white shadow-sm" style={{ backgroundColor: brand }}>
          {org.logo_url ? (
            <img src={org.logo_url} alt={org.name ?? ""} className="h-12 w-auto max-w-[160px] rounded bg-white p-1 object-contain" />
          ) : null}
          <div>
            <div className="text-xl font-bold">{org.name ?? "Your contractor"}</div>
            <div className="text-xs text-white/80">
              {[org.phone, org.email].filter(Boolean).join(" · ")}
              {org.license ? ` · Lic ${org.license}` : ""}
            </div>
          </div>
        </div>

        <h1 className="mb-4 px-1 text-lg font-semibold text-slate-900">
          Welcome{data.customer.name ? `, ${data.customer.name}` : ""}
        </h1>

        {/* Invoices */}
        {invoices.length > 0 && (
          <Section icon={<Receipt className="h-4 w-4" />} title="Invoices" brand={brand}>
            {invoices.map((i: any) => {
              const bal = invoiceBalance(i.total, i.amount_paid);
              return (
                <Row
                  key={i.public_token}
                  href={`/i/${i.public_token}`}
                  label={i.invoice_number}
                  sub={`${formatDate(i.created_at)} · ${bal > 0.005 ? `${formatCurrency(bal)} due` : "paid"}`}
                  status={i.status}
                  cta={bal > 0.005 ? "View / Pay" : "View"}
                  brand={brand}
                />
              );
            })}
          </Section>
        )}

        {/* Contracts */}
        {contracts.length > 0 && (
          <Section icon={<FileSignature className="h-4 w-4" />} title="Contracts" brand={brand}>
            {contracts.map((ct: any) => (
              <Row
                key={ct.public_token}
                href={`/c/${ct.public_token}`}
                label={ct.contract_number}
                sub={ct.signed_at ? `Signed ${formatDate(ct.signed_at)}` : "Awaiting your signature"}
                status={ct.status}
                cta={ct.status === "signed" ? "View" : "Review & sign"}
                brand={brand}
              />
            ))}
          </Section>
        )}

        {/* Quotes / estimates */}
        {quotes.length > 0 && (
          <Section icon={<FileText className="h-4 w-4" />} title="Quotes & estimates" brand={brand}>
            {quotes.map((q: any) => (
              <Row
                key={q.public_token}
                href={`/q/${q.public_token}`}
                label={q.quote_number}
                sub={`${q.doc_type === "estimate" ? "Estimate" : "Quote"} · ${formatCurrency(q.total)}`}
                status={q.status}
                cta={q.status === "accepted" ? "View" : "Review & accept"}
                brand={brand}
              />
            ))}
          </Section>
        )}

        {/* Jobs (read-only status) */}
        {jobs.length > 0 && (
          <Section icon={<Briefcase className="h-4 w-4" />} title="Your jobs" brand={brand}>
            {jobs.map((j: any, idx: number) => (
              <div key={idx} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 truncate text-slate-800">{j.name}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColor(j.status)}`}>
                  {jobStatusLabel(String(j.status))}
                </span>
              </div>
            ))}
          </Section>
        )}

        {invoices.length === 0 && contracts.length === 0 && quotes.length === 0 && jobs.length === 0 && (
          <div className="rounded-2xl bg-white px-6 py-10 text-center text-sm text-slate-500 shadow-sm">
            Nothing to show yet. Your documents will appear here as they&apos;re sent to you.
          </div>
        )}

        <p className="mt-6 px-1 text-center text-xs text-slate-400">
          Questions? Contact {org.name ?? "us"}{org.phone ? ` at ${org.phone}` : ""}.
        </p>
      </div>
    </div>
  );
}

/** A link the office turned off or replaced. Plain words, and who to ask — never a dead 404 for a
 *  customer who was sent this link on purpose. */
function TurnedOff({ orgName }: { orgName: string | null }) {
  return (
    <div className="min-h-screen bg-slate-100 py-16">
      <div className="mx-auto max-w-md px-4">
        <div className="rounded-2xl bg-white px-6 py-10 text-center shadow-sm">
          <p className="text-base font-medium text-slate-900">
            This link was turned off. Ask {orgName || "the business that sent it"} for a new one.
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, brand, children }: { icon: React.ReactNode; title: string; brand: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 overflow-hidden rounded-2xl bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700">
        <span style={{ color: brand }}>{icon}</span>
        {title}
      </div>
      <div className="divide-y divide-slate-100">{children}</div>
    </div>
  );
}

function Row({ href, label, sub, status, cta, brand }: { href: string; label: string; sub: string; status: string; cta: string; brand: string }) {
  return (
    // nofollow: the portal links out to every sibling token document, so a crawler that ever
    // reaches one portal URL must not fan out across the customer's whole document history.
    <a href={href} target="_blank" rel="noopener nofollow" className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-900">{label}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColor(status)}`}>{status}</span>
        </div>
        <div className="truncate text-xs text-slate-500">{sub}</div>
      </div>
      <span className="shrink-0 text-sm font-semibold" style={{ color: brand }}>{cta} →</span>
    </a>
  );
}
