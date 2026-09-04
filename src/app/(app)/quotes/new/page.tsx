import { createClient } from "@/lib/supabase/server";
import { firstThatWorks, kitsSelectRungs } from "@/lib/kit-line";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { measurementsFromAnswers, tolerateMissingColumns } from "@/lib/inspection/schema";
import { factsForEstimatorByProvenance } from "@/lib/playbook/answers";
import { briefProvenanceKeys, parsePlanBrief } from "@/lib/plan-brief";
import { intakeProvenanceKeys } from "@/lib/inquiries/carry-intake-answers";
import { extOf, intakePaths, uploadDisplayName } from "@/lib/playbook/uploads";
import { coerceScopes, ownScopes, scopeLines, type ScopePick } from "@/lib/playbook/scopes";
import type { DraftLineItem } from "@/lib/estimate/line-map";
import { sheetFromPlaybook } from "@/lib/playbook/from-sheet";
import { playbookForForm } from "@/lib/playbook/parse";
import { DECK_ESTIMATE_CODES } from "@/lib/estimate/deck";
import { NewInspectionButton } from "../../appointments/new-inspection-button";
import { QuoteBuilder } from "./quote-builder";

export const dynamic = "force-dynamic";

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; job?: string; inquiry?: string; capture?: string }>;
}) {
  const { customer, job, inquiry, capture } = await searchParams;
  const supabase = await createClient();
  // For the builder's storage-first uploads (#116) — RLS returns only the caller's own org.
  const { data: ownOrg } = await supabase.from("organizations").select("id").limit(1).maybeSingle();
  const orgId = String((ownOrg as { id?: string } | null)?.id ?? "");
  // ADOPT-AT-MOUNT (review of cn-v796): if this lead already has an autosaved DRAFT, seed the
  // builder with its id — a cross-session re-entry (or a different door) must update that one
  // row, not mint a numbered twin. RLS-scoped; newest draft wins; sessionStorage still refines.
  const { data: auth } = await supabase.auth.getUser();
  const draftUserId = auth?.user?.id ?? null;
  let adoptedDraftId: string | null = null;
  let adoptedSeed: {
    customerId?: string | null;
    docType?: string | null;
    title?: string | null;
    description?: string | null;
    notes?: string | null;
    taxRate?: number | null;
    validUntil?: string | null;
    items?: { description: string; quantity: number; unit: string; unit_price: number; group?: string }[];
  } | null = null;
  if (inquiry) {
    // The id alone is NOT an adoption (review of the Q-001/E-001 flap): a builder seeded with
    // an id but default-empty state would autosave that emptiness over the draft's real lines
    // on the first keystroke. Adopting means inheriting the CONTENT too; a session draft, when
    // one exists, still restores over this (it may be newer).
    const { data: existing } = await supabase
      .from("quotes")
      .select("id, customer_id, doc_type, title, description, notes, tax_rate, valid_until, quote_line_items(description, quantity, unit, unit_price, category, sort_order)")
      .eq("inquiry_id", inquiry)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      const ex = existing as {
        id: string; customer_id: string | null; doc_type: string | null; title: string | null;
        description: string | null; notes: string | null; tax_rate: number | null; valid_until: string | null;
        quote_line_items?: { description: string; quantity: number; unit: string; unit_price: number; category: string | null; sort_order: number | null }[];
      };
      adoptedDraftId = ex.id;
      adoptedSeed = {
        customerId: ex.customer_id,
        docType: ex.doc_type,
        title: ex.title,
        description: ex.description,
        notes: ex.notes,
        taxRate: ex.tax_rate,
        validUntil: ex.valid_until,
        items: (ex.quote_line_items ?? [])
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((li) => ({ description: li.description, quantity: li.quantity, unit: li.unit, unit_price: li.unit_price, group: li.category ?? undefined })),
      };
    }
  }

  // ?capture=<appointment id> — an inspection's field capture prefills the
  // estimator scope (like importing labor into an invoice). RLS scopes the read;
  // a bad/cross-org id just yields no prefill. Also recovers the lead backlink
  // from the appointment when the URL didn't carry ?inquiry=. Photos are
  // DELIBERATELY not carried into the prefill — only notes/measurements/materials;
  // they stay on the appointment's capture page (signed URLs, private bucket).
  let initialScope: string | undefined;
  // Square/linear feet from the walk-through, handed to the kit picker so its sizing boxes open
  // with the numbers the inspector already took.
  let measured: { sqft: number | null; linearFt: number | null } | undefined;
  const pickedScopes: { label: string; picks: ScopePick[] }[] = [];
  let captureInquiryId: string | undefined;
  let captureApptId: string | undefined; // verified appointment id — saveQuote stamps the write-up backlink on it
  // The inspection already knows WHOSE house this is. Without carrying these through, a repeat
  // customer's walk-through wrote up into a blank estimate and you re-picked them from the full
  // contact list standing in their yard.
  let captureCustomerId: string | undefined;
  let captureJobId: string | undefined;
  if (capture) {
    const { data: appt } = await supabase
      .from("appointments")
      .select("id, title, location, inquiry_id, capture, customer_id, job_id")
      .eq("id", capture)
      .maybeSingle();
    const cap = (appt as any)?.capture as
      | { notes?: string; measurements?: string; materials?: string }
      | null
      | undefined;
    if (appt) {
      // THE TYPED ANSWERS GO FIRST, and are labelled as MEASURED (0165). The inspector already
      // stood in front of these numbers; making the estimator re-extract "85 ft" from a sentence
      // is a re-derivation that can silently come back with a different number. Facts above prose.
      // Read tolerantly — a deploy precedes its migration, and naming an absent column fails the
      // whole query. Pre-migration this yields no measured block and the prose prefill is unchanged.
      const insp = await tolerateMissingColumns<{ inspection_answers: unknown; forms: unknown; inquiry: unknown }>(() =>
        supabase
          .from("appointments")
          .select("inspection_answers, forms:inspection_template_id(schema, playbook), inquiry:inquiry_id(intake)")
          .eq("id", capture)
          .maybeSingle(),
      );
      const rel = (insp as any)?.forms;
      // Read through the PLAYBOOK, the same resolver the inspector wrote through (cn-v628). Read
      // through the raw sheet instead and a checkbox-turned-select answer of "No" prints as "yes",
      // because the sheet's checkbox branch only asks whether the value is truthy — and "No" is.
      const pb = playbookForForm(Array.isArray(rel) ? rel[0] : rel);
      const answers = ((insp as any)?.inspection_answers ?? {}) as never;
      // WHO SAID EACH FACT. An answer the plan brief seeded and nobody edited is a MACHINE's
      // reading of the customer's documents — it must not cross into the estimator wearing "his
      // words — take them as given". Equality against the brief is the provenance test: the
      // moment he edits a value it stops matching and becomes his.
      const inqRel = (insp as any)?.inquiry;
      const leadBrief = parsePlanBrief((Array.isArray(inqRel) ? inqRel[0] : inqRel)?.intake);
      const machineKeys =
        leadBrief?.status === "ready" && leadBrief.answers
          ? briefProvenanceKeys(pb, leadBrief.answers, answers)
          : new Set<string>();
      // THE CUSTOMER'S OWN FORM IS NOT THE CONTRACTOR'S WORD EITHER (v800 audit). A carried
      // intake answer arrived in the "his words — take them as given" bucket, even though a
      // stranger typed it and the intake and walk-through playbooks can drift until the same
      // key means different things on each side. Still-untouched carried values join the
      // verify bucket; the moment he edits one on site it stops matching and becomes his.
      const leadIntake = (Array.isArray(inqRel) ? inqRel[0] : inqRel)?.intake as
        | { intake_answers?: unknown }
        | null
        | undefined;
      const customerAnswers = (leadIntake?.intake_answers ?? null) as Record<string, unknown> | null;
      if (customerAnswers && typeof customerAnswers === "object") {
        for (const k of intakeProvenanceKeys(Object.keys(customerAnswers), customerAnswers, answers)) {
          machineKeys.add(k);
        }
      }
      const { hand: measuredText, machine: machineText } = factsForEstimatorByProvenance(pb, answers, machineKeys);
      // Kit sizing still reads the sheet shape; every measured need is a number slot, so the
      // projection back down loses nothing that sizes anything.
      measured = measurementsFromAnswers(sheetFromPlaybook(pb), answers);
      // Capture photos hold documents too — a report he photographed or uploaded on site.
      const docNames = (((cap as { photos?: unknown } | null)?.photos ?? []) as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((path) => path.split("/").pop() ?? path)
        .map((n) => n.replace(/^\d+-/, "").replace(/_/g, " "));
      const parts = [
        `From site inspection — ${(appt as any).title}${(appt as any).location ? ` (${(appt as any).location})` : ""}`,
        // HIS WORDS, TAKEN AS GIVEN — but not called a measurement, because mostly they aren't.
        // Not one need in his playbook is marked `measured`, yet this header fired on ANY answer,
        // so a paragraph reading "(bulbs or inserts pricing)", "(~$500 optional)" and "(T&M) unknown"
        // was handed over labelled as measured fact not to be re-derived. And nothing told the
        // estimator that eight lines means eight line items — so his list arrived as one blob.
        measuredText
          ? `FROM THE WALK-THROUGH (his words — take them as given). Where he wrote a list, quote ONE LINE ITEM PER LINE:\n${measuredText}`
          : "",
        // The machine's answers cross under their own flag, never as his words: a model's
        // unverified count from a stranger's PDF must be a claim to confirm, not a given.
        machineText
          ? `NOT CONFIRMED ON SITE (unverified — the customer typed these into your web form, or a machine read them off their plans; treat as claims to check, and the walk-through notes above override them):\n${machineText}`
          : "",
        cap?.notes?.trim() ? `Notes:\n${cap.notes.trim()}` : "",
        cap?.measurements?.trim() ? `Measurements:\n${cap.measurements.trim()}` : "",
        cap?.materials?.trim() ? `Materials needed:\n${cap.materials.trim()}` : "",
        // WHAT'S ATTACHED, BY NAME. Erik, estimating Sara Cain: "the estimator said it didnt have
        // the file even though its there." It was there — a home-inspection PDF sitting in the
        // walk-through's capture — and this hand-off simply never mentioned it, so the estimator
        // answered honestly about a world it couldn't see. It still can't READ a PDF; naming the
        // document is the difference between "I don't have it" and "I have it and can't open it",
        // and only one of those is true.
        docNames.length
          ? `ATTACHED TO THIS WALK-THROUGH (you cannot open these — say so rather than guessing at their contents):\n${docNames.map((d) => `- ${d}`).join("\n")}`
          : "",
      ].filter(Boolean);
      if (parts.length > 1) initialScope = parts.join("\n\n");
      // A `scopes` answer is already priced line items. Collect the picks here (where the playbook
      // is in scope) and map them to lines below, once the price book has loaded — the descriptions
      // and units come from the book, not from the answer.
      for (const n of pb.needs) {
        if (n.slot?.type !== "scopes") continue;
        const picks = coerceScopes((answers as Record<string, unknown>)[n.key]);
        if (picks?.length) pickedScopes.push({ label: n.label, picks });
      }
      captureInquiryId = (appt as any).inquiry_id ?? undefined;
      captureApptId = (appt as any).id;
      captureCustomerId = (appt as any).customer_id ?? undefined;
      captureJobId = (appt as any).job_id ?? undefined;
    }
  }

  // THE CUSTOMER'S PLANS, OFFERED WHERE THE TAKE-OFF HAPPENS. Andrew's estimate told him "the
  // plan set is attached but I can't open it" — true, and absurd: the PDF was sitting on the
  // lead the whole time, reachable only by downloading it and re-uploading it here. A linked
  // lead's plan PDFs become one-tap read chips beside Upload Plans (server re-verifies the
  // lead carries each path before a byte moves).
  let leadPlans: { path: string; name: string }[] = [];
  const effInquiryId = inquiry ?? captureInquiryId;
  if (effInquiryId) {
    const { data: leadRow } = await supabase.from("inquiries").select("intake").eq("id", effInquiryId).maybeSingle();
    leadPlans = intakePaths((leadRow as { intake?: unknown } | null)?.intake)
      .filter((p) => extOf(p) === "pdf")
      .map((p) => ({ path: p, name: uploadDisplayName(p) }));
  }
  const [{ data: customers }, { data: priceItems }, { data: taxRates }, { data: kits }, { data: org }] =
    await Promise.all([
      supabase.from("customers").select("id, name, company_name, pricing_levels(markup_pct, labor_rate)").order("name"),
      supabase
        .from("price_list_items")
        .select("id, code, description, category, unit, buy_price, markup_pct, updated_at")
        .eq("archived", false)
        .order("description")
        .limit(2000),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      // THE SHARED SELECT SHAPE (kit-line.ts): kit lines with their 0166 sizing and, since 0240,
      // their price-list link + the item embed, so a linked line prices LIVE for this customer in
      // the picker. Three rungs, most capable first — a deploy precedes its migration, and naming
      // an absent column fails the whole query rather than degrading, which would empty the kit
      // picker until the migration landed.
      firstThatWorks(kitsSelectRungs("id, name").map((sel) => () => supabase.from("kits").select(sel).order("name"))),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);
  // THE WALK-THROUGH'S PICKS, AS REAL LINES. Descriptions and units come from the org's own book
  // (the answer stores codes, never prose), and a code that has since left the price list is
  // dropped rather than rendered as a bare code with a price beside it.
  const book = new Map((priceItems ?? []).map((p: any) => [p.code as string, { description: p.description, unit: p.unit }]));
  const bookCodes = new Set(book.keys());
  const seededLines: DraftLineItem[] = pickedScopes.flatMap((g) =>
    scopeLines(ownScopes(g.picks, bookCodes), book, g.label),
  );

  const settings = getOrgSettings((org as any)?.settings);
  const expiryDays = settings.quote_expiry_days;
  // Catalog-mode orgs (Tahoe Deck) estimate from TWO scope kits — "Decks" and "Remodels".
  // The granular material kits (Framing, Hardware, Decking…) are the POST-acceptance job
  // breakdown, so they're hidden from the estimate picker here. Research orgs (ET Electric)
  // still see every kit — nothing changes for them.
  const catalogMode = settings.estimating_mode === "catalog";
  const estimateKits = catalogMode
    ? (kits ?? []).filter((k: any) => k.name === "Decks" || k.name === "Remodels")
    : (kits ?? []);
  // Deck generator rows (catalog orgs) — the deck price codes as RAW {code, buy, markup_pct}
  // rows. The office builder prices them client-side through THE markup rule (effectiveMarkupPct
  // with the selected customer's level + org default), so generator lines re-price when the
  // customer changes and always agree with the hand-picker on the same page. (The PUBLIC
  // configurator keeps buildDeckRates' item-markup-only freeze.) The dedupe contract is
  // first-row-per-code-wins from NEWEST-FIRST rows; the query above orders by description
  // for the picker, so re-sort the deck subset here.
  const deckRateRows = catalogMode
    ? (priceItems ?? [])
        .filter((p: any) => p.code && (DECK_ESTIMATE_CODES as readonly string[]).includes(p.code))
        .sort((a: any, b: any) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
        .map((p: any) => ({ code: p.code, buy_price: p.buy_price, markup_pct: p.markup_pct }))
    : undefined;

  return (
    <div>
      <BackLink fallback="/quotes" fallbackLabel="Back to Estimates" />
      <PageHeader
        title="New Estimate"
        description="Build line items by hand, or let the estimator draft them from a scope of work or an uploaded plan."
      >
        {/* Onsite with no capture yet? Start the inspection from where you'll end up — one
            tap creates it (threaded to the lead when this builder came from one) and lands
            on the capture page; Start estimate there routes back here prefilled. */}
        {!capture && <NewInspectionButton inquiryId={inquiry} size="sm" variant="outline" />}
      </PageHeader>
      <QuoteBuilder
        initialQuoteId={adoptedDraftId}
        adoptedSeed={adoptedSeed}
        draftUserId={draftUserId}
        orgId={orgId}
        measured={measured}
        customers={(customers ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          company_name: c.company_name,
          level_markup: c.pricing_levels?.markup_pct ?? null,
          level_rate: c.pricing_levels?.labor_rate ?? null,
        }))}
        preselected={customer ?? captureCustomerId}
        jobId={job ?? captureJobId}
        inquiryId={inquiry ?? captureInquiryId}
        leadPlans={leadPlans}
        captureId={captureApptId}
        initialScope={initialScope}
        seededLines={seededLines}
        priceItems={(priceItems ?? []) as any}
        taxRates={(taxRates ?? []) as any}
        kits={estimateKits as any}
        quoteExpiryDays={expiryDays}
        defaultMarkupPct={settings.default_markup_pct}
        deckRateRows={deckRateRows}
      />
    </div>
  );
}
