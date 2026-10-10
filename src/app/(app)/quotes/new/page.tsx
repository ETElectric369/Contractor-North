import { createClient } from "@/lib/supabase/server";
import { measuredOnSiteBlock, parseInspectorCapture, seedLinesFromCapture } from "@/lib/inspection/capture";
import { firstThatWorks } from "@/lib/kit-line";
import { partsKitsOnly, taskKitSelectRungs, taskKitsFrom } from "@/lib/estimate/task-kits";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { measurementsFromAnswers, tolerateMissingColumns } from "@/lib/inspection/schema";
import { readViaView } from "@/lib/inspection/inspection-access";
import { factsForEstimatorByProvenance } from "@/lib/playbook/answers";
import { applicableNeeds, clearInapplicable } from "@/lib/playbook/resolve";
import { briefProvenanceKeys, parsePlanBrief } from "@/lib/plan-brief";
import { intakeAnswerLines, intakeProvenanceKeys } from "@/lib/inquiries/carry-intake-answers";
import { extOf, intakePaths, uploadDisplayName } from "@/lib/playbook/uploads";
import { coerceScopes, ownScopes, scopeLines, type ScopePick } from "@/lib/playbook/scopes";
import { coerceTasks, type TaskValue } from "@/lib/playbook/tasks";
import type { DraftLineItem } from "@/lib/estimate/line-map";
import { coerceTaskDetail, taskFlags, taskLines, type TaskBookRow } from "@/lib/estimate/task-lines";
import { laborRateFor } from "@/lib/pricing/labor-rate";
import { sheetFromPlaybook } from "@/lib/playbook/from-sheet";
import { playbookForForm } from "@/lib/playbook/parse";
import { DECK_ESTIMATE_CODES } from "@/lib/estimate/deck";
import { ITEM_OPTIONS_EMBED, ITEM_OPTIONS_UNAVAILABLE } from "@/lib/pricing/item-options";
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
    items?: DraftLineItem[];
  } | null = null;
  if (inquiry) {
    // The id alone is NOT an adoption (review of the Q-001/E-001 flap): a builder seeded with
    // an id but default-empty state would autosave that emptiness over the draft's real lines
    // on the first keystroke. Adopting means inheriting the CONTENT too; a session draft, when
    // one exists, still restores over this (it may be newer).
    const { data: existing } = await supabase
      .from("quotes")
      .select("id, customer_id, doc_type, title, description, notes, tax_rate, valid_until, quote_line_items(description, quantity, unit, unit_price, category, sort_order, detail)")
      .eq("inquiry_id", inquiry)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      const ex = existing as {
        id: string; customer_id: string | null; doc_type: string | null; title: string | null;
        description: string | null; notes: string | null; tax_rate: number | null; valid_until: string | null;
        quote_line_items?: { description: string; quantity: number; unit: string; unit_price: number; category: string | null; sort_order: number | null; detail?: unknown }[];
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
          // detail (0386): the task behind a line rides the adoption, or the first autosave drops it.
          .map((li) => {
            const d = coerceTaskDetail(li.detail);
            // The flag is build-time only, so it is rebuilt from the breakdown: an adopted "hours?" line
            // still says so instead of reading as a $0 somebody chose.
            return { description: li.description, quantity: li.quantity, unit: li.unit, unit_price: li.unit_price, group: li.category ?? undefined, detail: d, ...(d ? { flag: taskFlags(d) } : {}) };
          }),
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
  // Square/linear feet from the inspection, handed to the kit picker so its sizing boxes open
  // with the numbers the inspector already took.
  let measured: { sqft: number | null; linearFt: number | null; byKey?: Record<string, number | null> } | undefined;
  const pickedScopes: { label: string; picks: ScopePick[] }[] = [];
  // A `tasks` answer (cn-v1073): HIS tasks, each with his hours and his parts. Priced below, once
  // the book and the customer's rate card have loaded — one line per task (lib/estimate/task-lines).
  const pickedTasks: { label: string; tasks: TaskValue[] }[] = [];
  // The rows typed on site (capture.items) and the numbers measured there (capture.measures), read
  // tolerantly (parseInspectorCapture). Saved since the typed inspector shipped, read by nothing until
  // cn-v1069: the items follow the scope picks onto the estimate, the measures join the scope text.
  let typedCapture: ReturnType<typeof parseInspectorCapture> | null = null;
  let captureInquiryId: string | undefined;
  let captureApptId: string | undefined; // verified appointment id — saveQuote stamps the write-up backlink on it
  // The inspection already knows WHOSE house this is. Without carrying these through, a repeat
  // customer's inspection wrote up into a blank estimate and you re-picked them from the full
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
      typedCapture = parseInspectorCapture((appt as any).capture);
      // THE TYPED ANSWERS GO FIRST, and are labelled as MEASURED (0165). The inspector already
      // stood in front of these numbers; making the estimator re-extract "85 ft" from a sentence
      // is a re-derivation that can silently come back with a different number. Facts above prose.
      // THROUGH appointment_answers (0366, LEAK-0227): the answers column is revoked from the
      // signed-in role, and this is the office's page, so the view hands back the answers as stored,
      // prices included. The view carries the sheet's id and the lead's id; the sheet and the lead's
      // intake are then two reads of their own (an embed through a view is PostgREST's guess, never
      // pinned, so it isn't relied on). Before 0366 the table is read the same way (readViaView). A
      // failed read is an error, exactly as before: an estimate never seeds from an inspection it
      // couldn't read. Pre-0165 (no such column on the table) is still no measured block.
      const ans = await readViaView<{ inspection_answers: unknown; inspection_template_id: string | null; inquiry_id: string | null }>(
        supabase,
        "answers",
        (from) => from.select("inspection_answers, inspection_template_id, inquiry_id").eq("id", capture).maybeSingle(),
      );
      if (ans.error && !(ans.via === "table" && String((ans.error as { code?: string }).code ?? "") === "42703")) throw ans.error;
      const [sheetRel, leadRel] = ans.data
        ? await Promise.all([
            ans.data.inspection_template_id
              ? tolerateMissingColumns<{ schema: unknown; playbook: unknown }>(() =>
                  supabase.from("forms").select("schema, playbook").eq("id", ans.data!.inspection_template_id!).maybeSingle(),
                )
              : Promise.resolve(null),
            ans.data.inquiry_id
              ? tolerateMissingColumns<{ intake: unknown }>(() =>
                  supabase.from("inquiries").select("intake").eq("id", ans.data!.inquiry_id!).maybeSingle(),
                )
              : Promise.resolve(null),
          ])
        : [null, null];
      const insp = ans.data ? { inspection_answers: ans.data.inspection_answers, forms: sheetRel, inquiry: leadRel } : null;
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
      // stranger typed it and the intake and inspection playbooks can drift until the same
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
      // A `scopes` answer is already priced line items. Collect the picks here (where the playbook
      // is in scope) and map them to lines below, once the price book has loaded — the descriptions
      // and units come from the book, not from the answer.
      // ONLY THE QUESTIONS THAT STILL APPLY, cleared to a fixed point first (the same read as the
      // facts above). A crew lead's save (0356) keeps the office's priced picks under a scopes
      // question his answers have since turned off; the Inspector hides that question, so its
      // picks must not become lines on an estimate nobody can see them on the inspection of.
      const liveAnswers = clearInapplicable(pb, answers);
      for (const n of applicableNeeds(pb, liveAnswers)) {
        if (n.slot?.type === "tasks") {
          const tasks = coerceTasks((liveAnswers as Record<string, unknown>)[n.key]);
          if (tasks?.length) pickedTasks.push({ label: n.label, tasks });
          continue;
        }
        if (n.slot?.type !== "scopes") continue;
        const picks = coerceScopes((liveAnswers as Record<string, unknown>)[n.key]);
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
  const [{ data: customers }, { data: leadRows }, { data: priceItems, error: priceItemsErr }, { data: taxRates }, { data: kits }, { data: org }] =
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
      supabase
        .from("price_list_items")
        .select(`id, code, description, category, unit, buy_price, markup_pct, updated_at, ${ITEM_OPTIONS_EMBED}`)
        .eq("archived", false)
        .eq("price_list_item_options.archived", false)
        .order("description")
        .limit(2000),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      // THE SHARED SELECT SHAPE (kit-line.ts): kit lines with their 0166 sizing and, since 0240,
      // their price-list link + the item embed, so a linked line prices LIVE for this customer in
      // the picker. Three rungs, most capable first — a deploy precedes its migration, and naming
      // an absent column fails the whole query rather than degrading, which would empty the kit
      // picker until the migration landed.
      firstThatWorks(taskKitSelectRungs().map((sel) => () => supabase.from("kits").select(sel).order("name"))),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);
  // THE INSPECTION'S PICKS, AS REAL LINES. Descriptions and units come from the org's own book
  // (the answer stores codes, never prose), and a code that has since left the price list is
  // dropped rather than rendered as a bare code with a price beside it.
  const settings = getOrgSettings((org as any)?.settings);
  const book = new Map((priceItems ?? []).map((p: any) => [p.code as string, { description: p.description, unit: p.unit }]));
  const bookCodes = new Set(book.keys());
  // HIS TASKS, AS LINES: one per task, priced from his hours at THE labor rate (the inspection's
  // customer's level rate, else the org default: laborRateFor) and his parts at the book's cost
  // through THE markup rule for that customer. A task without hours is a $0 line that asks.
  const taskBook = new Map<string, TaskBookRow>(
    (priceItems ?? []).filter((p: any) => p.code).map((p: any) => [String(p.code), p as TaskBookRow]),
  );
  const seedCustomer = captureCustomerId ? ((customers ?? []) as any[]).find((c) => c.id === captureCustomerId) : undefined;
  const seedPricing = { levelPct: seedCustomer?.pricing_levels?.markup_pct ?? null, orgDefaultPct: settings.default_markup_pct };
  const seedRate = laborRateFor(seedCustomer?.pricing_levels?.labor_rate, settings.default_labor_rate);
  // HIS TASK KITS (0386, W4): a task that picked one expands here — his minutes per unit × the
  // units, the kit's parts × the units — through THE one expandTaskKit (task-lines.ts), the same
  // function the Inspector previewed it with.
  const taskKits = taskKitsFrom(kits);
  const taskKitMap = new Map(taskKits.map((k) => [k.id, k]));
  const taskSeed = pickedTasks.flatMap((g) =>
    taskLines(g.tasks, { book: taskBook, rate: seedRate, pricing: seedPricing, kits: taskKitMap, group: g.label }),
  );
  // …THEN THE ROWS TYPED ON SITE, unpriced (cn-v1069, lib/inspection/capture seedLinesFromCapture):
  // "200 ft 12-2 romex" typed standing at the panel is a line Erik prices, never a sentence he
  // re-reads to make one.
  const seededLines: DraftLineItem[] = seedLinesFromCapture(
    [...pickedScopes.flatMap((g) => scopeLines(ownScopes(g.picks, bookCodes), book, g.label)), ...taskSeed],
    typedCapture?.items,
  );

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
  // Catalog-mode orgs (Tahoe Deck) estimate from TWO scope kits — "Decks" and "Remodels".
  // The granular material kits (Framing, Hardware, Decking…) are the POST-acceptance job
  // breakdown, so they're hidden from the estimate picker here. Research orgs (ET Electric)
  // still see every kit — nothing changes for them.
  const catalogMode = settings.estimating_mode === "catalog";
  // KITS OFF (the switch board, 0352) hides the kit chips, a door. Never in catalog mode: there the
  // kits ARE how an estimate is priced (rule i), so nothing a catalog estimate prices from is gated.
  const kitDoors = featureOn(settings.features, "kits") || catalogMode;
  const estimateKits = !kitDoors
    ? []
    : catalogMode
      ? (kits ?? []).filter((k: any) => k.name === "Decks" || k.name === "Remodels")
      : // A TASK kit (0386) is a task's, not the plain picker's: dropped in there it would add one
        // unit's parts and lose his hours without a word. It is offered on a task (the Inspector).
        partsKitsOnly(kits ?? []);
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
          <p className="text-sm font-medium text-amber-900">Price list didn&apos;t load</p>
          <p className="mt-0.5 text-sm text-amber-800">{ITEM_OPTIONS_UNAVAILABLE}</p>
        </div>
      )}
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
        leads={leadOptions}
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
        taskKits={taskKits.map(({ id, name, unit }) => ({ id, name, unit }))}
        kitsOn={kitDoors}
        quoteExpiryDays={expiryDays}
        defaultMarkupPct={settings.default_markup_pct}
        defaultLaborRate={settings.default_labor_rate}
        estimatorTaskMode={settings.estimating_mode !== "catalog"}
        deckRateRows={deckRateRows}
        salesTax={featureOn(settings.features, "sales_tax")}
      />
    </div>
  );
}
