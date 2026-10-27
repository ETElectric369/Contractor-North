import { revisionOf } from "@/lib/estimate/revision";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { smsReadiness } from "@/lib/sms";
import { partsKitsOnly, plainKitsReadWords, readTaskKits } from "@/lib/estimate/task-kits";
import { reportError } from "@/lib/observe";
import { BackLink } from "@/components/back-link";
import { getOrgSettings } from "@/lib/org-settings";
import { normalizeDocStyle } from "@/lib/doc-style";
import { quoteEditLock } from "../actions";
import { EstimateEditor, type SavedLineRow, type SavedQuoteRow } from "../estimate-editor";
import { extOf, intakePaths, uploadDisplayName } from "@/lib/playbook/uploads";
import { ITEM_OPTIONS_EMBED, ITEM_OPTIONS_UNAVAILABLE } from "@/lib/pricing/item-options";
import type { Customer } from "@/lib/types";
import { featureOn } from "@/lib/features";

export const dynamic = "force-dynamic";

/**
 * THE JOB THAT KEEPS THIS ESTIMATE'S CIRCUITS NOW (Panel plan, phase 2). The estimate's circuit
 * schedule is the proposal the customer signs; once a job exists, the job keeps its own list on its
 * Panel tab. That job is the estimate's own job, or else the job whose Panel brought these circuits
 * in (E-017 has no job of its own; J-011 brought it in). Only when the estimate has circuits. A
 * database without 0333 simply answers with no job, and the card says nothing extra.
 */
async function panelJobFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  q: { id: string; job_id?: string | null; circuits?: unknown },
): Promise<{ id: string; label: string } | null> {
  if (!Array.isArray(q.circuits) || q.circuits.length === 0) return null;
  let jobId = q.job_id ?? null;
  if (!jobId) {
    const { data, error } = await supabase.from("job_circuits").select("job_id").eq("source_quote_id", q.id).limit(1).maybeSingle();
    if (error || !data) return null;
    jobId = (data as { job_id: string }).job_id;
  }
  const { data: job } = await supabase.from("jobs").select("id, job_number, name").eq("id", jobId).maybeSingle();
  if (!job) return null;
  const j = job as { id: string; job_number: string | null; name: string | null };
  return { id: j.id, label: [j.job_number, j.name].filter(Boolean).join(" ") || "the job" };
}

/**
 * THE SAVED ESTIMATE (cn-v1132): the page READS — the row, its lines, the book, the kits, the team,
 * the switches, the lock — and hands all of it to THE one estimate editor in mode "saved". Every
 * door the page used to draw itself (the header, the customer card, the paper pill, the circuit
 * schedule, the ⋯ menu) is the editor's now, so the saved copy of an estimate has the same task
 * layout, the same pickers and the same words as the one the visit opened on /quotes/new.
 */
export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: quote, error: quoteErr } = await supabase
    .from("quotes")
    // pricing_levels nested INSIDE customers(*) — the star stays, because CustomerSelect's
    // `customer` prop needs the full row for EditCustomerButton. The level's LABOR RATE rides too
    // (cn-v1132): the editor prices a task's hours through the one rule, on this page as on the new one.
    // The lead's contact block rides along (PROJECTION LAW): the "Prepared for" card has to be
    // able to show WHO an estimate with no customer is for, and a lead is a person with a name,
    // a phone and an email — not a blank.
    .select("*, customers(*, pricing_levels(markup_pct, labor_rate)), inquiry:inquiry_id(id, name, company_name, email, phone, intake)")
    .eq("id", id)
    .maybeSingle();

  if (quoteErr) throw quoteErr; // a real failure shouldn't masquerade as 404
  if (!quote) notFound();
  const q = quote as SavedQuoteRow & {
    customers: (Customer & { pricing_levels?: { markup_pct?: number | null; labor_rate?: number | null } | null }) | null;
    inquiry: { id: string; name: string | null; company_name: string | null; email: string | null; phone: string | null; intake: unknown } | null;
  };

  // EVERY COLUMN THE EDITOR SHOWS (projection law): the words, the count, the price, the group
  // (category), the task behind the line (detail) and its place (sort_order).
  const { data: items } = await supabase.from("quote_line_items").select("*").eq("quote_id", id).order("sort_order");
  const lineItems = (items ?? []) as SavedLineRow[];

  // Has this quote already been turned into these records? (Drives idempotent UI: the map shows
  // "View …" instead of minting a duplicate.) Plus the org's customers, the book, the kits, the
  // team and the tax rates: the same catalog /quotes/new hands the editor.
  const [{ data: existingInv }, { data: existingWo }, { data: existingMl }, { data: customers }, { data: priceItems, error: priceItemsErr }, kitsRead, { data: orgRow }, { data: visitBehind }, { data: taxRates }, { data: peopleRows, error: peopleErr }] =
    await Promise.all([
      supabase.from("invoices").select("id").eq("quote_id", id).limit(1).maybeSingle(),
      supabase.from("work_orders").select("id").eq("quote_id", id).limit(1).maybeSingle(),
      supabase.from("material_lists").select("id").eq("quote_id", id).limit(1).maybeSingle(),
      supabase.from("customers").select("id, name, company_name").order("name"),
      // THE SAME CATALOG THE COMPOSER GETS, AND THE MAKERS UNDER EACH CODE (0282). The archived
      // filter lands on the EMBEDDED rows (no !inner), so an item keeps its place in the book even
      // when every maker under it has been retired.
      supabase
        .from("price_list_items")
        .select(`id, code, description, category, unit, buy_price, markup_pct, ${ITEM_OPTIONS_EMBED}`)
        .eq("archived", false)
        .eq("price_list_item_options.archived", false)
        .order("description")
        .limit(2000),
      // THE SHARED SELECT SHAPE (kit-line.ts) — the read SAYS how it went (cn-v1084).
      readTaskKits((sel) => supabase.from("kits").select(sel).order("name")),
      supabase.from("organizations").select("id, settings").limit(1).maybeSingle(),
      // THE VISIT THIS WAS WRITTEN UP FROM (cn-v1069): the backlink saveQuote stamps inside the visit's
      // capture, read back here so the two stay attached both ways. Newest first if ever two claim it.
      supabase
        .from("appointments")
        .select("id, starts_at, title")
        .eq("capture->>quote_id", id)
        .order("starts_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      // THE TEAM, for a labor row's Who select (cn-v1131): bill rates off the staff-scoped profile_pay
      // view, active only, never their pay rate.
      supabase.from("profile_pay").select("id, full_name, bill_rate").eq("active", true).order("full_name"),
    ]);
  if (peopleErr) reportError("quotes/[id]:people", peopleErr, { quoteId: id });
  const people = ((peopleRows ?? []) as { id: string; full_name: string | null; bill_rate: number | string | null }[]).map((p) => ({
    id: p.id,
    name: p.full_name ?? "Crew",
    billRate: p.bill_rate == null || p.bill_rate === "" ? null : Number(p.bill_rate),
  }));

  // THE SWITCH BOARD (0352), from the settings row already read: Kits off hides the kit chips (never
  // in catalog mode, where kits price the estimate: rule i), and Panel Map off hides an EMPTY circuit
  // schedule. An estimate that has circuits keeps them: they are on the proposal the customer signs.
  const org = orgRow as { id?: string; settings?: unknown } | null;
  const orgS = getOrgSettings(org?.settings);
  const kitDoors = featureOn(orgS.features, "kits") || orgS.estimating_mode === "catalog";
  const kits = kitsRead.rows as Parameters<typeof partsKitsOnly>[0] | null;
  if (kitsRead.state === "failed") reportError("quotes/[id]:kits", kitsRead.error, { quoteId: id });
  const showCircuits = featureOn(orgS.features, "panel_map") || (Array.isArray(q.circuits) && q.circuits.length > 0);
  const companyPaperFormat = normalizeDocStyle(orgS.doc_style).estimate_format;

  // Asked of the server rule itself, never guessed from the status: acceptance alone locks nothing,
  // so a status-only gate would have hidden controls that still work. null = every control stays
  // live. Read once: the editor shows its reason, and the Duplicate door follows it.
  const lock = await quoteEditLock(q.id);
  const kitsNote = kitDoors && !lock ? plainKitsReadWords(kitsRead) : null; // only where the picker is
  // The revision chain (0391): what this estimate revises, and — when it is superseded — the accepted
  // revision that replaced it (newest, if ever two).
  const revisesId = q.revises_quote_id ?? null;
  const [{ data: revisesRow }, { data: supersededRow }] = await Promise.all([
    revisesId ? supabase.from("quotes").select("id, quote_number, status").eq("id", revisesId).maybeSingle() : Promise.resolve({ data: null }),
    q.status === "superseded" ? revisionOf(supabase, { quoteId: q.id, orgId: null }).then((r) => ({ data: r })) : Promise.resolve({ data: null }),
  ]);
  const revises = revisesRow as { id: string; quote_number: string | null; status: string | null } | null;
  const supersededBy = supersededRow as { id: string; quote_number: string | null } | null;

  // The lead's own plan PDFs (intake uploads): one-tap take-off on this page too, no re-upload.
  const leadPlans = q.inquiry
    ? {
        leadId: q.inquiry.id,
        files: intakePaths(q.inquiry.intake)
          .filter((p) => extOf(p) === "pdf")
          .map((p) => ({ path: p, name: uploadDisplayName(p) })),
      }
    : undefined;

  return (
    <div>
      <BackLink fallback="/quotes" fallbackLabel="Back to Quotes" />

      {/* NOTHING SILENT. The picker inside the editor renders nothing at all when it is handed no
          book, which on this page reads as a broken control rather than a failed read — and an
          item whose makers did not arrive would price at its allowance for a window somebody had
          already decided was a Marvin. The editor keeps working either way; this only says what
          the list below is missing. */}
      {priceItemsErr && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">Price list didn&apos;t load</p>
          <p className="mt-0.5 text-sm text-amber-800">{ITEM_OPTIONS_UNAVAILABLE}</p>
        </div>
      )}
      {kitsNote && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">Kits didn&apos;t load whole</p>
          <p className="mt-0.5 text-sm text-amber-800">{kitsNote}</p>
        </div>
      )}
      <EstimateEditor
        mode="saved"
        saved={{
          quote: q,
          items: lineItems,
          lock,
          customer: q.customers ?? null,
          lead: q.inquiry ? { ...q.inquiry, intakePaths: intakePaths(q.inquiry.intake) } : null,
          customers: (customers ?? []) as { id: string; name: string; company_name: string | null }[],
          // `?? null` and never `?? 0`: effectiveMarkupPct returns immediately on ANY finite level,
          // including 0, so a 0 here would price every customer-without-a-level at net cost.
          level: { markup: q.customers?.pricing_levels?.markup_pct ?? null, rate: q.customers?.pricing_levels?.labor_rate ?? null },
          existing: { invoice: existingInv?.id ?? null, workOrder: existingWo?.id ?? null, materialList: existingMl?.id ?? null },
          revises,
          supersededBy,
          visitBehind: (visitBehind as { id: string; starts_at: string | null } | null) ?? null,
          showCircuits,
          panelJob: await panelJobFor(supabase, q),
        }}
        catalog={{
          orgId: String(org?.id ?? ""),
          priceItems: (priceItems ?? []) as never,
          kits: (kitDoors ? partsKitsOnly(kits ?? []) : []) as never,
          taskKits: kitsRead.kits,
          kitsOn: kitDoors,
          taxRates: (taxRates ?? []) as never,
          people,
          defaultMarkupPct: orgS.default_markup_pct,
          defaultLaborRate: orgS.default_labor_rate,
          companyEstimateFormat: companyPaperFormat,
          salesTax: featureOn(orgS.features, "sales_tax"),
          estimatorTaskMode: orgS.estimating_mode !== "catalog",
          leadPlans,
          textReady: smsReadiness(org).ready,
          estimatesOn: featureOn(orgS.features, "estimates"),
        }}
      />
    </div>
  );
}
