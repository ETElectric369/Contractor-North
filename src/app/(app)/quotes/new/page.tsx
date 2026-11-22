import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { smsReadiness } from "@/lib/sms";
import { sameScope } from "@/lib/playbook/scope";
import { measuredOnSiteBlock, parseInspectorCapture } from "@/lib/inspection/capture";
import { captureQuoteId } from "@/lib/inspections";
import { liveEstimateBehindVisit } from "@/lib/estimate/behind-visit";
import { kitsReadWords, partsKitsOnly, readTaskKits } from "@/lib/estimate/task-kits";
import { reportError } from "@/lib/observe";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { currentLang } from "@/lib/current-lang";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { measurementsFromAnswers, tolerateMissingColumns } from "@/lib/inspection/schema";
import { factsForEstimatorByProvenance } from "@/lib/playbook/answers";
import { briefProvenanceKeys, parsePlanBrief } from "@/lib/plan-brief";
import { intakeAnswerLines, intakeProvenanceKeys } from "@/lib/inquiries/carry-intake-answers";
import { extOf, intakePaths, uploadDisplayName } from "@/lib/playbook/uploads";
import type { DraftLineItem } from "@/lib/estimate/line-map";
import { readPriceBook, readPricingLevel, readVisitEstimateSeed, visitEstimateLines, type ScopeGroup, type TaskGroup } from "@/lib/estimate/visit-lines";
import { normalizeDocStyle } from "@/lib/doc-style";
import { sheetFromPlaybook } from "@/lib/playbook/from-sheet";
import { playbookForForm } from "@/lib/playbook/parse";
import { ITEM_OPTIONS_UNAVAILABLE } from "@/lib/pricing/item-options";
import { NewInspectionButton } from "../../appointments/new-inspection-button";
import { EstimateEditor } from "../estimate-editor";

export const dynamic = "force-dynamic";
// The estimator runs inside this page's server actions (generateQuoteDraft and kin, quotes/actions):
// effort high, up to 16000 tokens a round and up to three rounds, not streamed. A server action
// runs under the segment config of the page that invoked it, so the page carries the time: 300 s,
// the largest the repo uses (Vercel Pro's ceiling for these functions).
export const maxDuration = 300;

/** The shape of a visit's id on the address (a uuid); anything else is no visit. */
const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; job?: string; inquiry?: string; capture?: string }>;
}) {
  const { customer, job, inquiry, capture: captureParam } = await searchParams;
  // A MALFORMED ?capture= IS NO VISIT (cn-v1176 fix F10): an id that is not a uuid opens the blank
  // editor, as it always did, instead of a database error the read below would throw on. A REAL read
  // failure on a well-formed id still throws (readVisitEstimateSeed).
  const capture = captureParam && CAPTURE_ID.test(captureParam.trim()) ? captureParam.trim() : undefined;
  const supabase = await createClient();
  const t = translator(await currentLang());
  // For the editor's storage-first uploads (#116) — RLS returns only the caller's own org.
  const { data: ownOrg } = await supabase.from("organizations").select("id").limit(1).maybeSingle();
  const orgId = String((ownOrg as { id?: string } | null)?.id ?? "");
  // ONE DRAFT PER LEAD (review of cn-v796, kept in cn-v1132 without a browser copy): if this lead
  // already has a draft, this door OPENS IT — a cross-session re-entry, or a different door, must
  // edit that one row, never mint a numbered twin. The estimate is edited where it lives; nothing is
  // adopted into the browser. RLS-scoped; newest draft wins.
  if (inquiry) {
    const { data: existing, error: existingErr } = await supabase
      .from("quotes")
      .select("id")
      .eq("inquiry_id", inquiry)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // A failed read is an error, exactly as the ?capture= read below: a draft this door couldn't see
    // is not "no draft", and opening a fresh editor over it would mint the twin this check exists to prevent.
    if (existingErr) throw existingErr;
    if (existing?.id) redirect(`/quotes/${existing.id}`);
  }

  // ?capture=<appointment id> — an inspection's field capture prefills the
  // estimator scope (like importing labor into an invoice). RLS scopes the read;
  // a cross-org id just yields no prefill, and a malformed one never reaches it (CAPTURE_ID above). Also recovers the lead backlink
  // from the appointment when the URL didn't carry ?inquiry=. Photos are
  // DELIBERATELY not carried into the prefill — only notes/measurements/materials;
  // they stay on the appointment's capture page (signed URLs, private bucket).
  let initialScope: string | undefined;
  // Square/linear feet from the inspection, handed to the kit picker so its sizing boxes open
  // with the numbers the inspector already took.
  let measured: { sqft: number | null; linearFt: number | null; byKey?: Record<string, number | null> } | undefined;
  const pickedScopes: ScopeGroup[] = [];
  // A `tasks` answer (cn-v1073): HIS tasks, each with his hours and his parts. Priced below, once
  // the book and the customer's rate card have loaded — one line per task (lib/estimate/task-lines).
  const pickedTasks: TaskGroup[] = [];
  // The rows typed on site (capture.items) and the numbers measured there (capture.measures), read
  // tolerantly (parseInspectorCapture). Saved since the typed inspector shipped, read by nothing until
  // cn-v1069: the items follow the scope picks onto the estimate, the measures join the scope text.
  let typedCapture: ReturnType<typeof parseInspectorCapture> | null = null;
  let captureInquiryId: string | undefined;
  let captureApptId: string | undefined; // verified appointment id — saveQuote stamps the write-up backlink on it
  let captureScopeWord: string | null = null; // the visit's scope word: what Remember as a Kit files a kit under
  // The inspection already knows WHOSE house this is. Without carrying these through, a repeat
  // customer's inspection wrote up into a blank estimate and you re-picked them from the full
  // contact list standing in their yard.
  let captureCustomerId: string | undefined;
  let captureJobId: string | undefined;
  // THE VISIT'S PRICING CUSTOMER (cn-v1176, M1): the visit's customer, else its lead's.
  let pricingCustomer: string | null = null;
  if (capture) {
    // THE VISIT-SIDE READS live with the line builder (lib/estimate/visit-lines readVisitEstimateSeed),
    // shared with the Inspector's Won sheet: the visit, its answers THROUGH appointment_answers (0366,
    // LEAK-0227: the view hands the office the answers as stored, prices included), its sheet and its
    // lead, each a read of its own. A failed answers read THROWS: an estimate never seeds from an
    // inspection it couldn't read. Pre-0165 (no such column) is still no measured block.
    const seedRead = await readVisitEstimateSeed(supabase, capture);
    const appt = seedRead?.visit ?? null;
    const cap = (appt as any)?.capture as
      | { notes?: string; measurements?: string; materials?: string }
      | null
      | undefined;
    if (appt && seedRead) {
      // THE VISIT'S ESTIMATE IS OPENED, NEVER TWINNED (S1): a second open of this door, a stale Start
      // The Estimate link or a second tab must edit the row the visit already became — its first
      // save would otherwise birth a twin and overwrite the visit's backlink (capture.quote_id, last
      // writer wins). The same answer the Inspector's Open the Estimate reads; a superseded one opens
      // its standing revision, and a declined or expired one hands this door back.
      const standing = await liveEstimateBehindVisit(supabase, captureQuoteId((appt as any).capture));
      if (standing) redirect(`/quotes/${standing}`);
      typedCapture = parseInspectorCapture((appt as any).capture);
      // THE TYPED ANSWERS GO FIRST, and are labelled as MEASURED (0165). The inspector already
      // stood in front of these numbers; making the estimator re-extract "85 ft" from a sentence
      // is a re-derivation that can silently come back with a different number. Facts above prose.
      const leadRel = seedRead.lead;
      // Read through the PLAYBOOK, the same resolver the inspector wrote through (cn-v628). Read
      // through the raw sheet instead and a checkbox-turned-select answer of "No" prints as "yes",
      // because the sheet's checkbox branch only asks whether the value is truthy — and "No" is.
      const pb = seedRead.pb;
      const answers = seedRead.answers as never;
      // WHO SAID EACH FACT. An answer the plan brief seeded and nobody edited is a MACHINE's
      // reading of the customer's documents — it must not cross into the estimator wearing "his
      // words — take them as given". Equality against the brief is the provenance test: the
      // moment he edits a value it stops matching and becomes his.
      const leadBrief = parsePlanBrief(leadRel?.intake);
      const machineKeys =
        leadBrief?.status === "ready" && leadBrief.answers
          ? briefProvenanceKeys(pb, leadBrief.answers, answers)
          : new Set<string>();
      // THE CUSTOMER'S OWN FORM IS NOT THE CONTRACTOR'S WORD EITHER (v800 audit). A carried
      // intake answer arrived in the "his words — take them as given" bucket, even though a
      // stranger typed it and the intake and inspection playbooks can drift until the same
      // key means different things on each side. Still-untouched carried values join the
      // verify bucket; the moment he edits one on site it stops matching and becomes his.
      const leadIntake = leadRel?.intake as
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
        // It is an INSPECTION everywhere a person reads it (lib/statuses), and the place is named.
        `From the inspection — ${(appt as any).title}${(appt as any).location ? ` (${(appt as any).location})` : ""}`,
        // HIS WORDS, TAKEN AS GIVEN — but not called a measurement, because mostly they aren't.
        // Not one need in his playbook is marked `measured`, yet this header fired on ANY answer,
        // so a paragraph reading "(bulbs or inserts pricing)", "(~$500 optional)" and "(T&M) unknown"
        // was handed over labelled as measured fact not to be re-derived. And nothing told the
        // estimator that eight lines means eight line items — so his list arrived as one blob.
        measuredText
          ? `FROM THE INSPECTION (his words — take them as given). Where he wrote a list, quote ONE LINE ITEM PER LINE:\n${measuredText}`
          : "",
        // The machine's answers cross under their own flag, never as his words: a model's
        // unverified count from a stranger's PDF must be a claim to confirm, not a given.
        machineText
          ? `NOT CONFIRMED ON SITE (unverified — the customer typed these into your web form, or a machine read them off their plans; treat as claims to check, and the inspection notes above override them):\n${machineText}`
          : "",
        cap?.notes?.trim() ? `Notes:\n${cap.notes.trim()}` : "",
        cap?.measurements?.trim() ? `Measurements:\n${cap.measurements.trim()}` : "",
        // The numbers typed as measures on site, by name (never re-extracted from the prose above).
        measuredOnSiteBlock(typedCapture?.measures),
        cap?.materials?.trim() ? `Materials needed:\n${cap.materials.trim()}` : "",
        // WHAT'S ATTACHED, BY NAME. Erik, estimating Sara Dale: "the estimator said it didnt have
        // the file even though its there." It was there — a home-inspection PDF sitting in the
        // inspection's capture — and this hand-off simply never mentioned it, so the estimator
        // answered honestly about a world it couldn't see. It still can't READ a PDF; naming the
        // document is the difference between "I don't have it" and "I have it and can't open it",
        // and only one of those is true.
        docNames.length
          ? `ATTACHED TO THIS INSPECTION (you cannot open these — say so rather than guessing at their contents):\n${docNames.map((d) => `- ${d}`).join("\n")}`
          : "",
      ].filter(Boolean);
      if (parts.length > 1) initialScope = parts.join("\n\n");
      // A `scopes` answer is already priced line items, a `tasks` answer his tasks: collected by the
      // builder's own read (lib/estimate/visit-lines visitPicks, ONLY THE QUESTIONS THAT STILL APPLY,
      // cleared to a fixed point first) and mapped to lines below, once the price book has loaded.
      captureScopeWord = seedRead.scopeWord;
      pickedScopes.push(...seedRead.scopes);
      pickedTasks.push(...seedRead.tasks);
      pricingCustomer = seedRead.pricingCustomerId;
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
  // The lead this builder was OPENED for, as a picker option in its own right (below).
  let openedForLead: { id: string; name: string; company_name: string | null } | null = null;
  const effInquiryId = inquiry ?? captureInquiryId;
  if (effInquiryId) {
    const [{ data: leadRow }, intakeForm] = await Promise.all([
      supabase
        .from("inquiries")
        // `message` rides along (PROJECTION LAW): for a lead that came in by phone, by email or
        // through the site chat there ARE no structured answers, and the message is the only
        // thing the customer actually said. See the prefill below.
        .select("id, name, company_name, message, intake")
        .eq("id", effInquiryId)
        .maybeSingle(),
      // THE FORM THE CUSTOMER FILLED IN — the only place the LABELS for intake.intake_answers
      // exist (the answers are a bag of keys, and `q_mst1drw8` is not a question). Read tolerantly
      // and RLS-scoped, the same way the appointment page reads it; an org with no public door
      // simply has none and the prefill falls back to the message.
      tolerateMissingColumns<{ schema: unknown; playbook: unknown }>(() =>
        supabase.from("forms").select("schema, playbook").eq("is_public_intake", true).limit(1).maybeSingle(),
      ),
    ]);
    const lr = leadRow as {
      id?: string;
      name?: string;
      company_name?: string | null;
      message?: string | null;
      intake?: unknown;
    } | null;
    if (lr?.id) openedForLead = { id: lr.id, name: lr.name ?? "Lead", company_name: lr.company_name ?? null };
    leadPlans = intakePaths(lr?.intake)
      .filter((p) => extOf(p) === "pdf")
      .map((p) => ({ path: p, name: uploadDisplayName(p) }));

    /**
     * QUOTING STRAIGHT FROM A LEAD ARRIVED BLANK (Erik, 2026-09-07, the Andy Kolar lead).
     *
     * The "Ready to quote" triage bucket's own button lands here with ?inquiry=<id> and no
     * ?capture= — no inspection has happened, and none needs to. Everything the customer typed
     * into the web form was already on the row (intake.intake_answers) and, flattened, in
     * `message`. This page read neither: the estimator opened with an empty scope box and the
     * office retyped from the Leads board, or quoted without it.
     *
     * Same provenance split the inspection path uses, and for the same reason — a stranger
     * typed these into a web form, so they are CLAIMS TO CHECK, never "his words, take them as
     * given" and never measurements. Labels come from the intake playbook (intakeAnswerLines,
     * which also rescues answers under questions since deleted from the form); the flattened
     * `message` is only printed for the lines it does not already cover, so a lead that came in
     * by phone still carries its note and an intake lead is not shown the same ten lines twice.
     *
     * Never overwrites an inspection prefill: this runs only when nothing above produced one.
     */
    if (!initialScope && lr?.id) {
      const intakePb = intakeForm ? playbookForForm(intakeForm) : null;
      const answered = intakePb
        ? intakeAnswerLines(intakePb, (lr.intake as { intake_answers?: unknown } | null)?.intake_answers)
        : [];
      const said = answered.map((l) => `${l.label}: ${l.value}`).join("\n");
      // The intake door writes `message` as exactly these "Label: answer" lines, so drop the ones
      // already shown above and keep anything else the message carries (a phone lead's note, an
      // office remark appended later).
      const labels = answered.map((l) => `${l.label}:`.toLowerCase());
      const leftover = String(lr.message ?? "")
        .split("\n")
        .filter((line) => line.trim() && !labels.some((lab) => line.trim().toLowerCase().startsWith(lab)))
        .join("\n")
        .trim();
      const who = [lr.name, lr.company_name].filter(Boolean).join(" · ") || "this lead";
      const parts = [
        `From the lead: ${who}. Nobody has been on site yet, so nothing here is a measurement.`,
        said
          ? `WHAT THE CUSTOMER TOLD YOU (they typed these into your web form, so treat them as claims to check, not as given):\n${said}`
          : "",
        leftover ? `IN THEIR OWN WORDS:\n${leftover}` : "",
      ].filter(Boolean);
      if (parts.length > 1) initialScope = parts.join("\n\n");
    }
  }
  const [{ data: customers }, { data: leadRows }, { data: priceItems, error: priceItemsErr }, { data: taxRates }, kitsRead, { data: org }, { data: peopleRows, error: peopleErr }, seedLevel] =
    await Promise.all([
      supabase.from("customers").select("id, name, company_name, pricing_levels(markup_pct, labor_rate)").order("name"),
      // AN ESTIMATE IS OFTEN FOR A LEAD, NOT A CUSTOMER (Erik: "I should be able to select from
      // Lead list, not customer list when building estimate"). Nothing downstream needed
      // changing for this — quotes.inquiry_id already carries it, the Estimates list already
      // prints "Catherine · lead", and the printed document already coalesces the customer block
      // onto the inquiry. This picker was the only door that pretended a customer was required,
      // which is what pushed people into minting a customer row before the work was won.
      //
      // `status` is FREE TEXT (statuses.ts), so exclude the two that are FINISHED rather than
      // whitelisting the three that aren't — an org's own wording never silently disappears.
      supabase
        .from("inquiries")
        .select("id, name, company_name")
        .not("status", "in", "(lost,won)")
        .order("created_at", { ascending: false })
        .limit(500),
      // THE MAKERS RIDE WITH THE CODE (0282, Andrew for Justin Vivian). Code 830 is "Windows
      // (Materials) (Allowance)" and the decision nobody has made yet is WHOSE window — so the
      // picker has to be handed Andersen, Milgard and Marvin at the same moment it is handed 830,
      // or it offers the allowance price for a choice the estimator already made in his head.
      // One embed, one round trip; the pick itself resolves through lib/pricing/item-options.
      //
      // `.eq("price_list_item_options.archived", false)` filters the EMBEDDED rows only (it is not
      // an !inner join), so an item whose every maker is archived still appears, priced at its own
      // allowance — which is exactly right. A maker the org stopped carrying is never offered.
      // readPriceBook (lib/estimate/visit-lines): this select, shared with the Won sheet's builder.
      readPriceBook(supabase),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      // THE SHARED SELECT SHAPE (kit-line.ts): kit lines with their 0166 sizing and, since 0240,
      // their price-list link + the item embed, so a linked line prices LIVE for this customer in
      // the picker. Three rungs, most capable first — a deploy precedes its migration, and naming
      // an absent column fails the whole query rather than degrading, which would empty the kit
      // picker until the migration landed.
      // … and the read SAYS how it went (readTaskKits, item 3): a failed or thin read is a banner
      // beside the price list's, never a quietly kit-less estimate.
      // `category` rides along: the catalog picker below offers the kits filed under Estimate.
      readTaskKits((sel) => supabase.from("kits").select(sel).order("name"), "category"),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
      // THE TEAM, for a labor row's Who select (cn-v1131): id, name and BILL rate off the staff-scoped
      // profile_pay view — the same view the job's labor billing reads its rates from, so a task row
      // that names a person quotes the hour at the figure their clocked hour will bill at. Active
      // only: a row never offers somebody who has left. Never their pay rate.
      supabase.from("profile_pay").select("id, full_name, bill_rate").eq("active", true).order("full_name"),
      // THE SEED'S PRICING LEVEL, read by its own id through the reader the Won sheet uses (cn-v1176
      // fix U3): the customer list above has no limit and is capped by the API's row cap, so a customer
      // past it would price the seed at the default level here and at their own level on the sheet.
      readPricingLevel(supabase, pricingCustomer),
    ]);
  if (peopleErr) reportError("quotes/new:people", peopleErr, { inquiry: inquiry ?? null, capture: capture ?? null });
  const people = ((peopleRows ?? []) as { id: string; full_name: string | null; bill_rate: number | string | null }[]).map((p) => ({
    id: p.id,
    name: p.full_name ?? "Crew",
    billRate: p.bill_rate == null || p.bill_rate === "" ? null : Number(p.bill_rate),
  }));
  const kits = kitsRead.rows as Array<Record<string, unknown>> | null;
  if (kitsRead.state === "failed") reportError("quotes/new:kits", kitsRead.error, { inquiry: inquiry ?? null, capture: capture ?? null });
  const settings = getOrgSettings((org as any)?.settings);
  // THE INSPECTION'S PICKS, HIS TASKS AND THE ROWS TYPED ON SITE, AS REAL LINES, through THE ONE
  // builder (lib/estimate/visit-lines visitEstimateLines), the same one the Inspector's Won sheet
  // shows and approves: the scope picks (descriptions and units from the company's own book, a code
  // that left the book dropped), then one line per task (his hours at THE labor rate, his parts at the
  // book's cost through THE markup rule), then the typed rows, unpriced. Priced for the visit's
  // customer, else its lead's (cn-v1176): that customer's level rate and markup, else the defaults.
  // The company's Doc Studio choice for how a task line reads on the paper: what the builder's
  // switch calls "Company Default". Through the one normalizer, like every renderer.
  const companyEstimateFormat = normalizeDocStyle(settings.doc_style).estimate_format;
  // HIS TASK KITS (0386, W4): a task that picked one expands inside the builder through THE one
  // expandTaskKit (task-lines.ts), the same function the Inspector previewed it with.
  const taskKits = kitsRead.kits;
  const seededLines: DraftLineItem[] = visitEstimateLines({
    scopes: pickedScopes,
    tasks: pickedTasks,
    typedItems: typedCapture?.items,
    priceItems: (priceItems ?? []) as any[],
    kits: taskKits,
    level: seedLevel,
    settings: { default_markup_pct: settings.default_markup_pct, default_labor_rate: settings.default_labor_rate },
  });

  // The lead this page was opened for ALWAYS appears, even if it has since been won or lost or
  // has aged past the cap — a picker that can't show what the document is actually attached to
  // would render blank and read as "nobody", which is the lie this whole change is fixing.
  const leadOptions = ((leadRows ?? []) as { id: string; name: string | null; company_name: string | null }[]).map((l) => ({
    id: l.id,
    name: l.name ?? "Lead",
    company_name: l.company_name ?? null,
  }));
  const opened = openedForLead;
  if (opened && !leadOptions.some((l) => l.id === opened.id)) leadOptions.unshift(opened);

  const expiryDays = settings.quote_expiry_days;
  // In catalog mode the estimate picker offers the kits FILED UNDER Estimate (kits.category, the
  // scope word the Kits page calls Scope; sameScope folds case, punctuation and a plural): those
  // are the whole-job scope kits an estimate is priced from. The granular material kits (framing,
  // hardware, decking…) are the POST-acceptance breakdown — seeded onto the job's buy list by the
  // take-off (lib/estimate/take-off-from-quote), never offered here. Before cn-v1135 this read
  // two kit NAMES from one company's price list; a rule, so any catalog company can file its own.
  // Research orgs still see every parts kit — nothing changes for them.
  const catalogMode = settings.estimating_mode === "catalog";
  // KITS OFF (the switch board, 0352) hides the kit chips, a door. Never in catalog mode: there the
  // kits ARE how an estimate is priced (rule i), so nothing a catalog estimate prices from is gated.
  const kitDoors = featureOn(settings.features, "kits") || catalogMode;
  // A TASK kit (0386) is a task's, not the plain picker's: dropped in there it would add one unit's
  // parts and lose his hours without a word. It is offered on a task (the Inspector) — in EITHER
  // mode, so a task kit a catalog company filed under Estimate is still never a plain pick.
  const estimateKits = !kitDoors
    ? []
    : catalogMode
      ? partsKitsOnly(kits ?? []).filter((k: any) => sameScope(k.category, "Estimate"))
      : partsKitsOnly(kits ?? []);

  return (
    <div>
      <BackLink fallback="/quotes" fallbackLabel={t("qt_btn_backToEstimates")} backLabel={t("sh_back")} />
      <PageHeader title={t("nv_page_quotesNew")} description={t("nv_desc_quotesNew")}>
        {/* Onsite with no capture yet? Start the inspection from where you'll end up — one
            tap creates it (threaded to the lead when this builder came from one) and lands
            on the capture page; Start estimate there routes back here prefilled. */}
        {!capture && featureOn(settings.features, "leads") && <NewInspectionButton inquiryId={inquiry} size="sm" variant="outline" />}
      </PageHeader>
      {/* NOTHING SILENT, AND THE CONSEQUENCE NAMED. The price book and its makers arrive in one
          read, so a failure hands the picker below an empty list — which on screen reads as "you
          have no price list" rather than "this did not load". Worse, if the embed alone were ever
          to fail we would be rendering 830 as though it had no makers, and quoting the $830
          allowance for a window somebody had already decided was a Marvin. Say it at the top,
          before anybody prices anything, and leave every other control on the page working. */}
      {priceItemsErr && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">{t("qt_priceListDidntLoad")}</p>
          <p className="mt-0.5 text-sm text-amber-800">{ITEM_OPTIONS_UNAVAILABLE}</p>
        </div>
      )}
      {/* THE KITS READ, SAID (item 3): a kit-built task would otherwise seed as a bare task with no
          hours and no parts, and nobody would know why. Same banner as the price list's. */}
      {kitDoors && kitsReadWords(kitsRead.state) && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">{t("qt_kitsDidntLoadWhole")}</p>
          <p className="mt-0.5 text-sm text-amber-800">{kitsReadWords(kitsRead.state)}</p>
        </div>
      )}
      {/* THE ONE EDITOR, UNSAVED: the seed is rendered with no row; the first commit (or the mount,
          when the seed carries real lines) saves it once and the URL becomes /quotes/<id>. */}
      <EstimateEditor
        mode="unsaved"
        seed={{
          customers: (customers ?? []).map((c: any) => ({
            id: c.id,
            name: c.name,
            company_name: c.company_name,
            level_markup: c.pricing_levels?.markup_pct ?? null,
            level_rate: c.pricing_levels?.labor_rate ?? null,
          })),
          leads: leadOptions,
          preselected: customer ?? captureCustomerId,
          jobId: job ?? captureJobId,
          inquiryId: inquiry ?? captureInquiryId,
          captureId: captureApptId,
          initialScope,
          items: seededLines,
          quoteExpiryDays: expiryDays,
        }}
        catalog={{
          orgId,
          measured,
          leadPlans: effInquiryId ? { leadId: effInquiryId, files: leadPlans } : undefined,
          priceItems: (priceItems ?? []) as any,
          taxRates: (taxRates ?? []) as any,
          kits: estimateKits as any,
          taskKits,
          kitsOn: kitDoors,
          scopeWord: captureScopeWord,
          defaultMarkupPct: settings.default_markup_pct,
          defaultLaborRate: settings.default_labor_rate,
          people,
          companyEstimateFormat,
          estimatorTaskMode: settings.estimating_mode !== "catalog",
          salesTax: featureOn(settings.features, "sales_tax"),
          textReady: smsReadiness(org as { settings?: unknown } | null).ready,
          estimatesOn: featureOn(settings.features, "estimates"),
        }}
      />
    </div>
  );
}
