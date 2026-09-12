import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { firstThatWorks, kitsSelectRungs } from "@/lib/kit-line";
import { BackLink } from "@/components/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { StatusControl } from "./status-control";
import { getOrgSettings } from "@/lib/org-settings";
import { QuoteItemsEditor } from "./quote-items-editor";
import { CircuitScheduleCard } from "./circuit-schedule-card";
import { CustomerSelect } from "./customer-select";
import { DuplicateQuoteButton } from "./duplicate-quote-button";
import { EmailButton } from "@/components/email-button";
import { ShareIconButton } from "@/components/share-icon-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { QuoteTypeToggle } from "./quote-type-toggle";
import type { NavTree } from "@/lib/nav-tree";
import { createJobFromQuote, deleteQuote, quoteShareText } from "../actions";
import { createMaterialListFromQuote } from "../../materials/actions";
import { createWorkOrderFromQuote } from "../../work-orders/actions";
import { createInvoiceFromQuote } from "../../billing/actions";
import { IntakeFiles } from "../../leads/intake-files";
import { intakePaths } from "@/lib/playbook/uploads";
import type { Quote, QuoteLineItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: quote, error: quoteErr } = await supabase
    .from("quotes")
    // pricing_levels nested INSIDE customers(*) — the star stays, because CustomerSelect's
    // `customer` prop needs the full row for EditCustomerButton. Narrowing it to a field list
    // would fix the markup and break that card.
    // The lead's contact block rides along (PROJECTION LAW): the "Prepared for" card has to be
    // able to show WHO an estimate with no customer is for, and a lead is a person with a name,
    // a phone and an email — not a blank.
    .select("*, customers(*, pricing_levels(markup_pct)), inquiry:inquiry_id(id, name, company_name, email, phone, intake)")
    .eq("id", id)
    .maybeSingle();

  if (quoteErr) throw quoteErr; // a real failure shouldn't masquerade as 404
  if (!quote) notFound();
  const q = quote as Quote & { customers: any };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("*")
    .eq("quote_id", id)
    .order("sort_order");

  const lineItems = (items ?? []) as QuoteLineItem[];

  // Has this quote already been turned into these records? (Drives idempotent UI:
  // the map shows "View …" instead of minting a duplicate.) Plus the org's
  // customers so the attached customer can be changed inline.
  const [{ data: existingInv }, { data: existingWo }, { data: existingMl }, { data: customers }, { data: priceItems }, { data: kits }, { data: orgRow }] = await Promise.all([
    supabase.from("invoices").select("id").eq("quote_id", id).limit(1).maybeSingle(),
    supabase.from("work_orders").select("id").eq("quote_id", id).limit(1).maybeSingle(),
    supabase.from("material_lists").select("id").eq("quote_id", id).limit(1).maybeSingle(),
    supabase.from("customers").select("id, name, company_name").order("name"),
    // THE SAME CATALOG THE COMPOSER GETS. A saved estimate used to offer only a bare
    // "Add a line item…" text box — no price list, no kits — so the one place you're most likely
    // to be adjusting a real quote was the one place you had to type prices from memory.
    supabase
      .from("price_list_items")
      .select("id, code, description, category, unit, buy_price, markup_pct")
      .eq("archived", false)
      .order("description")
      .limit(2000),
    // THE SHARED SELECT SHAPE (kit-line.ts) — sizing + the 0240 price-list link, tolerant of
    // either migration not having landed yet, so a linked kit line prices live for this customer.
    firstThatWorks(kitsSelectRungs("id, name").map((sel) => () => supabase.from("kits").select(sel).order("name"))),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);

  // The quote's seek door: what it can BECOME (idempotent conversion nodes —
  // `run` creates the record then opens it; once minted they flip to "View …")
  // plus Print (the page's only print door) and Delete, danger-styled, last.
  // The Customer and All-quotes links were pruned: the CustomerSelect card and
  // the Back breadcrumb already carry them on-page (one map per territory).
  const quoteMap: NavTree = {
    center: { label: q.quote_number, icon: "fileText" },
    nodes: [
      existingInv
        ? { id: "qm-inv", label: "View Invoice", icon: "receipt", href: `/billing/${existingInv.id}` }
        : { id: "qm-inv", label: "Create Invoice", icon: "receipt", run: createInvoiceFromQuote.bind(null, q.id), hrefPrefix: "/billing/" },
      (q as any).job_id
        ? { id: "qm-job", label: "View Job", icon: "briefcase", href: `/jobs/${(q as any).job_id}` }
        : { id: "qm-job", label: "Create Job", icon: "briefcase", run: createJobFromQuote.bind(null, q.id), hrefPrefix: "/jobs/" },
      ...(lineItems.length > 0
        ? [
            existingWo
              ? { id: "qm-wo", label: "View Work Order", icon: "clipboardCheck", href: `/work-orders/${existingWo.id}` }
              : { id: "qm-wo", label: "Create Work Order", icon: "clipboardCheck", run: createWorkOrderFromQuote.bind(null, q.id), hrefPrefix: "/work-orders/" },
            existingMl
              ? { id: "qm-ml", label: "View Material List", icon: "boxes", href: `/materials/${existingMl.id}` }
              : { id: "qm-ml", label: "Create Material List", icon: "boxes", run: createMaterialListFromQuote.bind(null, q.id), hrefPrefix: "/materials/" },
          ]
        : []),
      { id: "qm-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/pdf-preview?doc=quote&id=${q.id}&back=/quotes/${q.id}` },
      {
        id: "qm-del",
        label: "Delete Quote",
        icon: "trash",
        danger: true,
        confirmText: `Delete quote ${q.quote_number}? Its line items go with it.`,
        run: deleteQuote.bind(null, q.id),
        href: "/quotes",
      },
    ],
  };

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink fallback="/quotes" fallbackLabel="Back to Quotes" />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {/* TWO LAYERS, NOT ONE ROW. The share is a sibling of the wrapping group, not its last
              member: the type toggle is ~250px of nowrap pill (two labelled segments) that cannot
              shrink, so as one flat row at 375–402px (343–370px of content inside main's p-4)
              number + badge + toggle already ran ~440px and pushed the share clean off the right
              edge. Wrapping that flat row would have carried the share down to the toggle's line.
              Here the group takes the remaining width (flex-1 min-w-0) and wraps INSIDE itself —
              number + badge on the first line, the toggle dropping under them — while the share
              stays parked top-right on the first line at every width (items-start; its 32px box
              matches the h1's 32px line). Narrowest case, 375px: 343 − 12 gap − 32 share = 299px
              for the group; "EST-0042" + badge ≈ 175px fits line one, the ~250px toggle fits line
              two, nothing scrolls sideways. */}
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <h1 className="min-w-0 text-2xl font-bold text-slate-900">{q.quote_number}</h1>
              <Badge tone={statusTone(q.status)}>{q.status}</Badge>
              <QuoteTypeToggle id={q.id} value={(((q as any).doc_type ?? "quote") as "estimate" | "quote")} />
            </div>
            {/* The estimate page had NO share at all — only Email and Text, both of which need a
                number or an address on file. Same tiny box-with-arrow as the invoice, same corner
                (the right end of the title line — the page's true top-right once the verb row
                wraps on a phone), same draft dance: a draft asks, then flips to sent as it goes. */}
            <ShareIconButton load={quoteShareText.bind(null, q.id)} className="ml-auto shrink-0" />
          </div>
          {q.title && <p className="mt-1 text-slate-600">{q.title}</p>}
          {/* Provenance backlink — the lead this estimate was seeded from. */}
          {(q as any).inquiry && (
            <Link href={`/leads?focus=${(q as any).inquiry.id}`} className="mt-1 inline-block text-sm text-brand hover:underline">
              ← from lead: {(q as any).inquiry.name}
            </Link>
          )}
          {/* What the customer attached at intake. The lead leaves the inbox on conversion, so
              this estimate — the thing being priced FROM those plans — must carry them itself. */}
          {(q as any).inquiry && (
            <IntakeFiles inquiryId={(q as any).inquiry.id} paths={intakePaths((q as any).inquiry.intake)} />
          )}
          <p className="mt-1 text-sm text-slate-400">
            Created {formatDate(q.created_at)}
            {q.valid_until ? ` · Valid until ${formatDate(q.valid_until)}` : ""}
          </p>
        </div>
        {/* Impulse verbs first (Send / advance status / Duplicate); the ⋯ Actions
            menu rides LAST — the one seek door, holding conversions + Delete. */}
        <div className="flex flex-wrap items-center gap-2">
          <EmailButton id={q.id} kind="quote" />
          <StatusControl id={q.id} status={q.status} />
          <DuplicateQuoteButton id={q.id} />
          <SectionActionsMenu tree={quoteMap} />
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="py-5">
          <CustomerSelect
            quoteId={q.id}
            customer={q.customers ?? null}
            // Erik: "shows me that it is from the lead 'Catherine' but still showing no customer
            // as selected.. This needs to be separated." It always WAS separate in the data —
            // this card just never asked for the lead, so it printed "No customer attached" over
            // an estimate that knows exactly whose it is.
            lead={(q as any).inquiry ?? null}
            customers={(customers ?? []) as { id: string; name: string; company_name: string | null }[]}
          />
        </CardContent>
      </Card>

      <QuoteItemsEditor
        quote={q}
        items={lineItems}
        priceItems={(priceItems ?? []) as never}
        kits={(kits ?? []) as never}
        defaultMarkupPct={getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).default_markup_pct}
        // `?? null` and never `?? 0`: effectiveMarkupPct returns immediately on ANY finite level,
        // including 0, so a 0 here would price every customer-without-a-level at net cost — a
        // worse bug than the one this fixes.
        levelMarkupPct={(quote as any)?.customers?.pricing_levels?.markup_pct ?? null}
      />
      <CircuitScheduleCard quoteId={q.id} initial={(q.circuits ?? []) as any} />
    </div>
  );
}
