"use server";
import { jobLabel, readUsualBillingKind } from "@/lib/schedule-options";
import { reportError } from "@/lib/observe";
import { customerForInquiry } from "@/lib/actions/win-customer";
import { dbError } from "@/lib/db-error";
import { parseAiJson } from "@/lib/ai-json";
import { statedLaborRate } from "@/lib/estimate/stated-rate";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { headers } from "next/headers";
import { bustDocPdf, warmDocPdf } from "@/lib/pdf-cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { INTAKE_BUCKET, extOf, intakePaths, isOwnIntakePath, uploadDisplayName } from "@/lib/playbook/uploads";
import { pickReadablePlans } from "@/lib/plan-brief";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { createNotifications } from "@/lib/notifications";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { QUOTE_STATUSES } from "@/lib/statuses";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { effectiveMarkupPct } from "@/lib/pricing/markup";
import {
  ITEM_OPTIONS_EMBED,
  chooseItemOption,
  defaultItemOptionId,
  missingOptionMessage,
  type OptionedPriceItem,
} from "@/lib/pricing/item-options";
import { reviewAgainstBook, type BookReview } from "@/lib/pricing/book-review";
import { runCalc } from "@/lib/electrical-calc";
import { estimatorCalcTools, estimatorQuantitiesLine } from "@/lib/nort/trade-prompt";
import { recordAiUsage, aiAllowed, currentOrgId, fullEstimatesThisMonth, orgPlanTier, noteEstimateRun, modelFor } from "@/lib/ai-cost";
import { estimateTierFor, overFullEstimateAllowance, planByTier } from "@/lib/plans";
import { rateLimited } from "@/lib/rate-limit";
import type Anthropic from "@anthropic-ai/sdk";
import { getOrgSettings, accentHex, orgDocUrl } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { jobNameFrom } from "@/lib/job-name";
import { checkComeBackDay } from "@/lib/come-back-days";
import { isMissingColumn } from "@/lib/job-tasks";
import { orgTrade, tradeWordsOr, withArticle } from "@/lib/org-trade";
import { closeVisitsBehindQuote, outcomeForQuoteStatus } from "@/lib/appointments/behind-quote";
import { rowPlace } from "@/lib/doc-place";
import { companyFromOrg } from "@/components/doc-letterhead";
import { mapEstimatorLine, type DraftLineItem, type BookRow, type LadderPrice, type TaskDetail } from "@/lib/estimate/line-map";
import { coerceTaskDetail } from "@/lib/estimate/task-lines";
import { bornWithTasks } from "@/lib/estimate/born-with-tasks";
import { estimateLines, retitleDismissal, retitleLineTask, syncJobTasks, syncWords } from "@/lib/estimate/sync-job-tasks";
import { materialsWords, syncJobMaterials } from "@/lib/estimate/sync-job-materials";
import { revisionOf, supersedeRevised, supersededWords } from "@/lib/estimate/revision";
import { taskBookFromRows, taskModeDraft, taskModePrompt, type TaskModeParsed } from "@/lib/estimate/task-mode";
import { laborRateFor } from "@/lib/pricing/labor-rate";
import { priceMaterial } from "@/lib/pricing/price-material";
import { sendEmail, renderQuoteNoticeEmail, ownerBcc } from "@/lib/email";
import { sendSms, smsReadiness } from "@/lib/sms";
import { TEXT_NOT_READY_REFUSAL, TEXT_REFUSED } from "@/lib/sms-readiness";
import { orgAccess } from "@/lib/org-access";
import { textingPausedWordsFor } from "@/lib/lapse-words";
import { createWorkOrderFromQuote } from "../work-orders/actions";
import { createMaterialListFromQuote } from "../materials/actions";
import { visibleCustomerIdOrNull } from "@/lib/job-visibility";
import { docLabel, type QuoteDocType } from "@/lib/doc-label";
import type { EditorQuote, QuoteCircuit, QuoteLineItem } from "@/lib/types";
import { promptCodeTable } from "@/lib/panel/breaker-catalog";
import { isEstimatorStash, keepPlanUpload, type KeptPlan } from "@/lib/estimate/keep-plan-upload";

/* Built from the ORG's settings, not NEXT_PUBLIC_SITE_URL — see orgDocUrl in lib/org-settings.
   Both callers below already fetch the org row, so this costs no extra query. */

export async function setQuoteType(id: string, docType: "estimate" | "quote") {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // The Estimate|Quote label is a LEGAL claim on the document — QuoteDocument prints a
  // "fixed price" sentence for a quote and a "not a contract" one for an estimate. Flipping it
  // after the customer already has a copy leaves their stored PDF asserting the wrong basis
  // (audit v921 high). Only reshape a DRAFT; once it's out, the pricing basis is fixed.
  const { data: cur } = await supabase.from("quotes").select("status").eq("id", id).maybeSingle();
  const curStatus = (cur as { status?: string } | null)?.status;
  if (curStatus && curStatus !== "draft") {
    return { ok: false, error: "This estimate was already sent — its type can't be changed. Duplicate it to start a new one." };
  }
  const { data: wrote, error } = await supabase
    .from("quotes")
    .update({ doc_type: docType, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That estimate could not be found." };
  await bustDocPdf("quote", id); // even a draft may have a cached preview
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true };
}

export async function textQuote(
  id: string,
): Promise<{ ok: boolean; error?: string; notReady?: boolean }> {
  const supabase = await createClient();
  const { data: quote } = await supabase
    .from("quotes")
    // THE LEAD RIDES ALONG (PROJECTION LAW). An estimate can be made out to a lead — the printed
    // document and the public /q link have coalesced onto the inquiry since 0119 — but Send only
    // ever asked for the customer, so texting a perfectly reachable prospect answered "this
    // customer has no phone number" about a customer that was never supposed to exist yet.
    .select("quote_number, total, public_token, doc_type, status, address, customers(name, phone, address), inquiry:inquiry_id(name, phone, address), jobs(address)")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  const { data: org } = await supabase.from("organizations").select("id, name, settings").maybeSingle();
  // TEXTING NOT SET UP (lib/sms-readiness): said here, where he tapped, before anything is promised
  // or stamped. Nothing is sent and the estimate stays a draft.
  if (!smsReadiness(org).ready) return { ok: false, notReady: true, error: TEXT_NOT_READY_REFUSAL };
  // THE PLAN HAS ENDED (cn-v1137, decision 3): a lapsed company sends no texts. Said where he
  // tapped, in his role (the owner is told the door, everyone else the owner); nothing is sent.
  const quoteOrgId = (org as { id?: string } | null)?.id;
  const access = await orgAccess(quoteOrgId);
  if (!access.state.active) return { ok: false, error: await textingPausedWordsFor(quoteOrgId) };
  // Same order the document itself resolves in: the customer when there is one, else the lead.
  const customer = (quote as any).customers ?? (quote as any).inquiry;
  if (!customer?.phone)
    return { ok: false, error: "There's no phone number on file for whoever this estimate is for — add one on their lead or contact, then send again." };

  const label = docLabel(quote as { doc_type?: string | null });
  const link = orgDocUrl(getOrgSettings((org as any)?.settings), "q", (quote as any).public_token, rowPlace(quote as any));
  const body = `${org?.name ?? "Your contractor"}: ${label} ${quote.quote_number} ($${Number(quote.total).toFixed(2)}). View: ${link}`;

  const sent = await sendSms(customer.phone, body, (org as any)?.settings?.sms_from_number);
  // Texting is set up (asked above), so a false here is the service refusing it; sendSms has
  // already logged why. It is never "add your Twilio account" on an account that has one.
  if (!sent) return { ok: false, error: TEXT_REFUSED };
  // Mark as sent once texted (unless already accepted/declined) — mirrors emailQuote.
  if (["draft"].includes((quote as any).status ?? "")) {
    await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
  }
  // Warm the stored PDF (0198) post-response so the customer's Download button works from the
  // first minute — after() never slows the send, and the render carries this sender's cookies.
  const h = await headers();
  const warmHost = h.get("x-forwarded-host") ?? h.get("host");
  const warmProto = h.get("x-forwarded-proto") ?? "https";
  const warmCookie = h.get("cookie");
  // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
  after(async () => {
    if (warmHost) await warmDocPdf("quote", id, `${warmProto}://${warmHost}`, warmCookie);
  });
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true };
}

/**
 * SHARE SHEET payload for an estimate — the twin of invoiceShareText (billing/actions.ts).
 *
 * The invoice grew a share payload after Erik fell back to the iOS share sheet on the PDF preview
 * and the customer received the app's marketing blurb and a login URL. The estimate page never got
 * the twin: its only doors were Email and Text, both of which refuse until a number or an address
 * is on file — and a share sheet is exactly the door for the customer who has neither. What goes
 * out is the customer's own /q/<token> link on this business's domain, worded exactly like
 * textQuote above: one message, whichever way it leaves.
 *
 * A DRAFT'S LINK IS A 404. public_quote serves only sent/accepted/declined/expired
 * (customerMayOpen / CUSTOMER_VISIBLE_STATUSES.quote in lib/customer-visible-docs — the gate to
 * CALL, not a list to copy), so a draft's link would land the customer on
 * "Not found". Every other egress flips draft→sent on the way past (textQuote, emailQuote); the
 * share sheet has no send step to hang that on, so it ASKS — needsSend → the button's plain-words
 * confirm — and flips only on that explicit yes. STAMP FOLLOWS DEED, and NOTHING SILENT.
 */
export async function quoteShareText(
  id: string,
  opts?: { sendIt?: boolean },
): Promise<{ ok: boolean; error?: string; needsSend?: boolean; title?: string; text?: string; url?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: quote } = await supabase
    .from("quotes")
    .select("quote_number, total, public_token, doc_type, status, address, customers(address), inquiry:inquiry_id(address), jobs(address)")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "That estimate could not be found." };
  const label = docLabel(quote as { doc_type?: string | null });
  const token = (quote as { public_token?: string | null }).public_token;
  if (!token) return { ok: false, error: `This ${label.toLowerCase()} has no customer link yet — send it by Email or Text instead.` };

  if (String((quote as { status?: string | null }).status ?? "") === "draft") {
    if (!opts?.sendIt) {
      return {
        ok: false,
        needsSend: true,
        error: `Sharing marks ${quote.quote_number} as sent — the customer link only works on a sent ${label.toLowerCase()}.`,
      };
    }
    // SILENT-WRITE LAW: a zero-row UPDATE is a 204. Read the row back before handing out a link
    // that would 404 on a document still stuck at draft.
    const { data: wrote, error } = await supabase.from("quotes").update({ status: "sent" }).eq("id", id).select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!wrote?.length) return { ok: false, error: `Couldn't mark ${quote.quote_number} as sent — send it by Email or Text instead.` };
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/quotes");
  }

  // One org query for both the name and the link base — textQuote's shape, so the link is built
  // from the ORG's settings (its own domain), never NEXT_PUBLIC_SITE_URL.
  const { data: org } = await supabase.from("organizations").select("name, settings").maybeSingle();
  const who = org?.name ?? "Your contractor";
  const url = orgDocUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings), "q", token, rowPlace(quote));
  return {
    ok: true,
    title: `${label} ${quote.quote_number} — ${who}`,
    text: `${who}: ${label} ${quote.quote_number} ($${Number(quote.total).toFixed(2)}). View:`,
    url,
  };
}

export async function emailQuote(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    // The lead too — same reason as textQuote above: an estimate made out to a lead is a real,
    // sendable document, and the /q link it carries already prints the lead's name.
    .select("*, customers(name, email, address), inquiry:inquiry_id(name, email, address), jobs(address)")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  const customer = (quote as any).customers ?? (quote as any).inquiry;
  if (!customer?.email)
    return { ok: false, error: "There's no email address on file for whoever this estimate is for — add one on their lead or contact, then send again." };
  const label = docLabel(quote as { doc_type?: string | null });

  const { data: org } = await supabase
    .from("organizations")
    .select("name, phone, email, settings")
    .maybeSingle();
  // After the org fetch, because the link is built from the org's own domain now.
  const link = orgDocUrl(getOrgSettings((org as any)?.settings), "q", (quote as any).public_token, rowPlace(quote as any));

  // Link-only notice (no re-rendered line-item table): the canonical document
  // lives at the /q link, so the email can never drift from the print/portal
  // view — mirrors the renderInvoiceNoticeEmail decision.
  const html = renderQuoteNoticeEmail({
    docType: label,
    number: quote.quote_number,
    company: {
      name: org?.name ?? "Contractor North",
      brand: accentHex(getOrgSettings((org as any)?.settings).glass_tint),
      // The company's own tagline (doc_style.tagline), the one its letterhead prints.
      tagline: companyFromOrg(org as any).tagline,
      phone: org?.phone,
      email: org?.email,
    },
    customerName: customer.name,
    title: quote.title,
    total: quote.total,
    quoteLink: link,
  });

  const res = await sendEmail({
    to: customer.email,
    subject: `${label} ${quote.quote_number} from ${org?.name ?? "us"}`,
    fromName: org?.name ?? undefined,
    html,
    replyTo: org?.email ?? undefined,
    bcc: ownerBcc(getOrgSettings((org as any)?.settings).copy_owner_on_emails, org?.email),
  });
  if (!res.ok) return res;

  // Mark as sent once emailed (unless already accepted/declined).
  if (["draft"].includes(quote.status)) {
    await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
  }
  // Warm the stored PDF (0198) post-response so the customer's Download button works from the
  // first minute — after() never slows the send, and the render carries this sender's cookies.
  const h = await headers();
  const warmHost = h.get("x-forwarded-host") ?? h.get("host");
  const warmProto = h.get("x-forwarded-proto") ?? "https";
  const warmCookie = h.get("cookie");
  // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
  after(async () => {
    if (warmHost) await warmDocPdf("quote", id, `${warmProto}://${warmHost}`, warmCookie);
  });
  revalidatePath(`/quotes/${id}`);
  return { ok: true };
}

/** Re-exported so the existing importers (quote builder, kit picker, deck panel) don't move.
 *  The definition lives with the pricing rules in @/lib/estimate/line-map. */
export type { DraftLineItem } from "@/lib/estimate/line-map";

export interface SaveQuoteInput {
  /** An existing DRAFT to update in place — the builder's autosave (Andrew's 45 accepted
      plan lines lived only in client state and vanished; a draft row is the fix). Absent =
      insert a new quote. Update is draft-locked: sent/accepted rows refuse it. */
  id?: string | null;
  customer_id: string | null;
  job_id?: string | null;
  /** The lead this estimate was seeded from (provenance backlink) — set when a lead is
      converted to a quote; null for quotes started from scratch. */
  inquiry_id?: string | null;
  /** The inspection appointment this estimate writes up (/quotes/new?capture=<id>) — on save
      the quote id is stamped onto that appointment's capture jsonb so the Inspections tab can
      file a LEAD-LESS "Inspect now" row (no inquiry/job to match otherwise). */
  capture_appointment_id?: string | null;
  title: string;
  description?: string | null;
  notes: string;
  tax_rate: number;
  valid_until: string | null;
  /** The customer-facing document word (builder toggle) — omitted = 'estimate',
   *  matching the app's estimate-first default (migration 0086). */
  doc_type?: QuoteDocType;
  /** HOW THIS ESTIMATE'S TASK LINES READ ON PAPER (cn-v1131, 0395): "tasks" | "detailed" for its own
   *  word, null for the company's Doc Studio choice. Omitted = the column is not touched. */
  estimate_format?: "tasks" | "detailed" | null;
  items: DraftLineItem[];
}

/** The accepted-quote lock — the quote-side twin of requireDraftInvoice.
 *
 *  An accepted quote IS the contract, and `contractTotalFromQuotes` reads its live total.
 *  A partially-drawn payment schedule prices already-billed milestones off their FROZEN
 *  billed_amount but recomputes pending ones as `percent × the CURRENT contract` — so
 *  editing an accepted quote after the deposit is drawn silently re-bases the rest of the
 *  schedule. Drop a $10,000 quote to $8,000 after a $3,000 deposit and the remaining 40/30
 *  draws come to $5,600, billing $8,600 against an $8,000 contract; edit it upward and the
 *  difference is never billed. setPaymentSchedule's over-contract check only ever runs at
 *  schedule-creation time, so nothing downstream catches the drift.
 *
 *  A scope change after acceptance is a legitimate business event, so this is NOT a freeze
 *  on every accepted quote — only on one whose schedule has already drawn real money. The
 *  escape hatch is to revise: duplicate the quote (or void the draw), don't mutate the
 *  contract under a customer who already paid against it. */
async function requireEditableQuote(
  supabase: any,
  quoteId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: quote } = await supabase
    .from("quotes")
    .select("status, job_id, quote_number, doc_type")
    .eq("id", quoteId)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  // SUPERSEDED (0391): replaced by its revision — the revision is the paper to edit now. With no
  // revision standing (deleted, or walked back) the estimate is his again: editable, and its status
  // may be set back by hand (updateQuoteStatus applies the same test).
  if ((quote as any).status === "superseded") {
    let rev: { id: string; quote_number: string | null } | null;
    try {
      rev = await revisionOf(supabase, { quoteId, orgId: null });
    } catch (e) {
      return { ok: false, error: `Couldn't check whether a revision replaced this estimate (${e instanceof Error ? e.message : String(e)}) — try again.` }; // fail closed, said
    }
    if (rev) return { ok: false, error: `${(quote as any).quote_number || "This estimate"} is superseded by ${rev.quote_number ?? "its revision"} — edit that one instead.` };
    return { ok: true };
  }
  if ((quote as any).status !== "accepted") return { ok: true };
  const jobId = (quote as any).job_id as string | null;
  if (!jobId) return { ok: true }; // accepted but no job yet → no schedule to shift

  const label0 = docLabel(quote as { doc_type?: string | null });

  /**
   * A SIGNATURE IS A LOCK, AND THIS GUARD DIDN'T KNOW CONTRACTS EXISTED (audit v800 wave B).
   *
   * The only thing that froze an accepted estimate was a BILLED DRAW. But the ordinary sequence
   * is: quote accepted → contract generated from it → customer signs → work starts → the first
   * draw is billed weeks later. In that whole gap the estimate was fully editable, and editing a
   * line runs recalcQuote, which rewrites the total.
   *
   * That total is not decoration. contractTotalFromQuotes derives the CONTRACT total from the
   * job's quotes, and the payment schedule is percentages of it — so changing a line after the
   * customer signs silently re-prices every remaining draw. Meanwhile the contract's signed_body
   * is frozen by 0068's trigger, so the paper the customer actually signed still shows the old
   * figure. The document and the arithmetic quietly stop agreeing, and nothing says so.
   *
   * Void doesn't count: a voided contract is the org saying the agreement doesn't stand, which
   * is precisely when re-pricing is legitimate. Same exit as the draw lock — duplicate it as a
   * revision, which is what a change order or a revised contract is for anyway.
   */
  const { data: signed } = await supabase
    .from("contracts")
    .select("contract_number, signed_at")
    .eq("job_id", jobId)
    .eq("status", "signed")
    .limit(1)
    .maybeSingle();
  if (signed) {
    const num = (signed as { contract_number?: string | null }).contract_number;
    return {
      ok: false,
      error: `${(quote as any).quote_number || `This ${label0.toLowerCase()}`} priced ${num ? `contract ${num}` : "a contract"}, which the customer has already signed — changing it now would re-price the draws against a total they never agreed to. Revise it instead (or void the contract).`,
    };
  }

  // "Drawn" = a milestone linked to an invoice that still stands. A deleted/void draw
  // releases the lock (deleting a draft draw nulls the FK, the same signal the schedule
  // itself uses for billed-vs-pending), so a mistaken draw doesn't wedge the quote.
  const { data: drawn } = await supabase
    .from("payment_milestones")
    .select("invoice_id, invoices(status)")
    .eq("job_id", jobId)
    .not("invoice_id", "is", null);
  const live = ((drawn ?? []) as any[]).filter((m) => (m.invoices?.status ?? "") !== "void");
  if (!live.length) return { ok: true };

  return {
    ok: false,
    error: `${(quote as any).quote_number || `This ${label0.toLowerCase()}`} is accepted and ${live.length} scheduled payment${live.length === 1 ? " has" : "s have"} already been billed against it — changing it now would re-price the remaining draws. Revise it instead (or void the draw).`,
  };
}

/**
 * THE SAME REFUSAL, ASKED IN ADVANCE, SO THE PAGE CAN STOP OFFERING WHAT THE SERVER WILL REJECT.
 *
 * The quote editor's pencil, trash and price-list picker rendered at every status, so on a locked
 * estimate every one of them was a control that could only ever produce a red toast — the INV-069
 * shape, on another page (2026-09-18).
 *
 * The obvious fix is the wrong one: gating on `status === "accepted"` in the component would hide
 * controls that still WORK, because acceptance alone does not lock anything. What locks an
 * estimate is an accepted quote whose job carries a signed contract or a billed draw, and that
 * takes two more queries to know. A gate that disagrees with the server rule is the same bug
 * moved, so this asks the rule itself rather than approximating it, and hands back the very
 * sentence the server would have refused with — including the way out it already names
 * ("Revise it instead"). One extra read on a page that already makes several, in exchange
 * for a gate that cannot drift.
 */
export async function quoteEditLock(quoteId: string): Promise<{ reason: string } | null> {
  const ctx = await requireStaff();
  if ("error" in ctx) return null; // not this function's refusal to make; the actions still guard
  const editable = await requireEditableQuote(ctx.supabase, quoteId);
  return editable.ok ? null : { reason: editable.error };
}

/** THE COLUMNS THE ONE EDITOR READS (cn-v1132) — named (projection law), as the saved page's `*` once
 *  carried them: the header, the money, the paper's words (doc_type, estimate_format), the pointers
 *  (customer, job, lead, the estimate this revises), the offer's dates, the public link, the panel's
 *  circuits and the row's own address. A const so each select is a string literal the client's select
 *  parser can read into a row type, where a template built at run time is not. */
const EDITOR_QUOTE_COLUMNS =
  "id, quote_number, customer_id, job_id, inquiry_id, status, doc_type, title, description, notes, tax_rate, subtotal, tax, total, valid_until, follow_up_at, estimate_format, revises_quote_id, public_token, circuits, address, unit, city, state, zip, accepted_at, declined_at, created_by, created_at, updated_at" as const;
const EDITOR_ITEM_COLUMNS = "id, quote_id, description, quantity, unit, unit_price, line_total, sort_order, category, detail" as const;

/**
 * THE ONE EDITOR'S READ (cn-v1132): the estimate's row and its lines, whole. STAFF ONLY — 0056's RLS
 * keeps the quotes table staff-only, so a member gate here would only ever hand a tech "Quote not
 * found." dressed as a door (a tech reaches the paper from a work order's Source Estimate, which is
 * its own page and its own read). Both reads are scoped to the company beside RLS. Every line's
 * breakdown comes through coerceTaskDetail (the pre-1131 one-figure shape reads as one legacy row),
 * its group is null when it has none, and the money columns are numbers, not the wire's strings. A
 * failed read is said; a row that is not here is "Quote not found."
 */
export async function readQuoteForEditor(
  quoteId: string,
): Promise<{ ok: true; quote: EditorQuote; items: QuoteLineItem[] } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  const supabase: any = ctx.supabase;
  const [q, li] = await Promise.all([
    supabase.from("quotes").select(EDITOR_QUOTE_COLUMNS).eq("id", quoteId).eq("org_id", ctx.orgId).maybeSingle(),
    supabase.from("quote_line_items").select(EDITOR_ITEM_COLUMNS).eq("quote_id", quoteId).eq("org_id", ctx.orgId).order("sort_order"),
  ]);
  if (q.error) return { ok: false, error: dbError(q.error) };
  if (!q.data) return { ok: false, error: "Quote not found." };
  if (li.error) return { ok: false, error: dbError(li.error) };
  const n = (v: unknown): number => Number(v ?? 0) || 0;
  const row = q.data as Record<string, unknown>;
  const quote = { ...row, tax_rate: n(row.tax_rate), subtotal: n(row.subtotal), tax: n(row.tax), total: n(row.total) } as unknown as EditorQuote;
  const items = ((li.data ?? []) as Record<string, unknown>[]).map(
    (r) =>
      ({
        ...r,
        quantity: n(r.quantity),
        unit_price: n(r.unit_price),
        line_total: n(r.line_total),
        sort_order: n(r.sort_order),
        category: typeof r.category === "string" && r.category ? r.category : null,
        detail: coerceTaskDetail(r.detail),
      }) as unknown as QuoteLineItem,
  );
  return { ok: true, quote, items };
}

/**
 * THE READ-BACK AFTER BIRTH (cn-v1132, S4): the ids of an estimate's lines and where each sits —
 * nothing else. The editor needs only these to write each line on its own after the first save
 * (idsBySortOrder), and a lean read cannot dead-end a birth on a column the whole-row read names
 * (a deploy ahead of its migration). Staff, scoped to the company beside RLS; a failed read is said.
 */
export async function readQuoteLineIds(
  quoteId: string,
): Promise<{ ok: true; items: { id: string; sort_order: number | null; description: string }[] } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  const supabase: any = ctx.supabase;
  const { data, error } = await supabase.from("quote_line_items").select("id, sort_order, description").eq("quote_id", quoteId).eq("org_id", ctx.orgId).order("sort_order");
  if (error) return { ok: false, error: dbError(error) };
  const items = ((data ?? []) as { id: string; sort_order?: number | string | null; description?: string | null }[]).map((r) => ({
    id: String(r.id),
    sort_order: r.sort_order == null ? null : Number(r.sort_order),
    description: String(r.description ?? ""),
  }));
  return { ok: true, items };
}

/** The job an estimate is linked to, whatever its status — null when it has none. (A rename follows the
 *  job's task at ANY status: the task's own old-title guard is what protects a hand rename, and a task
 *  renamed only while accepted would otherwise disagree with its line for good after a walk-back.) */
async function jobOf(supabase: any, quoteId: string): Promise<string | null> {
  const { data: q } = await supabase.from("quotes").select("job_id").eq("id", quoteId).maybeSingle();
  return (q as { job_id?: string | null } | null)?.job_id ?? null;
}

/**
 * THE JOB BEHIND AN ACCEPTED ESTIMATE, AND THE ESTIMATE'S FIGURE BEFORE A CHANGE (item 1, 2026-10-10).
 * jobs.planned_minutes carries no "came from the estimate" mark (0229), so the figure is read BEFORE
 * the change: the size follows only while the box still holds it (lib/estimate/sync-job-tasks).
 * sizeBefore undefined = the figure could not be read, so the size is left alone. tasksBefore is the
 * same figure per task line (0395): a task whose own minutes still equal what its line said before
 * follows the line; without it only an empty figure follows and the sync would say a task "kept its
 * hours — set on the job" when nobody set anything. partsBefore is the materials twin (cn-v1133):
 * each part's count as its line said it before, so a buy-list row still holding it follows the line.
 */
type FigureBefore = {
  sizeBefore: number | null | undefined;
  tasksBefore: ReadonlyMap<string, number | null> | undefined;
  partsBefore: ReadonlyMap<string, number> | undefined;
};
const figureBefore = (est: Awaited<ReturnType<typeof estimateLines>>): FigureBefore =>
  est.error ? { sizeBefore: undefined, tasksBefore: undefined, partsBefore: undefined } : { sizeBefore: est.minutes, tasksBefore: est.taskMinutes, partsBefore: est.partCounts };

async function jobBehindQuote(
  supabase: any,
  quoteId: string,
  orgId: string | null,
): Promise<({ jobId: string } & FigureBefore) | null> {
  const { data: q } = await supabase.from("quotes").select("job_id, status").eq("id", quoteId).maybeSingle();
  const jobId = (q as { job_id?: string | null } | null)?.job_id ?? null;
  if (!jobId || (q as { status?: string } | null)?.status !== "accepted") return null;
  const est = await estimateLines(supabase, { jobId, orgId });
  return { jobId, ...figureBefore(est) };
}

/**
 * DOES THIS PATCH MOVE THE LINE'S FIGURE (cn-v1133)? The one editor sends the count, the price and the
 * breakdown on every write, so "a key is present" ran the job's two rules on a description-only edit
 * and said "N kept their hours" each time. Each figure the patch carries is compared to the stored
 * row: the count and the price as numbers, the breakdown as the coerced shape (both sides through
 * coerceTaskDetail, so key order and rounding are the one reader's), null against null.
 */
function figureDiffers(was: { quantity?: unknown; unit_price?: unknown; detail?: unknown }, clean: Record<string, unknown>): boolean {
  if (clean.quantity !== undefined && Number(was.quantity) !== Number(clean.quantity)) return true;
  if (clean.unit_price !== undefined && Number(was.unit_price) !== Number(clean.unit_price)) return true;
  if (clean.detail !== undefined) {
    const stored = coerceTaskDetail(was.detail);
    if (clean.detail === null || stored === null) return (clean.detail === null) !== (stored === null);
    return JSON.stringify(stored) !== JSON.stringify(clean.detail);
  }
  return false;
}

/** Run the two rules — the job's tasks (lib/estimate/sync-job-tasks), then its buy list
 *  (lib/estimate/sync-job-materials, 0390) — and say what they did, or that one could not. */
async function jobFollows(
  supabase: any,
  who: { jobId: string; sizeBefore?: number | null; tasksBefore?: ReadonlyMap<string, number | null>; partsBefore?: ReadonlyMap<string, number> },
  ctx: { orgId: string | null; userId: string },
  /** Whose list the sentences name, when it is not the obvious job (the one an estimate was moved off). */
  lead?: { tasks: string; materials: string },
): Promise<{ said?: string; note?: string }> {
  const res = await syncJobTasks(supabase, { jobId: who.jobId, orgId: ctx.orgId, createdBy: ctx.userId, sizeBefore: who.sizeBefore, tasksBefore: who.tasksBefore });
  const mats = await syncJobMaterials(supabase, { jobId: who.jobId, orgId: ctx.orgId, userId: ctx.userId, partsBefore: who.partsBefore });
  revalidatePath(`/jobs/${who.jobId}`);
  revalidatePath("/schedule");
  revalidatePath("/materials");
  const notes: string[] = [];
  if (res.error) {
    reportError("jobFollowsEstimate", new Error(res.error), { jobId: who.jobId });
    notes.push(`The job's list could not follow this change (${res.error}). Check its tasks.`);
  }
  if (mats.error) {
    reportError("jobFollowsEstimate:materials", new Error(mats.error), { jobId: who.jobId });
    notes.push(`The buy list could not follow this change (${mats.error}). Check the job's materials.`);
  }
  const said = [res.error ? null : syncWords(res, lead?.tasks), mats.error ? null : materialsWords(mats, lead?.materials)].filter(Boolean).join(" ");
  return { ...(said ? { said } : {}), ...(notes.length ? { note: notes.join(" ") } : {}) };
}

/** Recompute subtotal/tax/total from the quote's line items. */
async function recalcQuote(supabase: any, quoteId: string) {
  // A FAILED READ IS NOT AN EMPTY QUOTE (audit v800 — the audit-8 guard that already protects
  // recalcInvoice, finally ported here). supabase-js returns data:null on any error, and
  // `(items ?? [])` turned one transient timeout into subtotal/tax/total = 0 written straight
  // over a real estimate — with the PDF busted so the customer's copy showed $0 too.
  const [quoteRes, itemsRes] = await Promise.all([
    supabase.from("quotes").select("tax_rate").eq("id", quoteId).maybeSingle(),
    supabase.from("quote_line_items").select("line_total").eq("quote_id", quoteId),
  ]);
  if (quoteRes.error || itemsRes.error || !itemsRes.data) {
    reportError("recalcQuote:read", quoteRes.error ?? itemsRes.error ?? new Error("no rows object"), { quoteId });
    // (returns null below — the caller keeps whatever it computed rather than showing zeros)
    // Leave the stored TOTALS alone — a failed read is not an empty quote. But the caller only
    // reaches recalc after CHANGING a line, so the stored PDF is stale no matter what happened
    // here: bust it anyway, or the customer's Download button keeps handing out a document that
    // shows neither the new line nor the old total (v800 verification).
    await bustDocPdf("quote", quoteId);
    return null;
  }
  const { subtotal, tax, total } = subtotalTaxTotal(
    itemsRes.data.map((i: any) => Number(i.line_total ?? 0)),
    Number(quoteRes.data?.tax_rate ?? 0),
  );
  const { data: upd, error: updErr } = await supabase
    .from("quotes")
    .update({ subtotal, tax, total })
    .eq("id", quoteId)
    .select("id");
  if (updErr || !upd?.length) reportError("recalcQuote:write", updErr ?? new Error("zero rows"), { quoteId });
  // A sent quote stays editable (unlike an invoice), so every content write funnels here —
  // drop the stored PDF (0198) or the customer's Download button would hand out old numbers.
  await bustDocPdf("quote", quoteId);
  return { subtotal, tax, total };
}

/** The insert itself, shared by the hand-typed door and the price-list door below, so the two can
 *  never drift on sort order, rounding or what a refusal sounds like. Assumes the caller has
 *  already passed requireStaff + requireEditableQuote. */
async function appendQuoteLine(
  supabase: any,
  quoteId: string,
  item: { description: string; quantity: number; unit?: string; unit_price: number },
): Promise<{ ok: boolean; error?: string }> {
  const { data: last } = await supabase
    .from("quote_line_items")
    .select("sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  // .select("id") — THE SILENT-WRITE LAW. A zero-row insert (RLS refusing a foreign-org quote id)
  // came back as `error: null` and this reported success, so the line simply was not there and
  // nothing said so. A write that wrote nothing is a refusal, out loud.
  const { data: added, error } = await supabase
    .from("quote_line_items")
    .insert({
      quote_id: quoteId,
      description: item.description.trim(),
      quantity: item.quantity || 1,
      unit: item.unit || "ea",
      unit_price: item.unit_price || 0,
      sort_order: (last?.sort_order ?? -1) + 1,
    })
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!added?.length) return { ok: false, error: "That line didn't save. Reload the estimate and try again." };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

export async function addQuoteItem(
  quoteId: string,
  item: { description: string; quantity: number; unit?: string; unit_price: number },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!item.description.trim()) return { ok: false, error: "Description is required." };
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;
  return appendQuoteLine(supabase, quoteId, item);
}

/**
 * APPEND LINES, ALL AT ONCE, WITH THEIR GROUP AND THEIR TASK (cn-v1132). The door for Generate, Upload
 * Plans, Supplier Quote and the kit picker on a SAVED estimate: one insert for the whole batch (one
 * sort_order run continued after the estimate's last line, one recalc), each line carrying its scope
 * group (category) and the task behind it (detail) — appendQuoteLine wrote neither, which is how a
 * kit's group went missing the moment its lines reached the saved screen.
 *
 * EACH LINE UNDER THE ID THE CLIENT CHOSE (B2): a Retry after a lost answer re-sends the same ids, and
 * Postgres's unique-key refusal on the table's primary key is read as THIS ESTIMATE'S ROWS ALREADY
 * THERE — if every id is this estimate's (an id is never reused across estimates, so a key taken by a
 * row that is NOT this estimate's is a foreign row: a refusal in words). The browser re-sends an append
 * under the SAME id with NEWER content after a lost answer (skeptic #37, B1: the edit he made meanwhile
 * rides the retry), so the rows are UPDATED from the batch — the words, the count, the unit, the price,
 * the group and the task; never sort_order, which the first landing chose — each scoped to this estimate
 * and read back, all of them or the refusal. Never an upsert: an upsert could move a foreign row.
 * Without the ids every Retry after a throw doubled the lines.
 *
 * THE JOB FOLLOWS (cn-v1133): lines appended to an ACCEPTED, job-linked estimate (a kit's tasks, a
 * generated batch) are new tasks and new parts for the job — the same pair updateQuoteItem runs: the
 * figure read before the insert (jobBehindQuote), the two rules after it (jobFollows), what they did
 * said beside the ids so the editor can say it.
 *
 * Refused in words: an empty list, a line with no words or no usable id, a locked estimate
 * (requireEditableQuote's own sentence), a last-line read that failed (the new lines would land at the
 * top), and an insert that came back short — fewer ids than lines is a write that did not all land
 * (RLS refusing a foreign estimate's id comes back as zero rows and no error), never a success. The ids
 * come back in the lines' order. org_id is the trigger's (0004 stamp_org_quote_line_items), as every
 * insert here.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lineIdTaken = (e: { code?: string | null; message?: string | null }): boolean => e.code === "23505" && /\bquote_line_items_pkey\b/.test(e.message ?? "");

export async function appendQuoteLines(
  quoteId: string,
  lines: (DraftLineItem & { id: string })[],
): Promise<{ ok: true; ids: string[]; /** What the job's list did. */ said?: string; /** What it could not do. */ note?: string } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  const supabase = ctx.supabase;
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: "There are no lines to add." };
  const blank = lines.findIndex((l) => !String(l?.description ?? "").trim());
  if (blank !== -1) return { ok: false, error: `Line ${blank + 1} has no description.` };
  const noId = lines.findIndex((l) => !UUID_SHAPE.test(String(l?.id ?? "")));
  if (noId !== -1) return { ok: false, error: `Line ${noId + 1} has no id to save under — reload the estimate and try again.` };
  const ids = lines.map((l) => l.id.toLowerCase());
  if (new Set(ids).size !== ids.length) return { ok: false, error: "Two of those lines carry the same id — reload the estimate and try again." };
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;
  const { data: last, error: lastErr } = await supabase
    .from("quote_line_items")
    .select("sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) return { ok: false, error: dbError(lastErr) };
  const start = Number((last as { sort_order?: number | null } | null)?.sort_order ?? -1) + 1;
  const rows = lines.map((l, idx) => ({
    id: ids[idx],
    quote_id: quoteId,
    description: l.description.trim(),
    quantity: Number(l.quantity) || 1,
    unit: (l.unit ?? "").trim() || "ea",
    unit_price: Number(l.unit_price) || 0,
    sort_order: start + idx,
    category: l.group?.trim() || null,
    // Coerced, so a part he added and never named is not stored (coerceTaskDetail drops it).
    detail: coerceTaskDetail(l.detail) ?? null,
  }));
  // THE JOB FOLLOWS THE FIGURE: on an accepted, job-linked estimate the job's figure is read BEFORE the
  // write, as updateQuoteItem reads it, so the sync can tell "still the estimate's" from his.
  const behind = await jobBehindQuote(supabase, quoteId, ctx.orgId);
  const { data: added, error } = await supabase.from("quote_line_items").insert(rows).select("id");
  if (error) {
    if (!lineIdTaken(error)) return { ok: false, error: dbError(error) };
    // The key is taken: this batch landed on an earlier try whose answer was lost — if the rows are
    // THIS estimate's. Read them back under it; anything short of all of them is a foreign row.
    const { data: already, error: readErr } = await supabase.from("quote_line_items").select("id").eq("quote_id", quoteId).in("id", ids);
    if (readErr) return { ok: false, error: dbError(readErr) };
    const here = new Set(((already ?? []) as { id: string }[]).map((r) => String(r.id).toLowerCase()));
    if (ids.some((id) => !here.has(id))) return { ok: false, error: "Those lines didn't save — one of their ids is already taken. Reload the estimate and try again." };
    // Every row is this estimate's: the batch carries his newest words, so each row takes them — not
    // sort_order (the first landing chose it). Scoped to the estimate and the id, read back; a zero-row
    // write is the same refusal as a foreign id, never a quiet "landed".
    for (const row of rows) {
      const { id, quote_id: _q, sort_order: _s, ...patch } = row;
      const { data: rewrote, error: rewriteErr } = await supabase.from("quote_line_items").update(patch).eq("quote_id", quoteId).eq("id", id).select("id");
      if (rewriteErr) return { ok: false, error: dbError(rewriteErr) };
      if (!rewrote?.length) return { ok: false, error: "Those lines didn't save — one of their ids is already taken. Reload the estimate and try again." };
    }
  } else {
    const got = new Set(((added ?? []) as { id: string }[]).map((r) => String(r.id).toLowerCase()));
    if (got.size < rows.length) {
      return {
        ok: false,
        error:
          got.size === 0
            ? "Those lines didn't save. Reload the estimate and try again."
            : `Only ${got.size} of ${rows.length} lines saved. Reload the estimate to see what landed.`,
      };
    }
  }
  await recalcQuote(supabase, quoteId);
  // The same two rules updateQuoteItem runs after its write (jobFollows): the job's tasks, then its buy
  // list, with the figure read before the insert. Their words ride back with the ids.
  const follow = behind ? await jobFollows(supabase, behind, ctx) : {};
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true, ids, ...follow };
}

/**
 * ADD A PRICE-LIST LINE BY ITS IDS, AND LET THE SERVER SAY WHAT IT COSTS.
 *
 * 0282 gave a code a list of makers — 830 "Windows (Materials) (Allowance)" can be filled by an
 * Andersen, a Milgard or a Marvin, and the three are hundreds of dollars apart. The moment a price
 * can be CHOSEN rather than looked up, a client that posts its own `unit_price` is a client that
 * can post any price: a stale dropdown, a tab left open while the book was re-imported, or simply
 * the wrong maker's number attached to the right maker's name.
 *
 * So this door takes ids and a quantity, and nothing else. It re-reads the item and its makers
 * under RLS, resolves the pick through the SAME pure rule the screen used to render the dropdown
 * (lib/pricing/item-options → effectiveMarkupPct → sellPrice), and writes the line it computed
 * itself. The customer's pricing level and the org default come from the database on this request,
 * not from whatever the page was holding.
 *
 * `optionId` has three states, and they are three different answers:
 *   absent      → nobody chose, so the maker the org FLAGGED wins (0282: "what a kit or an import
 *                 resolves to"). This is a suggestion, and the description says whose window it is.
 *   "" or null  → somebody chose the item's own allowance price. Honoured as typed.
 *   an id       → that maker. Gone from the code since the page rendered? REFUSED, by name. Never
 *                 quietly re-priced at the allowance, which is the one outcome that puts a wrong
 *                 number on a customer's paper without anybody seeing it happen.
 */
export async function addQuoteItemFromPriceItem(
  quoteId: string,
  pick: { priceItemId: string; optionId?: string | null; quantity?: number },
): Promise<{ ok: boolean; error?: string; description?: string; unit_price?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!pick?.priceItemId) return { ok: false, error: "Pick an item from your price list first." };
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;

  const [{ data: itemRow, error: itemErr }, { data: quoteRow, error: quoteErr }, { data: orgRow }] = await Promise.all([
    supabase
      .from("price_list_items")
      .select(`id, code, description, unit, buy_price, markup_pct, ${ITEM_OPTIONS_EMBED}`)
      .eq("id", pick.priceItemId)
      .eq("archived", false)
      .eq("price_list_item_options.archived", false)
      .maybeSingle(),
    // THE CUSTOMER'S LEVEL, read here rather than trusted from the page — a level always wins over
    // an item's or a maker's markup, so it decides the money on this line.
    supabase.from("quotes").select("customers(pricing_levels(markup_pct))").eq("id", quoteId).maybeSingle(),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  // A FAILED READ IS NOT AN ITEM WITHOUT MAKERS. Carrying on here would price the Marvin somebody
  // picked at the $830 allowance and call it a success.
  if (itemErr) return { ok: false, error: dbError(itemErr) };
  if (quoteErr) return { ok: false, error: dbError(quoteErr) };
  if (!itemRow) return { ok: false, error: "That item is no longer in your price list. Pick another one." };

  const item = itemRow as unknown as OptionedPriceItem;
  const optionId = pick.optionId === undefined ? defaultItemOptionId(item) : pick.optionId;
  const choice = chooseItemOption(item, optionId, {
    // `?? null` and never `?? 0`: effectiveMarkupPct returns on ANY finite level, so a 0 here
    // would price every customer-without-a-level at net cost.
    levelPct: (quoteRow as any)?.customers?.pricing_levels?.markup_pct ?? null,
    orgDefaultPct: getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).default_markup_pct,
  });
  if (!choice) return { ok: false, error: missingOptionMessage(item) };

  const qty = Number(pick.quantity);
  const res = await appendQuoteLine(supabase, quoteId, {
    description: choice.description,
    quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
    unit: choice.unit,
    unit_price: choice.unitPrice,
  });
  // Hand back what actually landed, so the screen can show the line it got rather than the line it
  // assumed — the maker is in the description and the price came from here, not from the browser.
  return res.ok ? { ...res, description: choice.description, unit_price: choice.unitPrice } : res;
}

export async function updateQuoteItem(
  itemId: string,
  quoteId: string,
  item: {
    description?: string;
    quantity?: number;
    unit?: string;
    unit_price?: number;
    /** The task behind the line (cn-v1132): a breakdown to store (coerced on the way in), null to make
     *  it a plain line again, undefined to leave it alone. */
    detail?: TaskDetail | null;
    /** The scope group (0104): a word, null for none, undefined to leave it alone. */
    category?: string | null;
  },
): Promise<{ ok: boolean; error?: string; /** What the job's list did. */ said?: string; /** What it could not do. */ note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // PATCH semantics (mirrors updateBill): write ONLY the keys the caller sent — an
  // omitted field never touches its column (it used to reset unit to "ea", qty to 1…).
  const clean: Record<string, unknown> = {};
  if (item.description !== undefined) {
    if (!item.description.trim()) return { ok: false, error: "Description is required." };
    clean.description = item.description.trim();
  }
  if (item.quantity !== undefined) clean.quantity = item.quantity || 1;
  if (item.unit !== undefined) clean.unit = item.unit.trim() || "ea";
  if (item.unit_price !== undefined) clean.unit_price = item.unit_price || 0;
  if (item.detail !== undefined) {
    if (item.detail === null) clean.detail = null;
    else {
      // A breakdown that does not read as one is refused, never stored as null: clearing it would
      // silently cut the line from the job's task (task_id) and drop the hours behind its price.
      const d = coerceTaskDetail(item.detail);
      if (!d) return { ok: false, error: "That line's breakdown couldn't be read — nothing was changed." };
      clean.detail = d;
    }
  }
  if (item.category !== undefined) clean.category = item.category === null ? null : item.category.trim() || null;
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;
  // WHAT THE LINE SAID BEFORE: the words, so the job's task is renamed only while it still reads exactly
  // that way (item 1, 2026-10-10 — a task he renamed by hand on the job stands), and the figure, so the
  // job's two rules run only when the figure actually MOVES (cn-v1133).
  const { data: was } = await supabase.from("quote_line_items").select("description, quantity, unit_price, detail").eq("id", itemId).eq("quote_id", quoteId).maybeSingle();
  const before = (was as { description?: string | null; quantity?: unknown; unit_price?: unknown; detail?: unknown } | null) ?? null;
  // THE JOB FOLLOWS THE FIGURE (S5): hours or parts behind an accepted, job-linked estimate's line
  // (its breakdown), or its count or price, change what the job's tasks and buy list should be. The
  // estimate's figure is read BEFORE the write, as the delete door reads it, so the sync can tell
  // "still the estimate's" from his; the rules themselves run after the write lands.
  // ONLY WHEN IT DIFFERS (cn-v1133): the editor sends the count, the price and the breakdown on every
  // write, so a description-only edit used to run both syncs and say "N kept their hours" each time.
  // Each figure is compared to the stored row (the count and price as numbers, the breakdown as the
  // coerced shape, deep); a row that could not be read falls back to "sent = moves", the old rule.
  const figureMoves = before ? figureDiffers(before, clean) : clean.detail !== undefined || clean.quantity !== undefined || clean.unit_price !== undefined;
  const behind = figureMoves ? await jobBehindQuote(supabase, quoteId, ctx.orgId) : null;
  // SCOPE THE WRITE TO THE DOCUMENT WE AUTHORIZED (audit v800). The editable check ran against
  // quoteId, but the update matched on itemId ALONE — so a caller (Nort included) could pass a
  // draft's id to pass the lock and an itemId belonging to a DIFFERENT quote, and rewrite a line
  // on an accepted, already-billed document. Zero rows is now an error, not a quiet success.
  const { data: touched, error } = await supabase
    .from("quote_line_items")
    .update(clean)
    .eq("id", itemId)
    .eq("quote_id", quoteId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!touched?.length) return { ok: false, error: "That line isn't on this estimate." };
  await recalcQuote(supabase, quoteId);
  let follow: { said?: string; note?: string } = {};
  if (before && clean.description !== undefined && coerceTaskDetail(before.detail)) {
    const jobId = await jobOf(supabase, quoteId);
    if (jobId) {
      const r = await retitleLineTask(supabase, { jobId, orgId: ctx.orgId, lineId: itemId, from: String(before.description ?? ""), to: String(clean.description) });
      if (r.error) {
        reportError("updateQuoteItem:retitle", new Error(r.error), { jobId, itemId });
        follow = { note: `The job's task could not be renamed (${r.error}).` };
      } else if (r.renamed) {
        follow = { said: "The job's task is renamed too." };
        revalidatePath(`/jobs/${jobId}`);
      } else {
        // No task reads as the line put it: he may have DELETED it. Its dismissal remembers the old title
        // and must follow the rename, or a rebuild brings the task back (audit v1085, carried [18]).
        const d = await retitleDismissal(supabase, { jobId, lineId: itemId, from: String(before.description ?? ""), to: String(clean.description) });
        if (d.error) reportError("updateQuoteItem:retitleDismissal", new Error(d.error), { jobId, itemId });
      }
    }
  }
  if (behind) {
    // The same two rules the delete door runs (jobFollows): the job's tasks, then its buy list, with
    // the figure read before the write. Said beside the rename's words when both happened.
    const moved = await jobFollows(supabase, behind, ctx);
    follow = {
      ...([follow.said, moved.said].some(Boolean) ? { said: [follow.said, moved.said].filter(Boolean).join(" ") } : {}),
      ...([follow.note, moved.note].some(Boolean) ? { note: [follow.note, moved.note].filter(Boolean).join(" ") } : {}),
    };
  }
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true, ...follow };
}

export async function deleteQuoteItem(
  itemId: string,
  quoteId: string,
): Promise<{ ok: boolean; error?: string; /** What the job's list did. */ said?: string; /** What it could not do. */ note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;
  // THE JOB FOLLOWS (item 1, 2026-10-10): when a TASK line goes (a plain line has no task on the job),
  // the estimate's figure is read BEFORE the delete, so the size can tell "still the estimate's" from
  // his; the sync itself runs after the delete lands.
  const { data: line } = await supabase.from("quote_line_items").select("detail").eq("id", itemId).eq("quote_id", quoteId).maybeSingle();
  const behind = coerceTaskDetail((line as { detail?: unknown } | null)?.detail) ? await jobBehindQuote(supabase, quoteId, ctx.orgId) : null;
  // Same scoping law as updateQuoteItem (audit v800): the delete must belong to the document
  // the editable check authorized, and a zero-row delete is a failure, not a success.
  const { data: gone, error } = await supabase
    .from("quote_line_items")
    .delete()
    .eq("id", itemId)
    .eq("quote_id", quoteId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: "That line isn't on this estimate." };
  await recalcQuote(supabase, quoteId);
  const follow = behind ? await jobFollows(supabase, behind, ctx) : {};
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true, ...follow };
}

/** Edit quote header fields: title, notes, tax rate (fraction), valid-until.
 *  PATCH semantics (mirrors updateBill): only the keys the caller sent are written —
 *  an omitted field never touches its column. An explicit "" / null clears. */
export async function updateQuoteMeta(
  quoteId: string,
  meta: {
    title?: string;
    description?: string;
    notes?: string;
    tax_rate?: number;
    valid_until?: string | null;
    /** The estimate's own paper format (0395): "tasks" | "detailed", or null for the company's. */
    estimate_format?: "tasks" | "detailed" | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (meta.title !== undefined) clean.title = meta.title.trim() || null;
  if (meta.description !== undefined) clean.description = meta.description.trim() || null;
  if (meta.notes !== undefined) clean.notes = meta.notes.trim() || null;
  if (meta.tax_rate !== undefined) clean.tax_rate = meta.tax_rate || 0;
  if (meta.valid_until !== undefined) clean.valid_until = meta.valid_until;
  // Validated to the column's own check: anything but the two words is "the company's" (null).
  if (meta.estimate_format !== undefined) clean.estimate_format = meta.estimate_format === "tasks" || meta.estimate_format === "detailed" ? meta.estimate_format : null;
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };
  // Only the tax rate moves `total` (through recalcQuote) — so only a tax-rate change on a
  // drawn contract trips the accepted-lock. Re-titling or re-noting an accepted quote is
  // harmless and stays allowed.
  if (meta.tax_rate !== undefined) {
    const editable = await requireEditableQuote(supabase, quoteId);
    if (!editable.ok) return editable;
  }
  // Read back (silent-write law): a zero-row update is a 204 that would say "saved" over nothing.
  const { data: landed, error } = await supabase
    .from("quotes")
    .update(clean)
    .eq("id", quoteId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!landed?.length) return { ok: false, error: "That estimate isn't here to update." };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

/**
 * Change a saved quote's customer. Mirrors the visibleJobIdOrNull guard:
 * a customerId the caller's RLS-scoped client can't see resolves to null,
 * so a crafted/foreign id can never persist as a cross-org dangling FK.
 */
export async function setQuoteCustomer(
  quoteId: string,
  customerId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  let safeCustomerId: string | null = null;
  if (customerId) {
    safeCustomerId = await visibleCustomerIdOrNull(supabase, customerId);
    if (!safeCustomerId) return { ok: false, error: "That customer isn't available." };
  }

  const { error } = await supabase
    .from("quotes")
    .update({ customer_id: safeCustomerId, updated_at: new Date().toISOString() })
    .eq("id", quoteId);
  if (error) return { ok: false, error: dbError(error) };
  await bustDocPdf("quote", quoteId); // bill-to renders on the PDF (audit 7)
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

/**
 * Pin a saved quote to a job (or null to unpin) — "leave the estimate with the job".
 * Same RLS-visibility guard as setQuoteCustomer: a job id the caller can't see is
 * rejected, so a crafted/foreign id can never persist as a cross-org dangling FK.
 */
export async function setQuoteJob(
  quoteId: string,
  jobId: string | null,
): Promise<{ ok: boolean; error?: string; /** What the job's list did. */ said?: string; /** What it could not do. */ note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  if (jobId) {
    const { data } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
    if (!data) return { ok: false, error: "That job isn't available." };
  }

  // THE JOB FOLLOWS (item 1, 2026-10-10): an ACCEPTED estimate pinned to a job puts its task lines on
  // that job's list. The job's figure is read BEFORE the pin counts this estimate's lines, so a job
  // that already has its own length keeps it.
  const { data: qs } = await supabase.from("quotes").select("status, job_id").eq("id", quoteId).maybeSingle();
  const accepted = (qs as { status?: string } | null)?.status === "accepted";
  let pinned: FigureBefore | null = null;
  if (jobId && accepted) {
    const est = await estimateLines(supabase, { jobId, orgId: ctx.orgId });
    pinned = figureBefore(est);
  }
  // THE JOB IT LEAVES (cn-v1084): its line tasks and parts came from this estimate, and after the pin
  // they are on no accepted estimate of that job — so it follows too (open, bare ones go; what is his
  // stays, said), its figure read before the pin like the other's. Its sentence names the job.
  const from = (qs as { job_id?: string | null } | null)?.job_id ?? null;
  let left: ({ jobId: string; label: string } & FigureBefore) | null = null;
  if (accepted && from && from !== jobId) {
    const [est, { data: fromJob }] = await Promise.all([
      estimateLines(supabase, { jobId: from, orgId: ctx.orgId }),
      supabase.from("jobs").select("name, job_number").eq("id", from).maybeSingle(),
    ]);
    const j = (fromJob ?? {}) as { name?: string | null; job_number?: string | null };
    left = { jobId: from, ...figureBefore(est), label: j.name || j.job_number ? jobLabel(j) : "" };
  }

  // .select("id") — the silent-write law: a zero-row update (not ours, or gone) is said, not a quiet ok.
  const { data: moved, error } = await supabase
    .from("quotes")
    .update({ job_id: jobId, updated_at: new Date().toISOString() })
    .eq("id", quoteId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!moved?.length) return { ok: false, error: "That estimate could not be found." };
  // Pinning an estimate to a job is the same win as making the job from it: the visit it was written
  // up from gets the job (where it has none) and reads won (cn-v1069, lib/appointments/behind-quote).
  if (jobId) {
    const { data: ql } = await supabase.from("quotes").select("inquiry_id").eq("id", quoteId).maybeSingle();
    await closeVisitsBehindQuote(
      supabase,
      { id: quoteId, inquiry_id: (ql as { inquiry_id?: string | null } | null)?.inquiry_id ?? null, job_id: jobId },
      { jobId, outcome: "won", orgId: ctx.orgId },
    );
  }
  // The job is where the printed "Job site" address comes from (pickSite on the print page), so
  // re-pointing it must drop the stored PDF or a sent estimate keeps serving the old address
  // while /q shows the new one (audit v921, same reason as setQuoteCustomer above).
  await bustDocPdf("quote", quoteId);
  // ITS PAPERWORK MOVES WITH IT (cn-v1084): the work order and the materials list this estimate made
  // (one each per estimate, 0388) are the estimate's, so they point at the job it is pinned to now — a
  // list left on the old job was the crew's buy list for work that is no longer that job's. Zero rows
  // is "none made yet", not a failure; a refusal is said.
  const notes: string[] = [];
  for (const [table, what] of [["work_orders", "work order"], ["material_lists", "materials list"]] as const) {
    const { error: moveErr } = await supabase.from(table).update({ job_id: jobId }).eq("quote_id", quoteId).select("id");
    if (moveErr) {
      reportError("setQuoteJob:movePaperwork", moveErr, { quoteId, table });
      notes.push(`The estimate's ${what} could not be moved to this job (${dbError(moveErr)}).`);
    }
  }
  const follow = jobId && pinned ? await jobFollows(supabase, { jobId, ...pinned }, ctx) : {};
  const leftBehind = left
    ? await jobFollows(supabase, { jobId: left.jobId, sizeBefore: left.sizeBefore, tasksBefore: left.tasksBefore, partsBefore: left.partsBefore }, ctx, {
        tasks: left.label ? `The job it left (${left.label}) follows too` : "The job it left follows too",
        materials: left.label ? `${left.label}'s materials list too` : "Its materials list too",
      })
    : {};
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  if (left) revalidatePath(`/jobs/${left.jobId}`);
  const said = [follow.said, leftBehind.said].filter(Boolean).join(" ");
  const note = [follow.note, leftBehind.note, ...notes].filter(Boolean).join(" ");
  return { ok: true, ...(said ? { said } : {}), ...(note ? { note } : {}) };
}

/**
 * Agent dedupe guard: a recent DRAFT with the same title for the same (or an
 * unattached) customer is the same document being saved twice — one Nort
 * conversation minted E-009/E-010/E-011 for one estimate this way. Returns the
 * existing draft so quote.create can refuse and steer to editing it instead.
 */
export async function findRecentDraftQuote(
  customerId: string | null,
  title: string,
): Promise<{ id: string; quote_number: string | null; title: string | null } | null> {
  const ctx = await requireStaff();
  if ("error" in ctx) return null;
  const norm = title.trim().toLowerCase();
  if (!norm) return null;
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data } = await ctx.supabase
    .from("quotes")
    .select("id, quote_number, title, customer_id")
    .eq("status", "draft")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(25);
  const hit = (data ?? []).find(
    (q) =>
      (q.title ?? "").trim().toLowerCase() === norm &&
      (customerId == null || q.customer_id == null || q.customer_id === customerId),
  );
  return hit ? { id: hit.id, quote_number: hit.quote_number, title: hit.title } : null;
}

export async function deleteQuote(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // THE STAMP FOLLOWS THE DEED, IN REVERSE (review of cn-v796): autosave stamps a lead
  // 'quoted' the moment a draft exists — so deleting that draft must un-stamp it when no
  // other quote remains, or the lead leaves the inbox pointing at nothing (the exact
  // Andrew-orphan class the stamp was moved to prevent).
  const { data: victim } = await supabase.from("quotes").select("id, inquiry_id").eq("id", id).maybeSingle();
  const { error } = await supabase.from("quotes").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  if (victim?.inquiry_id) await releaseLeadIfOrphaned(supabase, victim.inquiry_id);
  revalidatePath("/quotes");
  return { ok: true };
}

/**
 * PUT A LEAD BACK IN THE INBOX when nothing points at it any more.
 *
 * Autosave stamps a lead 'quoted' the moment a draft for it exists, so anything that takes the
 * last deed away again has to take the stamp with it — or the lead leaves the inbox pointing at
 * nothing (the Andrew-orphan class). Two callers: deleting the quote, and RE-POINTING it, now
 * that the builder's picker can move an estimate from one lead to another person entirely.
 *
 * BOTH deeds, not just quotes (v800 wave B caught my own v801 regression): widening the un-stamp
 * to every converted_to value meant deleting a lead's QUOTE reopened it even when the JOB born
 * from that lead was alive and well — stamp-follows-deed, inverted. So a live job holds the
 * stamp on its own.
 */
async function releaseLeadIfOrphaned(supabase: any, inquiryId: string): Promise<void> {
  const [qRes, jRes] = await Promise.all([
    supabase.from("quotes").select("id", { count: "exact", head: true }).eq("inquiry_id", inquiryId),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("inquiry_id", inquiryId),
  ]);
  // FAIL CLOSED ON A FAILED READ. A PostgREST count that errors comes back as `count: null` with
  // the error alongside it — and the old `if (count || jobsLeft) return` read that null as "zero
  // deeds left" and released the lead anyway. So one transient failure reopened a lead whose quote
  // and job are both alive, and the inbox grew a duplicate of live work. Not releasing a lead that
  // should have been released is a stamp somebody fixes in a tap; releasing one that shouldn't be
  // is a lead the office chases twice. This matters more now that re-pointing an estimate reaches
  // here from the builder, where a person can trigger it repeatedly.
  if (qRes.error || jRes.error) return;
  if (qRes.count || jRes.count) return;
  await supabase
    .from("inquiries")
    // "new", not "open": INQUIRY_STATUSES is new/contacted/quoted/won/lost, and a lead released
    // back to the inbox is a fresh one again. "open" is not in that vocabulary and rendered as an
    // unknown chip (v800 verification).
    .update({ converted_to: null, converted_at: null, status: "new", updated_at: new Date().toISOString() })
    .eq("id", inquiryId)
    // NOT .eq("converted_to","quote"): convertInquiry writes 'estimate' or 'job', so that filter
    // silently skipped the very rows this un-stamp exists for (audit v800).
    .not("converted_at", "is", null);
  revalidatePath("/leads");
}

/**
 * Duplicate-draft cleanup: keep one draft, delete the losers in one tap.
 * Erik: "made many copies then not being able to correct them, merge them or
 * delete them." A draft carries no children (no job/invoice/WO re-point needed),
 * so "merge" here IS keep-one-delete-the-rest. Guards hard before deleting:
 * every id (keep + losers) must resolve — under RLS scoping — to a DRAFT of the
 * SAME customer, so a stray non-draft or foreign-org row can never be swept up.
 */
export async function resolveDuplicateDrafts(
  keepId: string,
  deleteIds: string[],
): Promise<{ ok: boolean; error?: string; deleted?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const losers = deleteIds.filter((id) => id && id !== keepId);
  if (losers.length === 0) return { ok: false, error: "Nothing to delete." };

  // Fetch the whole cluster (keep + losers) under RLS — foreign rows drop out.
  const ids = [keepId, ...losers];
  const { data: rows, error: readErr } = await supabase
    .from("quotes")
    .select("id, status, customer_id")
    .in("id", ids);
  if (readErr) return { ok: false, error: readErr.message };

  const found = rows ?? [];
  // Every id must have resolved (RLS didn't hide any) — else refuse the batch.
  if (found.length !== ids.length)
    return { ok: false, error: "One of these drafts isn't available." };
  // All must be drafts — never delete a sent/accepted quote through this path.
  if (found.some((r) => r.status !== "draft"))
    return { ok: false, error: "Only draft estimates can be cleaned up here." };
  // All must share the keep's customer — the dedupe signal we grouped on.
  const keepRow = found.find((r) => r.id === keepId);
  if (!keepRow) return { ok: false, error: "That draft isn't available." };
  if (found.some((r) => (r.customer_id ?? null) !== (keepRow.customer_id ?? null)))
    return { ok: false, error: "These drafts belong to different customers." };

  const { error } = await supabase.from("quotes").delete().in("id", losers);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/quotes");
  return { ok: true, deleted: losers.length };
}

/** The insert's id is already a row's: Postgres's unique-key refusal on the PRIMARY key, passed through by
 *  PostgREST with its own code and words. Any other 23505 (the number, quotes_org_number_key) stays dbError's. */
const idTaken = (e: { code?: string | null; message?: string | null }): boolean =>
  e.code === "23505" && /\bquotes_pkey\b/.test(e.message ?? "");

export async function saveQuote(input: SaveQuoteInput) {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const supabase = ctx.supabase;

  // THE HEADER IS A PROVISIONAL FIGURE HERE. These products are raw JS floats summed and then
  // rounded once; the DB stores each line as round(quantity * unit_price, 2) and rounds half
  // AWAY from zero. Two lines of 2.25 hr x $95.50 give lines of $214.88 each ($429.76) under a
  // header of $429.75 — a customer-facing document whose lines do not add up, tax on the wrong
  // base, and a later edit silently moving the total of an already-sent quote (audit v921 high).
  // So this value only carries the insert; recalcQuote below re-derives the header from the
  // stored line_total column and that is what we persist and return.
  const { subtotal, tax, total } = subtotalTaxTotal(
    input.items.map((i) => i.quantity * i.unit_price),
    input.tax_rate || 0,
  );

  // Defense-in-depth: only stamp inquiry_id if it resolves to a lead THIS caller can see (the
  // select is RLS-bound, so a foreign-org id resolves to null). The FK check itself bypasses RLS,
  // so without this a hand-crafted server-action POST could plant a cross-org pointer. Cheap —
  // only runs on the rare lead-seeded quote (input.inquiry_id is otherwise null).
  let inquiryId = input.inquiry_id || null;
  if (inquiryId) {
    const { data: inq } = await supabase.from("inquiries").select("id").eq("id", inquiryId).maybeSingle();
    if (!inq) inquiryId = null;
  }

  // WHO AN ESTIMATE IS FOR CAN NOW MOVE. The builder's picker offers leads and customers side by
  // side, so a draft can be re-pointed from one lead to another — or to a customer with no lead
  // at all. Read the pointer BEFORE the write; if it changes, the lead it left has to be released
  // afterwards or it sits stamped 'quoted' with nothing pointing at it. On an insert there is no
  // previous pointer, so this costs one small read only on the autosave/update path.
  //
  // ONE ESTIMATE PER ID (cn-v1132). The editor names its estimate before the first save, so a lost
  // answer and a retry under the same id land on ONE row: an id standing here in this company is an
  // update, an id nobody has is the insert, WITH that id. The one read serves both: the status (the
  // draft lock is decided on it before the RPC is asked) and the lead pointer the estimate may be leaving.
  type Standing = { id: string; status: string | null; inquiry_id: string | null };
  const standingOf = async (id: string): Promise<Standing | null | { error: string }> => {
    const { data, error } = await supabase.from("quotes").select("id, status, inquiry_id").eq("id", id).maybeSingle();
    if (error) return { error: dbError(error) };
    return (data as Standing | null) ?? null;
  };
  let standing: Standing | null = null;
  if (input.id) {
    const s = await standingOf(input.id);
    if (s && "error" in s) return { ok: false as const, error: s.error };
    standing = s;
  }
  let prevInquiryId: string | null = standing?.inquiry_id ?? null;

  const fields = {
    customer_id: input.customer_id,
    job_id: input.job_id || null,
    inquiry_id: inquiryId,
    title: input.title || null,
    description: input.description || null,
    notes: input.notes || null,
    tax_rate: input.tax_rate || 0,
    subtotal,
    tax,
    total,
    valid_until: input.valid_until,
    // The builder's Estimate|Quote toggle; absent (Nort, duplicates of old rows) = Estimate (T&M).
    doc_type: input.doc_type === "quote" ? "quote" : "estimate",
  };
  // THE ESTIMATE'S OWN PAPER FORMAT (0395): its word, null for the company's, undefined = untouched.
  // Kept out of `fields` — save_quote_draft (0211) takes the header as it always has and is not edited.
  const estimateFormat: "tasks" | "detailed" | null | undefined =
    input.estimate_format === "tasks" || input.estimate_format === "detailed" ? input.estimate_format : input.estimate_format === null ? null : undefined;
  let quote: { id: string; quote_number?: string | null } | null = null;
  let updateItemsDone = false;
  // TWO PASSES AT MOST. A save whose id is standing here takes the update path; one with no id, or an
  // id nobody has, takes the insert. The one case that needs a second pass: the insert finds its id
  // TAKEN (the key) — a twin of this save still in flight, whose answer was lost on the wire, landed
  // first. Then the row is this company's and the second pass updates it; a row this company cannot
  // see is "Quote not found.", never a second estimate under a new number.
  for (let pass = 0; pass < 2 && !quote; pass++) {
    if (standing) {
      // THE DRAFT LOCK, DECIDED ON WHAT WAS READ: the RPC holds the same lock under its row lock, so
      // this is its refusal one round trip earlier, not a second rule.
      if (standing.status !== "draft") {
        return { ok: false as const, code: "not_editable" as const, error: "That draft was sent — it can't be edited from the builder anymore." };
      }
      // AUTOSAVE UPDATE — one TRANSACTION via save_quote_draft (0211): row-locked,
      // draft-locked, header + wholesale line replace atomically. The old three-REST-call
      // shape let two writers interleave into doubled lines under a single-set total, and a
      // failed insert left a zero-line draft (review of cn-v796, 3 confirmed HIGHs).
      const { data: rpc, error: rpcErr } = await supabase.rpc("save_quote_draft", {
        p_id: standing.id,
        p_fields: { ...fields, subtotal, tax, total },
        p_items: input.items.map((it, idx) => ({
          description: it.description,
          quantity: it.quantity,
          unit: it.unit || "ea",
          unit_price: it.unit_price,
          category: it.group ?? null,
          sort_order: idx,
          // The task behind the line (0386) rides every save, or the first autosave would drop it —
          // coerced, so a part he added and never named is not stored (coerceTaskDetail drops it).
          detail: coerceTaskDetail(it.detail),
        })),
      });
      if (rpcErr) {
        const msg = rpcErr.message ?? "";
        if (msg.includes("QUOTE_NOT_DRAFT")) {
          // Sent between the read and the lock: the builder must stop and say so — never rewrite a live document.
          return { ok: false as const, code: "not_editable" as const, error: "That draft was sent — it can't be edited from the builder anymore." };
        }
        if (msg.includes("EMPTY_REPLACE")) {
          return {
            ok: false as const,
            code: "empty_replace" as const,
            error: "Refused: this would wipe the draft's line items. Reload the estimate to pick up its saved lines, or delete the draft if you meant to start over.",
          };
        }
        if (msg.includes("QUOTE_GONE")) {
          // Deleted between the read and the lock: fall through to the insert below, under the same id —
          // a stale restored quoteId must not brick the session (review: "permanent no-save black hole").
          standing = null;
        } else {
          return { ok: false as const, error: dbError(rpcErr) };
        }
      } else {
        const row = Array.isArray(rpc) ? rpc[0] : rpc;
        quote = row as { id: string; quote_number?: string | null };
        updateItemsDone = true;
        if (estimateFormat !== undefined) {
          // ONE more statement after the RPC, read back (silent-write law), and only on a DRAFT, the
          // same lock the RPC holds: the draft is still ours (the RPC just locked and wrote it), so zero
          // rows means it went, or was sent, between the two. The builder sends the format only when it
          // changed, so this is not a write per autosave.
          const { data: fmt, error: fmtErr } = await supabase.from("quotes").update({ estimate_format: estimateFormat }).eq("id", quote.id).eq("status", "draft").select("id");
          if (fmtErr) return { ok: false as const, error: dbError(fmtErr) };
          if (!fmt?.length) return { ok: false as const, error: "The paper format didn't land — reload the estimate and try again." };
        }
      }
    }
    if (!quote) {
      const { data: ins, error } = await supabase
        .from("quotes")
        // The client's own id when it named one (cn-v1132), so a retry lands on this row and not beside it.
        // Status is never set here: the column's default, 'draft'.
        .insert({ ...fields, ...(input.id ? { id: input.id } : {}), ...(estimateFormat !== undefined ? { estimate_format: estimateFormat } : {}), created_by: ctx.userId })
        // quote_number is stamped by the BEFORE-INSERT trigger (0004 next_doc_number),
        // so insert-returning carries the real document number.
        .select("id, quote_number")
        .single();
      if (error) {
        if (input.id && idTaken(error)) {
          const twin = await standingOf(input.id);
          if (twin && "error" in twin) return { ok: false as const, error: twin.error };
          if (!twin) return { ok: false as const, error: "Quote not found." };
          standing = twin;
          prevInquiryId = twin.inquiry_id;
          continue;
        }
        return { ok: false as const, error: dbError(error) };
      }
      quote = ins as { id: string; quote_number?: string | null };
    }
  }
  if (!quote) return { ok: false as const, error: "The save didn't land." };

  if (input.items.length && !updateItemsDone) {
    const rows = input.items.map((it, idx) => ({
      quote_id: quote.id,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit || "ea",
      unit_price: it.unit_price,
      // The scope group (Framing, Decking, Electrical…) — persists the grouped-view groups
      // so they survive a save/reload, and forms the estimate's per-category budget buckets.
      category: it.group ?? null,
      sort_order: idx,
      detail: coerceTaskDetail(it.detail),
    }));
    const { error: itemsErr } = await supabase
      .from("quote_line_items")
      .insert(rows);
    if (itemsErr) return { ok: false as const, error: itemsErr.message };
  }

  // No auto follow-up task here: the "awaiting reply" inbox item on My Day IS
  // the follow-up, and it self-clears when the quote is answered — one intent,
  // one surface (the old per-quote task factory just piled up orphans).

  // Write-up backlink: stamp the new quote's id onto the source inspection's capture jsonb
  // so /inspections can file the row (the lead-less Inspect-now path has no inquiry/job link).
  // RLS-scoped read → a bad/cross-org id is a clean no-op; best-effort, never fails the save.
  if (input.capture_appointment_id) {
    const { data: appt } = await supabase
      .from("appointments")
      .select("id, capture")
      .eq("id", input.capture_appointment_id)
      .maybeSingle();
    if (appt) {
      const existing =
        appt.capture && typeof appt.capture === "object" ? (appt.capture as Record<string, unknown>) : {};
      // Stamp ONCE: autosave calls this every ~2s — a read-modify-write of the capture jsonb
      // on every tick would clobber concurrent inspector writes (review) and churn revalidates.
      if (existing.quote_id !== quote.id) {
        await supabase
          .from("appointments")
          .update({ capture: { ...existing, quote_id: quote.id }, updated_at: new Date().toISOString() })
          .eq("id", appt.id);
        revalidatePath("/inspections");
      }
    }
  }

  // THE DEED STAMPS THE RECORD (Andrew's orphaned lead). Converting a lead to a BLANK builder
  // used to stamp it 'quoted' at click time — abandon the builder and the lead left the inbox
  // with no quote existing, taking its intake attachments with it. The lead now converts at the
  // moment an estimate for it actually lands, whichever door built it (seeded conversion, blank
  // builder, inspection write-up). `.is(converted_at, null)` keeps it first-deed-only: the
  // zero-row update on an already-converted lead is the intended no-op, not a silent failure.
  if (inquiryId) {
    await supabase
      .from("inquiries")
      .update({
        converted_to: "quote",
        converted_at: new Date().toISOString(),
        status: "quoted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", inquiryId)
      .is("converted_at", null);
    // The customer link attaches separately, attach-once — the first-deed-only stamp used to
    // carry it, so a customer picked AFTER the first autosave never reached the lead (review).
    if (input.customer_id) {
      await supabase
        .from("inquiries")
        .update({ customer_id: input.customer_id, updated_at: new Date().toISOString() })
        .eq("id", inquiryId)
        .is("customer_id", null);
    }
    revalidatePath("/leads");
  }

  // The lead this estimate LEFT, released once the new pointer is on the row (so the count below
  // sees the world as it now is). Guarded by "no quotes and no jobs left on it" exactly like the
  // delete path — a lead with other live work keeps its stamp.
  if (prevInquiryId && prevInquiryId !== inquiryId) await releaseLeadIfOrphaned(supabase, prevInquiryId);

  // Re-derive the header from what the DB actually stored, so the lines on the document always
  // add up to its Subtotal (audit v921 high). Idempotent, and the same function every editor
  // path already funnels through. If the read fails it returns null and we keep the provisional
  // figures — a transient error must never zero a real estimate (the v800 rule).
  const stored = await recalcQuote(supabase, quote.id);

  revalidatePath("/quotes");
  // Return the SAVED money figures (the recalc rollup that was written) +
  // the trigger-assigned number, so every caller — Nort's quote.create especially —
  // reads the real total back instead of re-deriving it. The announce-vs-save drift:
  // Nort told Erik "~$2,560" then saved E-014 at $2,620, because the announced figure
  // was mental math over the lines while THIS function computed the persisted total.
  return {
    ok: true as const,
    id: quote.id,
    quote_number: (quote as { quote_number?: string }).quote_number ?? null,
    subtotal: stored?.subtotal ?? subtotal,
    tax: stored?.tax ?? tax,
    total: stored?.total ?? total,
  };
}

/**
 * Clone a quote (header fields + all line items) into a fresh draft titled
 * "… (copy)". Reuses the existing saveQuote insert path so totals and
 * revalidation all behave exactly like a new estimate.
 * RLS-scoped reads mean a foreign-org quote resolves to nothing here.
 */
export async function duplicateQuote(
  id: string,
  /** `revision` (0391): the copy REVISES this estimate — it keeps the job, the customer and the lead,
   *  the title stays (the number tells them apart), and it remembers what it revises, so accepting it
   *  supersedes the original. A plain duplicate stands on its own, as before. */
  opts?: { revision?: boolean },
): Promise<{ ok: boolean; error?: string; id?: string; warning?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const revision = !!opts?.revision;

  // circuits rides along (Panel plan, phase 0): the copy used to drop the circuit schedule without
  // saying so, so a copied estimate printed no second page and had nothing for a job's Panel tab
  // to bring in.
  // estimate_format rides too (cn-v1131): a Revise or a copy of an estimate set to Show used to come
  // back on the company default. TWO RUNGS, as the builder's page reads it: a deploy precedes its
  // migration (0395), and a select naming a column that is not there yet fails the WHOLE read — which
  // here read as "Quote not found." Without the column the copy is made as before, with no format of
  // its own.
  // (A const column list: each select is then a string LITERAL the client's select parser can read
  // into a row type, where a template built at run time is not.)
  const columns = "customer_id, title, description, notes, tax_rate, valid_until, doc_type, circuits, job_id, inquiry_id, status" as const;
  const first = await supabase.from("quotes").select(`${columns}, estimate_format`).eq("id", id).maybeSingle();
  const withFormat = !(first.error && isMissingColumn(first.error));
  const { data: quote } = withFormat ? first : await supabase.from("quotes").select(columns).eq("id", id).maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  const format = (quote as { estimate_format?: unknown }).estimate_format;
  // Only an offer or a won estimate can be revised: a draft is edited, a declined one is over.
  if (revision && !["sent", "accepted"].includes(String((quote as { status?: string }).status)))
    return { ok: false, error: "Only a sent or accepted estimate can be revised — edit this one instead." };

  const { data: items, error: itemsErr } = await supabase
    .from("quote_line_items")
    // detail (0386): a copied task line keeps the hours and parts behind it.
    .select("description, quantity, unit, unit_price, category, detail")
    .eq("quote_id", id)
    .order("sort_order");
  // A read that failed must not become a copy with no lines and a green tick (projection law:
  // the failure is always a select list, and it used to be swallowed right here).
  if (itemsErr) return { ok: false, error: dbError(itemsErr) };

  const res = await saveQuote({
    customer_id: quote.customer_id ?? null,
    // A copy stands on its own — it isn't tied to the original's job. A REVISION is the same work: it
    // keeps the job and the lead, so accepting it brings that job in step and closes that lead's visit.
    job_id: revision ? ((quote as { job_id?: string | null }).job_id ?? null) : null,
    ...(revision ? { inquiry_id: (quote as { inquiry_id?: string | null }).inquiry_id ?? null } : {}),
    title: revision ? (quote.title ?? "Quote") : `${quote.title ?? "Quote"} (copy)`,
    // The scope paragraph prints on the customer's paper (audit v1085, carried): a copy and a revision
    // used to be born without it, because this select list never named it.
    description: (quote as { description?: string | null }).description ?? null,
    notes: quote.notes ?? "",
    tax_rate: Number(quote.tax_rate) || 0,
    // A revision is a fresh offer: the original's validity (often past, on an accepted estimate) would
    // make it read as expired to the reminders. The builder's default applies.
    valid_until: revision ? null : quote.valid_until ?? null,
    // A copy keeps the customer-facing word — a fixed-price Quote doesn't revert to Estimate.
    doc_type: quote.doc_type === "quote" ? "quote" : "estimate",
    // …and its own paper format (null = the company's), when the column was there to read.
    ...(withFormat ? { estimate_format: format === "tasks" || format === "detailed" ? format : null } : {}),
    items: (items ?? []).map((it: any) => ({
      description: it.description,
      quantity: Number(it.quantity) || 1,
      unit: it.unit || "ea",
      unit_price: Number(it.unit_price) || 0,
      detail: coerceTaskDetail(it.detail),
      group: it.category ?? undefined, // keep the scope group on a duplicate
    })),
  });
  if (!res.ok) return { ok: false, error: res.error };

  // THE REVISION REMEMBERS WHAT IT REVISES (0391): saveQuote has no such field (the builder's autosave
  // never sets it), so it is stamped on the row just made and read back. Without the stamp the copy is
  // a plain duplicate and would ADD to the original on acceptance — so a lost stamp is a refusal here,
  // with the way out named: the copy exists, delete it and revise again.
  if (revision && res.id) {
    const { data: stamped, error: sErr } = await supabase.from("quotes").update({ revises_quote_id: id }).eq("id", res.id).select("id");
    if (sErr || !stamped?.length) {
      reportError("quotes.duplicateQuote.revises", sErr ?? new Error("zero rows"), { from: id, to: res.id });
      // No half-made revision left behind: the copy goes (a draft with no children), and one action is named.
      const { data: gone, error: dErr } = await supabase.from("quotes").delete().eq("id", res.id).eq("status", "draft").select("id");
      if (dErr || !gone?.length) {
        // The stray copy is still there (audit v1085, carried): say so, or "Revise again" makes a second one.
        reportError("quotes.duplicateQuote.cleanup", dErr ?? new Error("zero rows"), { from: id, to: res.id });
        return { ok: false, error: `The revision could not be made${sErr ? ` (${dbError(sErr)})` : ""} and its half-made copy is still there — delete the new draft of this estimate, then Revise again.` };
      }
      return { ok: false, error: `The revision could not be made${sErr ? ` (${dbError(sErr)})` : ""} — Revise again.` };
    }
  }

  // THE CIRCUIT SCHEDULE COMES WITH IT. saveQuote has no circuits field (it is the builder's
  // autosave, and the builder never edits circuits), so the copy's schedule is written here, onto
  // the row saveQuote just made, and read back: a zero-row update is a 204, not an error. The copy
  // itself already exists by now, so a lost schedule is said out loud rather than failing the copy.
  const circuits = Array.isArray((quote as { circuits?: unknown }).circuits)
    ? ((quote as { circuits: QuoteCircuit[] }).circuits)
    : [];
  if (circuits.length && res.id) {
    const { data: wrote, error: cErr } = await supabase
      .from("quotes")
      .update({ circuits })
      .eq("id", res.id)
      .select("id");
    if (cErr || !wrote?.length) {
      if (cErr) reportError("quotes.duplicateQuote.circuits", cErr, { from: id, to: res.id });
      return {
        ok: true,
        id: res.id,
        warning: `The copy is made, but its ${circuits.length} circuit${circuits.length === 1 ? "" : "s"} didn't come with it. Add them on the copy's Circuit Schedule.`,
      };
    }
  }
  return { ok: true, id: res.id };
}

/**
 * The moment a deferred-customer estimate is WON, materialize its Contact — Erik's flow: a lead
 * becomes a saved customer only on approval. If the quote already has a customer, this is a no-op.
 * Otherwise, from the linked inquiry we CROSSCHECK the existing book (same phone/email/name → link
 * that customer, never duplicate — the "naturally Nort should pick that up" ask) and only create a
 * fresh Contact when the person is genuinely new. Auto-filled from the inquiry. Returns the resolved
 * customer id (or null if there's nothing to materialize from). RLS-scoped via the passed client.
 */
async function materializeQuoteCustomer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  q: { id: string; customer_id: string | null; inquiry_id: string | null },
  userId: string,
): Promise<string | null> {
  if (q.customer_id) return q.customer_id; // already has a contact
  if (!q.inquiry_id) return null; // standalone estimate, nothing to materialize from

  // The ONE win-mints-the-customer rule (lib/actions/win-customer) — shared with settleUp so an
  // accepted estimate and cash-in-hand cannot disagree about dedup, the address rule, or the stamp.
  const customerId = await customerForInquiry(supabase, q.inquiry_id, userId);
  if (!customerId) return null;

  await supabase.from("quotes").update({ customer_id: customerId }).eq("id", q.id);
  return customerId;
}

/** A work order or a materials list the acceptance could not make — or a list that is there with a word
 *  about itself — said, never dropped (audit v1085, carried: both Accept branches used to throw the two
 *  results away, so a failed take-off was neither said nor reported). */
function paperworkNote(wo: { ok: boolean; error?: string }, list: { ok: boolean; error?: string }): string | null {
  // Each rule's own words name the one way out (a refusal on purpose, or a lost write), so they pass through
  // unchanged — wrapping them named a second action.
  const bits = [!wo.ok ? (wo.error ?? "The work order could not be made — open Work Orders to add it.") : null, !list.ok ? (list.error ?? "The materials list could not be made — open Materials to add it.") : (list.error ?? null)].filter(Boolean);
  return bits.length ? bits.join(" ") : null;
}

export async function createJobFromQuote(
  quoteId: string,
  /** From updateQuoteStatus on an estimate already linked to a job: the estimate's figure as it stood
   *  BEFORE the status write counted this estimate's lines, whole, per task line and per part
   *  (lib/estimate/sync-job-tasks estimateLines). */
  opts?: { sizeBefore?: number | null; tasksBefore?: ReadonlyMap<string, number | null>; partsBefore?: ReadonlyMap<string, number> },
): Promise<{
  ok: boolean;
  error?: string;
  id?: string;
  /** The job was made, and something it should carry could not be listed. */
  note?: string;
  /** The job already existed and its list followed this estimate: what it did. */
  said?: string;
  /** The estimates this one REVISES (and their chain / siblings), now superseded by this acceptance (0391). */
  superseded?: string[];
}> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: q } = await supabase
    .from("quotes")
    // address/city/state/zip (0177) so the job can inherit the site typed on the ESTIMATE. A
    // column you don't select is a column you can't inherit — the specific way the address kept
    // dying at every stage, and it is a `select` list every time, never a missing column.
    .select("id, job_id, status, customer_id, title, quote_number, inquiry_id, address, unit, city, state, zip, revises_quote_id")
    .eq("id", quoteId)
    .maybeSingle();
  if (!q) return { ok: false, error: "Quote not found." };
  // A REPLACED ESTIMATE MAKES NO JOB (audit v1085, carried): its revision does. Named, or the way back.
  if ((q as { status?: string }).status === "superseded") {
    let rev: { id: string; quote_number: string | null } | null = null;
    try {
      rev = await revisionOf(supabase, { quoteId, orgId: ctx.orgId });
    } catch (e) {
      return { ok: false, error: `Couldn't check whether a revision replaced this estimate (${e instanceof Error ? e.message : String(e)}) — try again.` };
    }
    return { ok: false, error: rev ? `${rev.quote_number ?? "A revision"} replaced this estimate — open that one.` : "This estimate was replaced by a revision — set it back to Accepted first." };
  }
  // A REVISION TAKES THE ORIGINAL'S JOB (0391): born while the original was only sent (so with no
  // job), the revision would make a SECOND job when the customer accepted the original in between.
  // The work is one job: the revision is pinned to it (read back) and catches it up below.
  const revises = (q as { revises_quote_id?: string | null }).revises_quote_id ?? null;
  let sizeBefore = opts?.sizeBefore;
  let tasksBefore = opts?.tasksBefore;
  let partsBefore = opts?.partsBefore;
  if (!q.job_id && revises) {
    const { data: orig } = await supabase.from("quotes").select("job_id").eq("id", revises).maybeSingle();
    const origJob = (orig as { job_id?: string | null } | null)?.job_id ?? null;
    if (origJob) {
      // THE FIGURE BEFORE THIS ESTIMATE COUNTS (audit v1085, carried): read while the revision is not yet
      // linked, so the job's length — and each task's own (0395), each part's count (cn-v1133) — follows
      // it like any linked estimate's.
      if (sizeBefore === undefined) {
        const est = await estimateLines(supabase, { jobId: origJob, orgId: ctx.orgId });
        ({ sizeBefore, tasksBefore, partsBefore } = figureBefore(est));
      }
      const { data: pinned, error: pinErr } = await supabase.from("quotes").update({ job_id: origJob }).eq("id", quoteId).is("job_id", null).select("id");
      if (pinErr) return { ok: false, error: dbError(pinErr) };
      if (pinned?.length) q.job_id = origJob;
    }
  }
  if (q.job_id) {
    // THE JOB CATCHES UP (item 1, 2026-10-10). This used to stop here, so an estimate already linked
    // to a job — accepted again after a walk-back to edit it, a second estimate born from the job
    // page, one pinned with Attach — gave the job nothing: no tasks, no work order, no take-off. (The
    // customer's own Accept link already did all three, finishPublicAcceptance.) One rule for the
    // tasks (lib/estimate/sync-job-tasks) and the same two idempotent paperwork doors as a first
    // acceptance, each for THIS estimate (one work order + one list per estimate, 0388).
    // ONLY FOR AN ACCEPTED ESTIMATE: a linked estimate that is sent or draft (Nort's convertToJob on
    // one, a walk-back) has no tasks on the job yet, and the sync on its job would read its lines as
    // gone. The old answer stands for it.
    if ((q as { status?: string }).status !== "accepted") return { ok: true, id: q.job_id };
    // A REVISION SUPERSEDES THE ESTIMATE IT REVISES (0391) — before the follow, so the job's accepted
    // estimates are already one price for the work when its tasks and list are brought in step.
    const sup = await supersedeRevised(supabase, { revisionId: quoteId, orgId: ctx.orgId });
    if (sup.error) {
      // The original still counts: a follow now would double the job's tasks and hours. Nothing more is
      // done; the way back is to accept again (supersede is idempotent).
      reportError("createJobFromQuote:supersede", new Error(sup.error), { quoteId });
      return { ok: true, id: q.job_id, note: `The estimate this revises could not be marked superseded (${sup.error}). Accept it again to retry.` };
    }
    // THE PAPERWORK FIRST, THEN THE FOLLOW (cn-v1084): the take-off may ADOPT the job's own list (a
    // visit-born job's), seeding its plain lines and leaving the task parts to the materials sync,
    // which finds the visit's rows and re-keys them rather than adding them again. On a fresh list the
    // take-off seeds everything and the sync then finds every part by key.
    const wo = await createWorkOrderFromQuote(quoteId);
    const list = await createMaterialListFromQuote(quoteId);
    const follow = await jobFollows(supabase, { jobId: q.job_id, sizeBefore, tasksBefore, partsBefore }, ctx);
    revalidatePath(`/quotes/${quoteId}`);
    // THE PAPERWORK IS SAID: what the take-off did to the crew's list (a revision's plain rows follow,
    // Erik 2026-10-11), then what the job's tasks and parts did; what could not be made is a note.
    const said = [list.said, follow.said].filter(Boolean).join(" ");
    const note = [paperworkNote(wo, list), follow.note].filter(Boolean).join(" ");
    return { ok: true, id: q.job_id, ...(said ? { said } : {}), ...(note ? { note } : {}), ...(sup.superseded.length ? { superseded: sup.superseded } : {}) };
  }

  // A REVISION of an estimate that never had a job (a sent original) supersedes it on acceptance too
  // (nothing to double here: the original had no job). A failure is reported and said.
  const sup = await supersedeRevised(supabase, { revisionId: quoteId, orgId: ctx.orgId });
  if (sup.error) reportError("createJobFromQuote:supersede", new Error(sup.error), { quoteId });

  // Deferred-customer estimate won → create/link the Contact now, before the job (so the job gets it).
  const resolvedCustomerId = await materializeQuoteCustomer(supabase, q, ctx.userId);

  /**
   * THE JOB INHERITS ITS ADDRESS. It used to be born with none — this insert named five fields and
   * address was not one of them, even though materializeQuoteCustomer had just run one line above
   * holding the customer's full address. Thirteen of twenty jobs in production have a NULL city.
   *
   * Erik: "nothing collected the pertinent initial data like address which names the everything
   * from lead to invoice." This is the far end of that: the address is captured properly exactly
   * once, on the lead, and then every stage downstream re-derives it or does without.
   *
   * ORDER MATTERS — most specific first. The LEAD's address is the one somebody typed about THIS
   * job (and it is Places-resolved into four real columns). The customer's is their address on
   * file, which for a landlord or a property manager is very often not where the work is. Falling
   * back to it is right; preferring it would be how a crew gets sent to the wrong house.
   */
  const inheritedAddress = await (async () => {
    // THE ESTIMATE'S OWN SITE ADDRESS WINS. 0177 gave quotes the four columns; this function was
    // written one migration earlier and still started at the lead, so an address typed on the
    // ESTIMATE would have been silently outranked by the lead's older one. Nothing writes
    // quotes.address yet, which is the only reason it isn't already a live bug — and exactly why
    // it is worth closing before the field appears on the form rather than after.
    //
    // Precedence is most-specific-first throughout: the estimate is about THIS job, the lead was
    // about this job, the customer is a person who may own several buildings.
    // The unit travels with its street (0187 gave all three a unit): the job's name ends " #56" with it.
    if (q.address) return { address: q.address, unit: (q as { unit?: string | null }).unit ?? null, city: q.city, state: q.state, zip: q.zip };
    if (q.inquiry_id) {
      const { data: inq } = await supabase
        .from("inquiries")
        .select("address, unit, city, state, zip")
        .eq("id", q.inquiry_id)
        .maybeSingle();
      if (inq?.address) return inq;
    }
    const custId = resolvedCustomerId ?? q.customer_id;
    if (custId) {
      const { data: cust } = await supabase
        .from("customers")
        .select("address, unit, city, state, zip")
        .eq("id", custId)
        .maybeSingle();
      if (cust?.address) return cust;
    }
    return null;
  })();

  /* THE NAME IS THE STREET, NEVER "Estimate — …" OR "Job from Q-0012" (Erik 2026-09-27 / 09-28,
     "street number and name as always"). The one namer (lib/job-name): the street number and name
     the job inherits (" #56" with its unit); with no street, the customer as written and the
     estimate's own words, tag off ("Marla Finch · Panel Upgrade"). The public accept
     (accept_public_quote) names it through the SQL twin, public.job_name_from (0369). */
  const custForName = resolvedCustomerId ?? q.customer_id;
  const { data: whoRow } = custForName
    ? await supabase.from("customers").select("name, company_name, type").eq("id", custForName).maybeSingle()
    : { data: null };
  const { data: orgForName } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  // The lead's own spelling of who: the lead door seeds the estimate "New deck — <the lead's name>",
  // and a card matched by phone may spell the person differently ("rita" vs "Rita Moss"). The public
  // accept passes the same inq.name to the SQL twin (p_alias).
  const { data: leadForName } = q.inquiry_id
    ? await supabase.from("inquiries").select("name").eq("id", q.inquiry_id).maybeSingle()
    : { data: null };
  const jobName = jobNameFrom({
    sourceWords: q.title,
    aliases: [(leadForName as { name?: string | null } | null)?.name],
    customer: (whoRow as { name?: string | null; company_name?: string | null; type?: string | null } | null) ?? null,
    street: inheritedAddress?.address ?? null,
    unit: inheritedAddress?.unit ?? null,
    todayStr: todayStrInTz(getOrgSettings((orgForName as { settings?: unknown } | null)?.settings).timezone),
  });

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      customer_id: resolvedCustomerId ?? q.customer_id,
      inquiry_id: q.inquiry_id ?? null, // carry the lead provenance forward: lead → quote → job
      name: jobName,
      // THE KIND OF BILLING TRAVELS WITH THE JOB (2026-10-03). This insert named no billing_type, so
      // the column fell to its default of 'fixed' — and on a company whose work is mostly T&M that is
      // the wrong answer nearly every time. It is not only a label: jobBillsItsActuals(billing_type)
      // gates whether the hours and receipts are OFFERED when invoicing, whether the job page draws
      // its Unbilled card, what the customer's portal shows, AND step 4 of completeJobWhenPaid — the
      // guard that exists BECAUSE hours once went unbilled. A job wrongly born 'fixed' therefore
      // completes silently on a customer's payment with its unbilled work invisible on every surface
      // at once. readUsualBillingKind is the company's own answer and a failed read falls to "tm".
      billing_type: await readUsualBillingKind(supabase),
      ...(inheritedAddress
        ? {
            address: inheritedAddress.address,
            unit: inheritedAddress.unit ?? null,
            city: inheritedAddress.city,
            state: inheritedAddress.state,
            zip: inheritedAddress.zip,
          }
        : {}),
      // Born to_be_scheduled (lifecycle rework): the estimate is won but no dates exist yet —
      // the schedule promotion (advanceToScheduled) flips it to scheduled when a date lands.
      // The public accept path (accept_public_quote, migration 0127) does the same.
      status: "to_be_scheduled",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  // THE LINK IS COMPARE-AND-SET (cn-v1133): two doors in the same second (two office taps, the office
  // and the customer's link) each read "no job yet" and each inserted one — and the second's unguarded
  // link write pointed the estimate at the second job, with the first's tasks already born under the
  // first. The link lands only while job_id is still null and is read back; zero rows = another door
  // won, so the job this call just inserted (nothing on it yet) is removed, the other door's job is the
  // job, and its tasks are never born twice. The customer's door is guarded the same way inside
  // accept_public_quote since 0396 (`and job_id is null`, its own empty job removed when it loses), so
  // whichever door is second meets the one row (skeptic #39, B5).
  const { data: linked, error: linkErr } = await supabase.from("quotes").update({ job_id: job.id }).eq("id", quoteId).is("job_id", null).select("id");
  if (linkErr) {
    // THE EMPTY JOB GOES WITH THE LOST LINK (skeptic #39, S7): nothing is on it yet, and leaving it made
    // every retry a job more. Removed like the twin below — by id and company, read back; a removal that
    // fails is filed and said, so the one thing to do is named.
    const { data: dropped, error: dropErr } = await supabase.from("jobs").delete().eq("id", job.id).eq("org_id", ctx.orgId).select("id");
    const stuck = !!dropErr || !dropped?.length;
    if (stuck) reportError("createJobFromQuote:dropUnlinked", dropErr ?? new Error("zero rows"), { jobId: job.id, quoteId });
    return { ok: false, error: `${dbError(linkErr)}${stuck ? " An empty job was left behind — delete it on Jobs." : ""}` };
  }
  if (!linked?.length) {
    const { data: theirs } = await supabase.from("quotes").select("job_id").eq("id", quoteId).maybeSingle();
    const otherJob = (theirs as { job_id?: string | null } | null)?.job_id ?? null;
    if (!otherJob) return { ok: false, error: "The job was made but could not be linked to the estimate. Reload the estimate and try again." };
    const { data: dropped, error: dropErr } = await supabase.from("jobs").delete().eq("id", job.id).eq("org_id", ctx.orgId).select("id");
    if (dropErr || !dropped?.length) reportError("createJobFromQuote:dropTwin", dropErr ?? new Error("zero rows"), { jobId: job.id, quoteId, otherJob });
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/schedule");
    return {
      ok: true,
      id: otherJob,
      ...(dropErr || !dropped?.length ? { note: "Another door made this estimate's job in the same moment; a second, empty job could not be removed — delete it on Jobs." } : {}),
    };
  }
  // THE VISIT BEHIND THIS ESTIMATE IS WON, AND ATTACHED TO THE JOB IT BECAME (cn-v1069). This door
  // touched no appointment at all, so the inspection an estimate was written up from stayed "still
  // open business" after the job it priced was finished and paid. Attached, not absorbed (0237): the
  // visit keeps its own calendar life. Best-effort: the job is made whatever the visit says.
  await closeVisitsBehindQuote(supabase, { id: quoteId, inquiry_id: q.inquiry_id ?? null, job_id: job.id, revises_quote_id: revises }, { jobId: job.id, outcome: "won", orgId: ctx.orgId });

  // THE JOB IS BORN WITH ITS TASKS (W3, cn-v1075): every task line becomes a task on the job's
  // one list, in estimate order, and the job's planned length is the sum of HIS hours. One rule
  // (lib/estimate/born-with-tasks), shared with the customer's own Accept link. Before the take-off,
  // so the crew's list and the task list are made from the same lines. Best-effort, never silent:
  // the job stands, what could not be listed is reported and said.
  let note: string | undefined;
  const born = await bornWithTasks(supabase, { jobId: job.id, quoteId, orgId: ctx.orgId, createdBy: ctx.userId });
  if (born.error) {
    reportError("createJobFromQuote:tasks", new Error(born.error), { jobId: job.id, quoteId });
    note = `The job was made; its tasks could not all be listed (${born.error}). Add them on the job.`;
  }

  // Winning a quote spins up the field paperwork — a work order + a material
  // take-off (both idempotent) — and the job lands in the scheduler as
  // "scheduled" (pending). Best-effort: a job is still created if these no-op.
  const wo = await createWorkOrderFromQuote(quoteId);
  const list = await createMaterialListFromQuote(quoteId);

  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/schedule");
  const notes = [note, paperworkNote(wo, list), sup.error ? `The estimate this revises could not be marked superseded (${sup.error}). Accept it again to retry.` : null].filter(Boolean);
  return { ok: true, id: job.id, ...(list.said ? { said: list.said } : {}), ...(notes.length ? { note: notes.join(" ") } : {}), ...(sup.superseded.length ? { superseded: sup.superseded } : {}) };
}

/**
 * Fire-and-forget: push the office that an estimate was accepted. Deep-links to the
 * JOB (schedule it right there) when one exists. The in-app My Day "Accepted — schedule
 * it" feeder is the always-works fallback for when push is off. Never throws.
 */
async function pushQuoteAccepted(id: string): Promise<void> {
  try {
    const sb = createServiceClient();
    const { data: q } = await sb
      .from("quotes")
      .select("quote_number, org_id, job_id, customers(name)")
      .eq("id", id)
      .maybeSingle();
    if (!q?.org_id) return;
    const name = (q as { customers?: { name?: string } }).customers?.name;
    const staff = await orgStaffIds(q.org_id);
    const payload = {
      title: "Estimate accepted",
      body: `${q.quote_number || "An estimate"} was accepted${name ? ` by ${name}` : ""} — schedule the job.`,
      url: q.job_id ? `/jobs/${q.job_id}` : "/quotes",
    };
    await createNotifications(q.org_id, staff, { type: "quote_accepted", ...payload }); // the bell — always works
    await sendPushToProfiles(staff, "quote_accepted", payload); // + push if the recipient enabled it
  } catch {
    /* best-effort */
  }
}

/**
 * FOLLOW UP ON AN ESTIMATE ON A DAY (NY-feeders, 0366): the customer hasn't answered, and this is the
 * day to ask again. It writes quotes.follow_up_at and nothing else: NEVER valid_until, which is the
 * customer's own offer window, printed on the estimate they hold (moving it would change the offer,
 * not the reminder). The day is the company's today or later. A zero-row write is said, and before
 * 0366 (no such column) the refusal says the database needs its update.
 */
export async function setQuoteFollowUp(quoteId: string, date: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: org } = await ctx.supabase.from("organizations").select("settings").eq("id", ctx.orgId ?? "").maybeSingle();
  const day = checkComeBackDay(todayStrInTz(getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone), date);
  if (!day.ok) return { ok: false, error: day.error };
  const { data, error } = await ctx.supabase.from("quotes").update({ follow_up_at: day.day }).eq("id", quoteId).select("id");
  if (error) {
    return {
      ok: false,
      error: isMissingColumn(error) ? "This needs a quick database update before an estimate can take a follow-up day." : dbError(error),
    };
  }
  if (!data?.length) return { ok: false, error: "That estimate could not be found." };
  revalidatePath("/planner");
  revalidatePath("/quotes");
  revalidatePath(`/quotes/${quoteId}`);
  return { ok: true };
}

export async function updateQuoteStatus(id: string, status: string) {
  if (!(QUOTE_STATUSES as readonly string[]).includes(status))
    return { ok: false as const, error: `Status must be one of: ${QUOTE_STATUSES.filter((s) => s !== "superseded").join(", ")}.` };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const supabase = ctx.supabase;

  // THE JOB CATCHES UP (item 1, 2026-10-10): an estimate already linked to a job and accepted (again)
  // hands createJobFromQuote the estimate's figure as it stood BEFORE this write makes its lines
  // count — the only way the size can tell "still the estimate's" from his (sync-job-tasks).
  let linked: ({ jobId: string } & FigureBefore) | null = null;
  // SUPERSEDED is a fact the revision's acceptance records (0391), never a choice made by hand — and
  // not undone by hand while the revision stands: set back to accepted, the original would count
  // beside its revision (tasks, hours, buy list, contract total all doubled). With no revision standing
  // (deleted, or walked back) the estimate is his again and may move.
  if (status === "superseded") return { ok: false as const, error: "Superseded is set by accepting a revision — Revise this estimate instead." };
  const { data: was } = await supabase.from("quotes").select("job_id, status, revises_quote_id").eq("id", id).maybeSingle();
  // Acceptance is the moment work is won. The office "Accepted" dropdown used to just
  // flip the status — no job, no signal — so an accepted estimate vanished (the bug Erik
  // hit). Now it stamps accepted_at, ensures the job exists + linked (idempotent), and
  // alerts the office in-app (the My Day feeder catches status='accepted') AND by push.
  // ACCEPTED AGAIN ON AN ESTIMATE ALREADY ACCEPTED (cn-v1133): the day it was won stands (no
  // accepted_at bump — the customer's own Accept and the finishing window read it) and the office is
  // not rung twice for one acceptance; the job still catches up below (idempotent).
  const alreadyAccepted = status === "accepted" && (was as { status?: string } | null)?.status === "accepted";
  const patch: Record<string, unknown> =
    status === "accepted" && !alreadyAccepted ? { status, accepted_at: new Date().toISOString() } : { status };
  if ((was as { status?: string } | null)?.status === "superseded") {
    let rev: { id: string; quote_number: string | null } | null;
    try {
      rev = await revisionOf(supabase, { quoteId: id, orgId: ctx.orgId });
    } catch (e) {
      return { ok: false as const, error: `Couldn't check whether a revision replaced this estimate (${e instanceof Error ? e.message : String(e)}) — try again.` };
    }
    if (rev) return { ok: false as const, error: `${rev.quote_number ?? "A revision"} replaced this estimate — change that one instead.` };
  }
  if (status === "accepted") {
    const jobId = (was as { job_id?: string | null } | null)?.job_id ?? null;
    if (jobId) {
      const est = await estimateLines(supabase, { jobId, orgId: ctx.orgId });
      linked = { jobId, ...figureBefore(est) };
    }
  }
  // .select("id") so a zero-row write is caught (silent-write law). quotes_write is org-scoped,
  // so a foreign-org quote id matches nothing here — without the row check the function sailed
  // on to read the quote and ring THAT org's bell (audit v921 high). No rows = not ours = stop.
  const { data: updated, error } = await supabase.from("quotes").update(patch).eq("id", id).select("id");
  if (error) return { ok: false as const, error: dbError(error) };
  if (!updated?.length) return { ok: false as const, error: "That estimate could not be found." };
  /** What the job's list did when a linked estimate was accepted (shown under the status, not as a warning). */
  let said: string | undefined;
  // WALKING BACK AN ACCEPTED REVISION (audit v1085, carried): the estimate it replaced stays superseded
  // and the job has no accepted price, with no word. Said, with the one way back.
  const revisesId = (was as { revises_quote_id?: string | null } | null)?.revises_quote_id ?? null;
  if (revisesId && (was as { status?: string } | null)?.status === "accepted" && status !== "accepted") {
    const { data: orig } = await supabase.from("quotes").select("quote_number, status").eq("id", revisesId).maybeSingle();
    const o = orig as { quote_number?: string | null; status?: string } | null;
    if (o?.status === "superseded") said = `${o.quote_number ?? "The estimate this revised"} was replaced by this estimate and now stands replaced by nothing — set it back to Accepted if that work goes ahead.`;
  }

  /**
   * ONE DECISION, RECORDED WHEREVER IT IS MADE (Erik, 8/19: "it would be the one in the same
   * with the estimate acceptance").
   *
   * The inspection behind this estimate is asking the same question the status dropdown just
   * answered — so answer it there too (0205). Best-effort: the estimate's own status is the
   * fact that matters, and a missing appointment link must never fail the save.
   */
  try {
    // A REVISION'S NO DECIDES NO VISIT (audit v1085, carried): it inherits the original's lead and job, so
    // its decline stamped Lost on every visit behind them while the original's deal stood. Won is still won.
    const outcome = revisesId && status !== "accepted" ? null : outcomeForQuoteStatus(status);
    if (outcome) {
      const { data: q } = await supabase.from("quotes").select("id, inquiry_id, job_id").eq("id", id).maybeSingle();
      // By the lead, the job AND the capture's own backlink (lib/appointments/behind-quote): the
      // two-key match this replaced never read capture.quote_id, so a lead-less visit whose estimate
      // was declined stayed open on the Inspections tab for good (cn-v1069).
      if (q) await closeVisitsBehindQuote(supabase, q as { id: string; inquiry_id?: string | null; job_id?: string | null }, { outcome, orgId: ctx.orgId });
    }
  } catch {
    /* the estimate's status is the decision; stamping the visit is a courtesy */
  }

  if (status === "accepted") {
    // THE JOB IS THE POINT OF ACCEPTING (audit v921 high). createJobFromQuote returns
    // {ok:false} on failure rather than throwing, and .catch(() => {}) swallowed even a throw —
    // so a failed job/customer creation still reported "accepted" with no job, no work order,
    // no materials, and nothing on My Day. The status flip already landed; surface the failure
    // so the office knows to finish the hand-off instead of believing the work is scheduled.
    let jobWarn: string | null = null;
    try {
      // links quotes.job_id + spins up WO/materials; on a linked estimate, the job catches up
      const jobRes = await createJobFromQuote(id, linked ? { sizeBefore: linked.sizeBefore, tasksBefore: linked.tasksBefore, partsBefore: linked.partsBefore } : undefined);
      if (jobRes && jobRes.ok === false) jobWarn = jobRes.error ?? "The job wasn't created.";
      // The job was made and something it should carry (its tasks) could not be listed: said, not sunk.
      else if (jobRes?.note) jobWarn = jobRes.note;
      if (jobRes?.said) said = jobRes.said;
      // A REVISION accepted: the original it revises stopped counting — said first, it is the news.
      if (jobRes?.superseded?.length) said = [supersededWords(jobRes.superseded), said].filter(Boolean).join(" ");
    } catch (e) {
      jobWarn = "The job wasn't created.";
      reportError("updateQuoteStatus:createJob", e, { quoteId: id });
    }
    if (!alreadyAccepted) await pushQuoteAccepted(id); // one bell per acceptance, never one per re-select
    revalidatePath("/planner"); // so the "Accepted — schedule it" item shows immediately
    revalidatePath("/schedule");
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/quotes");
    if (jobWarn) {
      return { ok: true as const, warning: `Estimate accepted, but the job needs attention: ${jobWarn}`, ...(said ? { said } : {}) };
    }
  }
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true as const, ...(said ? { said } : {}) };
}

/**
 * TASK MODE — his typed scope becomes a TASK LIST, never priced lines the model decided on.
 *
 * Erik (2026-10-09): Draft With Estimator "is the speculation" — it read his punch list and came
 * back with crew-hours it had chosen, parts it had picked and a retail guess on each. "The
 * foundation underlying the ability to estimate a project … is pretty much always broken down into
 * tasks … each task carries its own labor and materials." So here the model only SPLITS: one task
 * per piece of work he named, with the hours HE gave for it and the parts HE named in it, plus the
 * fragment of his text each came from. Code checks every claim against his words
 * (screenEstimatorTasks, the inspector's own gate), taskLines prices the survivors from HIS hours
 * at THE rate and HIS parts, and a hole asks ("hours?", "how many?", "price?") instead of being
 * filled ([[no-speculation]]). Whatever the gate refused rides back as a "Not taken: …" question,
 * so nothing is lost silently.
 *
 * NO PRICE BOOK, NO CALCULATORS, NO RATE go to the model. There is nothing for it to price with,
 * which is the point; the prompt and the pricing are pure and tested (lib/estimate/task-mode).
 *
 * Only the free-text path of a research org comes here (runEstimator branches on
 * `typeof content === "string" && !catalogMode`). A catalog org (Tahoe Deck bids from its kits),
 * the plan paths and the supplier-quote path keep the priced-lines prompt below, untouched.
 */
async function runEstimatorTasks(opts: {
  client: ReturnType<typeof getAnthropic>;
  orgId: string | null;
  /** The model this run prices on — the gate's answer (cn-v1128), never a constant. */
  model: string;
  scope: string;
  trade: string;
  playbook: string | undefined;
  rows: unknown[];
  /** The rate his hours price at: the one he TYPED in the scope, else laborRateFor's answer. */
  rate: number;
  /** Whose figure `rate` is — the row each task is built with remembers it (TaskLabor.rate_from). */
  rateFrom: "rule" | "stated";
  levelPct: number | null;
  orgDefaultPct: number;
}): Promise<{ items: DraftLineItem[]; questions: string[]; description: string }> {
  const { client, orgId, model, scope, trade, playbook, rows } = opts;
  const msg = await client.messages.create({
    model: model,
    max_tokens: 8192,
    system: taskModePrompt({ trade, playbook }),
    messages: [{ role: "user", content: scope }],
  });
  // METERED (0162), into the same ledger and surface as the priced-lines path: one estimate is
  // one estimate on the bill whichever prompt it ran.
  void recordAiUsage({ orgId, model: model, surface: "estimator", usage: msg.usage as never });
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  // TRUNCATION IS CHECKED FIRST AND NEVER SALVAGED (the rule the priced-lines parse runs under): a
  // task list that quietly lost its last tasks is a wrong estimate wearing a finished one's face.
  if (msg.stop_reason === "max_tokens")
    throw new Error("That take-off ran longer than one pass — trim the scope and try again.");
  const parsed = (await parseAiJson(client, text, orgId)) as TaskModeParsed;
  return taskModeDraft(scope, parsed, {
    book: taskBookFromRows(rows),
    rate: opts.rate,
    rateFrom: opts.rateFrom,
    pricing: { levelPct: opts.levelPct, orgDefaultPct: opts.orgDefaultPct },
  });
}

/**
 * The estimator CORE. Takes the Anthropic user `content` — a free-text scope OR a PDF plan document
 * (+ instruction) — and returns priced line items + review questions from the org's OWN price book
 * (single source of truth, never web prices). Book items carry a "[CODE]" catalog tag (so the CED
 * order sheet resolves them); anything not in the book is flagged with a Home Depot estimate.
 * `markupPct` and `laborRate` come from the customer's pricing level; material sell resolves per
 * item through THE one markup rule (effectiveMarkupPct: level → item markup > 0 → org
 * default_markup_pct → 0), and labor $/hr falls back to the org default rate.
 *
 * A FREE-TEXT scope on a research org does not take this prompt at all: it goes to runEstimatorTasks
 * above, where the model splits his words into tasks and prices nothing.
 */
async function runEstimator(
  content: any,
  markupPct?: number,
  laborRate?: number,
  model: string = DEFAULT_MODEL,
): Promise<{ items: DraftLineItem[]; questions: string[]; description: string }> {
  const supabase = await createClient();
  const [{ data: org }, { data: book }] = await Promise.all([
    supabase.from("organizations").select("id, settings").limit(1).maybeSingle(),
    supabase
      .from("price_list_items")
      // The vendors under each code ride along (THE PROJECTION LAW), so a book line prices at the
      // org's default vendor through priceBookLine exactly as the quote pickers do (audit v994 VP2).
      .select(`code, description, buy_price, markup_pct, unit, category, ${ITEM_OPTIONS_EMBED}`)
      .eq("archived", false)
      .eq("price_list_item_options.archived", false),
  ]);
  // ONE RUN, ONE TICK (cn-v1128): counted here, past the gate and the input checks, so an empty
  // scope or a refused upload never burns the month's allowance. Best-effort, never awaited.
  void noteEstimateRun((org as { id?: string } | null)?.id);
  const orgS = getOrgSettings((org as any)?.settings);
  const playbook = orgS.quote_playbook?.trim();
  const rate = laborRateFor({ levelRate: laborRate, orgDefault: orgS.default_labor_rate }).rate; // THE one rule (lib/pricing/labor-rate)
  // A RATE HE TYPED. `content` is his scope on the text path and a content-block array on the plan
  // path; only the text he wrote is searched, never a PDF's contents — a number lifted out of
  // somebody else's drawing is not his instruction.
  const stated = statedLaborRate(
    typeof content === "string"
      ? content
      : (Array.isArray(content) ? content : [])
          .filter((b: { type?: string }) => b?.type === "text")
          .map((b: { text?: string }) => String(b.text ?? ""))
          .join("\n"),
  );

  const rows = (book ?? []) as any[];
  const catalog = rows
    .map((b) => `${b.code ?? "-"} | ${b.description} | ${b.unit} | $${Number(b.buy_price).toFixed(2)}${b.category ? " | " + b.category : ""}`)
    .join("\n");
  const byCode = new Map(rows.filter((b) => b.code).map((b) => [String(b.code).toUpperCase(), b]));

  // TRADE-NEUTRAL. This prompt opened "You are an estimator for an electrical contractor"
  // and ordered NEC calculations — so when Chris finished a DECK inspection and tapped
  // estimate, his deck was priced by an electrician who was told to size conduit. The org's
  // estimating_mode already distinguishes a catalog shop (bids from its own price book) from
  // a research shop (web-priced + trade calcs); the chat route has branched on it since
  // cn-v80. runEstimator never did.
  const catalogMode = orgS.estimating_mode === "catalog";
  const trade = tradeWordsOr(orgS);
  // The KEY, for the trade package's sentences and tools (cn-v1135): the words above name the
  // estimator, the key decides what it is told and handed.
  const tradeKey = orgTrade(orgS).key;

  const client = getAnthropic();
  // TASK MODE for his typed scope (runEstimatorTasks, above): the model splits, code checks, his
  // numbers price. A rate he TYPED wins over the resolved one here exactly as it does on the
  // priced-lines path (mapEstimatorLine's labor branch) — a dictated rate is an instruction.
  if (typeof content === "string" && !catalogMode) {
    return runEstimatorTasks({
      model,
      client,
      orgId: (org as { id?: string } | null)?.id ?? null,
      scope: content,
      trade,
      playbook,
      rows,
      rate: stated ?? rate,
      rateFrom: stated ? "stated" : "rule",
      levelPct: markupPct ?? null,
      orgDefaultPct: orgS.default_markup_pct,
    });
  }

  const system: Anthropic.MessageCreateParams["system"] = [
      {
        type: "text" as const,
        text:
          `You are an estimator for ${withArticle(trade)}. Draft quote line items for the scope, pricing materials from the contractor's OWN PRICE BOOK (their real net cost) — never invent market prices. ` +
          `LABOR: ${stated ? `$${stated}/hr — HE STATED THIS RATE IN THE SCOPE, use it` : rate > 0 ? `$${rate}/hr` : "a realistic US rate for this trade"}; estimate crew-hours realistically (one or more labor lines). ` +
          "MATERIALS: pick items from the PRICE BOOK below where they fit — return the EXACT catalog code and the book cost. " +
          // THE WIRE NUTS. Erik: "get rid of the wire nuts, that small stuff gets worked into the
          // material ideally grouped together as misc but i dont think its necessary anymore to
          // try and outsmart the contractor — we want to be doing what they need as simple as
          // possible." A dozen $4 rows, each wearing a confirm-this-price badge, buried among the
          // real lines is work he then has to undo by hand.
          //
          // TRADE-NEUTRAL WORDING, deliberately. This whole prompt was rewritten to be trade-blind
          // after it priced Chris's deck as an electrician told to size conduit; naming wire nuts
          // here would put that back one word at a time. Fasteners and adhesives are as true of a
          // deck as connectors are of a panel.
          "CONSUMABLES: never give small hardware its own line — fasteners, connectors, clips, tape, " +
          "adhesives, sealant and the like. Work them into the material line they belong to, or into a " +
          "single 'Misc materials' line if they belong to no one line. " +
          // THE QUANTITIES SENTENCE IS THE TRADE'S (cn-v1135, lib/trade-package): catalog mode
          // measures; research mode follows the trade's own rules, and only the electrician's
          // sentence names the calculator tools, because only the electrician is handed them.
          estimatorQuantitiesLine(tradeKey, catalogMode) +
          'If a needed material is NOT in the price book, still include it, estimate a typical retail price, and mark source "home_depot". ' +
          'Respond with ONLY a JSON OBJECT: {"description": string, "items": [ ... ], "questions": [ ... ]}. ' +
          // THE SCOPE, POLISHED. Erik: "and the description is the scope polished / by default and
          // editable." He writes a punch list on a ladder — "loose outlet in living room (15 mins)"
          // — and that is the right way to capture it and the wrong way to send it. The same pass
          // that prices the work can tidy the words, because it has already read them. Nothing is
          // invented here: it re-states HIS scope, so a sentence that adds work is a bug.
          '"description" = HIS OWN SCOPE, rewritten as 2-5 sentences a homeowner reads above the ' +
          'line items. Plain, calm, specific about rooms and what gets done. STATE ONLY WHAT HE ' +
          'DESCRIBED — no work he did not list, no hours, no prices, no sales language, no ' +
          'promises about workmanship or timelines. Keep his options as options ("either ... or"). ' +
          'If he wrote nothing to polish, return "". ' +
          'Each entry in "items": {"description": string, "quantity": number, "unit": "ea|ft|hr|lot", "kind": "material"|"labor", "catalog": string|null, "unit_cost": number, "source": "book"|"home_depot"} (labor: kind="labor", source="book", unit_cost=hourly rate). ' +
          // NOTHING WITHOUT DATA — THE SAME LAW THE LINE ITEMS RUN UNDER.
          //
          // Erik, on a real estimate whose questions were otherwise good: "it asked some questions
          // that didnt need to be asked as i stated the basics (feeders are already in place). the
          // MLO question is a good one but its so specific that it will be stated if needed so we
          // shouldnt be trying to make too much up without data just like i didnt mention anything
          // about sheetrock and will if needed."
          //
          // Two failures, one rule. It asked whether the existing feeders were sized for 200A when
          // he had already written that the feed wires are in place — questioning a fact he
          // stated. And it offered to quote drywall patch on a job where nobody had mentioned
          // opening a wall — inventing scope. A contractor who needs drywall in the price says so;
          // silence is not an omission to be helpfully filled, it is an answer.
          //
          // So a question must be ABOUT SOMETHING HE SAID, and it must be a genuine ambiguity in
          // what he said. Not a checklist of what a job like this sometimes involves.
          '"questions" = AT MOST TWO, and usually ZERO. A question is allowed ONLY when his own words are ' +
          'genuinely ambiguous in a way that changes the price — two readings of a count, a quantity he ' +
          'gave without a unit, an option he named without choosing. ' +
          'FORBIDDEN: anything he already stated plainly (do not ask him to confirm a fact he gave you); ' +
          'work he never mentioned (drywall, paint, permits, trenching, disposal — if he wanted it quoted he ' +
          'would have said so); trade options he did not raise; and any restatement of a line item you already ' +
          'returned. Never explain your own pricing. An empty list is the correct answer for a clear scope. ' +
          "No prose outside the JSON." +
          (playbook ? `\n\nCompany notes (apply on top; the price book + calc'd quantities govern):\n${playbook}` : ""),
      },
      {
        // THE PRICE BOOK IS CACHED. It is byte-stable per org between catalog edits and was
        // being re-billed at full input price on every single estimate — and Erik is about to
        // import his real CED net pricing, which multiplies that book several times over.
        // A cache read is ~10% of input, so repeat estimates stop paying for the catalog.
        type: "text" as const,
        text: `PRICE BOOK (code | description | unit | cost${rows.some((b) => b.category) ? " | category" : ""}):\n${catalog || "(price book is empty — estimate retail prices and flag every material)"}`,
        cache_control: { type: "ephemeral" as const },
      },
  ];

  /**
   * THE CALCULATORS ARE NOW REACHABLE. This call passed no `tools` array at all, so the estimator
   * — the one surface whose entire job is producing numbers — worked the NEC tables from memory
   * while four exact, tested calculators sat in the codebase unused. They're pure lookups: no
   * writes, no side effects, nothing to confirm, so the loop can run them without asking.
   *
   * Bounded at 3 rounds. An electrical research-mode estimate needs a handful of calls (wire size,
   * then drop on the long run); a bound means a model that gets stuck in a calculation loop still
   * returns an estimate instead of burning the org's shared daily budget. ONLY an electrical
   * company in research mode gets them (estimatorCalcTools, cn-v1135): a catalog company of any
   * trade and a research company of any other trade get none — an electrical tool array is noise
   * on a deck or a plumbing bid and costs tokens.
   */
  const tools = estimatorCalcTools(tradeKey, catalogMode) as unknown as Anthropic.Tool[] | undefined;
  const convo: Anthropic.MessageParam[] = [{ role: "user", content }];
  let msg!: Anthropic.Message;
  const LAST_ROUND = 2;
  for (let round = 0; round <= LAST_ROUND; round++) {
    msg = await client.messages.create({
      model: model,
      max_tokens: 8192, // headroom: a dense plan take-off can run long — don't truncate mid-JSON
      system,
      // On the FINAL round the tools come off, so the model has no choice but to answer. Otherwise
      // an estimate that spends its whole budget calculating exits the loop mid-tool-call with no
      // text to parse — the contractor gets an error instead of a draft, which is the worst
      // outcome of the three.
      //
      // COSTS A CACHE MISS, knowingly. The tools block sits in front of the price-book cache
      // breakpoint, so dropping it re-bills the whole catalog on the last round of any estimate
      // that called a calculator. `tool_choice: {type: "none"}` would forbid tool use while
      // leaving the prefix intact — the API takes it, but @anthropic-ai/sdk 0.36.3 does not type
      // it, and casting past the SDK on the estimator is not a trade worth making for an
      // optimisation that is invisible on a book this size. Revisit with the SDK bump, BEFORE the
      // CED net pricing import multiplies the catalog.
      ...(tools && round < LAST_ROUND ? { tools } : {}),
      messages: convo,
    });
    // METER EVERY ROUND (0162). This is the single most expensive operation in the product and it
    // was absent from the ledger — you cannot choose a price from a record that omits your biggest
    // cost. Metering only the last round would undercount an estimate that used its calculators.
    void recordAiUsage({
      orgId: (org as { id?: string } | null)?.id,
      model: model,
      surface: "estimator",
      usage: msg.usage as never,
    });
    const calls = msg.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    if (!calls.length) break;
    convo.push({ role: "assistant", content: msg.content });
    convo.push({
      role: "user",
      content: calls.map((c) => ({
        type: "tool_result" as const,
        tool_use_id: c.id,
        content: runCalc(c.name, c.input),
      })),
    });
  }

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");

  /**
   * THE ANSWER IS READ PROPERLY NOW.
   *
   * This was `JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))` — no fence
   * handling, no trailing-comma scrub, no repair, on the single most expensive operation in the
   * product. One unescaped inch mark in a description (`3/4" EMT`, the everyday vocabulary of this
   * trade) breaks the string and the whole take-off becomes "Estimator failed: Unexpected token".
   * Because the odds of hitting one rise with the SIZE of the take-off, it reads from the outside
   * as the estimator working sometimes and not others.
   *
   * TRUNCATION IS CHECKED FIRST AND NEVER SALVAGED. materials/actions.ts recovers what it can from
   * a cut-off array by trimming to the last complete object; that is right for a shopping list and
   * wrong here. A take-off that quietly loses its last four lines is a wrong PRICE wearing the
   * appearance of a finished one, and nothing on screen would say a line went missing. Say it ran
   * long instead, and let him split the job.
   */
  if (msg.stop_reason === "max_tokens")
    throw new Error("That take-off ran longer than one pass — split the plan, or trim the scope and try again.");
  const parsed = (await parseAiJson(client, text, (org as { id?: string } | null)?.id)) as {
    items?: any[];
    questions?: any[];
    description?: unknown;
  };
  const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  const raw = Array.isArray(parsed.items) ? parsed.items : [];
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map((q) => String(q).trim()).filter(Boolean)
    : [];
  /**
   * THE LADDER RUNS ON EVERY UNRESOLVED LINE, in code. The model returns a catalog code when it
   * recognises one; when it doesn't, it used to hand back an invented `unit_cost` and we took it.
   * But "not in the book" and "didn't think to look" produce identical JSON, and only one of them
   * justifies a guessed price. So every material line without a resolved code now goes through the
   * same book → paid-history ladder the assistant uses, server-side, before anything is priced.
   * Bounded and parallel: a dense plan take-off can return dozens of lines, and this must not turn
   * one estimate into a hundred serial round trips.
   */
  const LADDER_CAP = 30;
  const unresolved = raw
    .filter((i) => i.kind !== "labor")
    .filter((i) => !(i.catalog && byCode.has(String(i.catalog).trim().toUpperCase())))
    .map((i) => String(i.description ?? "").trim())
    .filter(Boolean)
    // NOT THE CATCH-ALL LINE. cn-v716 told the estimator to roll small hardware into one "Misc
    // materials" row, and the ladder promptly word-matched that row to an unrelated $8.03 part and
    // flagged it "check this is the right part before quoting it". There IS no right part: the
    // line is a bag of oddments by construction, so every match it can make is a wrong one. Its
    // own rough number stands, and the est-and-confirm flag says what it is.
    .filter((d) => !/^\s*misc(ellaneous)?\b/i.test(d));
  const uniqueDescs = [...new Set(unresolved.map((d) => d.toLowerCase()))].slice(0, LADDER_CAP);
  const laddered = new Map<string, LadderPrice>();
  await Promise.all(
    uniqueDescs.map(async (d) => {
      try {
        const p = await priceMaterial(supabase as never, {
          description: d,
          levelPct: markupPct ?? null,
          orgDefaultPct: orgS.default_markup_pct,
        });
        // Only a REAL find replaces the model's number. A "none" result means the ladder agrees
        // there's nothing on file, and the model's researched estimate is the best we have.
        if (p.source !== "none") laddered.set(d, p);
      } catch {
        // A lookup failure must never cost the contractor their draft — fall through to the
        // model's number, which is what would have happened anyway.
      }
    }),
  );

  // The per-line pricing rules live in @/lib/estimate/line-map as a PURE function, so the two
  // money bugs that used to hide in this closure (the echoed labor rate, the book-vs-model unit)
  // are covered by tests instead of by review.
  const items: DraftLineItem[] = raw.map((i) =>
    mapEstimatorLine(i, {
      rate,
      statedRate: stated,
      byCode: byCode as Map<string, BookRow>,
      levelPct: markupPct ?? null,
      orgDefaultPct: orgS.default_markup_pct,
      laddered,
    }),
  );
  return { items, questions, description };
}

function estimatorError(e: any) {
  return {
    ok: false as const,
    error: e?.message?.includes("ANTHROPIC_API_KEY")
      ? "AI isn't available right now. Try again later."
      : `Estimator failed: ${e?.message ?? "unknown error"}`,
  };
}

/** The estimator, from a free-text scope. */
/**
 * THE ESTIMATOR GATE (0169 audit, finding F).
 *
 * These two exports were the only ones in this file without `requireStaff()` — all sixteen
 * siblings have it, including the far cheaper generateCircuitSchedule. And /quotes/new has no role
 * check either, so a tech reached the estimator by typing the URL.
 *
 * Each call is the frontier model at max_tokens 8192 for up to three rounds, plus a 20 MB base64
 * PDF on the plan path — this file's own comment calls it "the single most expensive operation in
 * the product." Ungated it was two things at once: direct spend on our API key, and a CROSS-ROLE
 * denial of service, because every round meters into the same ai_usage ledger the chat ceiling
 * reads. One tech in a loop pushes the org past the ceiling and Nort 429s for the owner and the
 * whole office, while the estimator itself never checked that ceiling and kept spending.
 *
 * No data leak, at least: price_list_read is staff-only (0056), so a tech's catalog came back
 * empty and the CED net pricing never reached him.
 */
async function guardEstimator(): Promise<
  | { ok: true; orgId: string | null; model: string; notes: string[] }
  | { ok: false; error: string }
> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Only office staff can run the estimator." };
  // Per-user, because the ceiling below is per-ORG and a runaway loop would otherwise burn the
  // whole company's month before anyone noticed.
  if (await rateLimited(`estimator:${ctx.userId}`, 10, 900, { failClosed: true }))
    return { ok: false, error: "That's a lot of estimates in a row — give it a minute." };
  const orgId = await currentOrgId();
  // ONE GATE (cn-v1137, aiAllowed): a company whose plan has ended gets no estimator — said in the
  // asker's role — and then the ceiling, in its own words.
  const gate = await aiAllowed(orgId, undefined, { ceilingWords: "Your company has hit its AI ceiling for the last 30 days. Message us and we'll lift it." });
  if (!gate.ok) return { ok: false, error: gate.why };
  // THE PLAN'S ALLOWANCE, ENFORCED (cn-v1128). plans.ts has promised "40 / 120 / unlimited full
  // estimates a month" since July and nothing ever read it (the deep review's pricing-01). Past the
  // month's line the run moves to the routine model and the draft SAYS so, as the first line of
  // its questions — it never refuses (overFullEstimateAllowance's contract: degrade, don't block).
  // One run = one 'estimator:run' tick on the ledger (left by runEstimator, after the input checks),
  // so the count is runs, never model rounds, and a refused input never burns the month.
  const [used, plan] = await Promise.all([fullEstimatesThisMonth(orgId), orgPlanTier(orgId)]);
  const tier = estimateTierFor(plan);
  const over = overFullEstimateAllowance(tier, used);
  const notes: string[] = [];
  if (over) {
    const p = planByTier(tier);
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const planWord = plan === "trial" ? "your trial" : `the ${p?.name} plan`;
    notes.push(`Past this month's ${p?.fullEstimatesPerMonth} full estimates on ${planWord}, so this one ran on the lighter model. Full estimates come back ${next}.`);
  }
  return { ok: true, orgId, model: over ? modelFor("routine") : modelFor("reasoning"), notes };
}

export async function generateQuoteDraft(
  scope: string,
  markupPct?: number,
  laborRate?: number,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[]; description: string } | { ok: false; error: string }> {
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!scope.trim()) return { ok: false, error: "Describe the work first." };
  try {
    const out = await runEstimator(scope, markupPct, laborRate, gate.model);
    return { ok: true, ...out, questions: [...gate.notes, ...out.questions] };
  } catch (e) {
    return estimatorError(e);
  }
}

/**
 * The estimator, from an uploaded PLAN. Claude reads the PDF natively (legend, schedules, general
 * notes, AND the drawing) and takes it off into the same price-book-priced line items + review
 * questions — a draft you correct, not an auto-bid. FormData carries `file` (the plan PDF), an
 * optional `scope` note (what's already done / excluded / any correction the plan can't show —
 * a plan never says the garage is finished or the panel's already in), and optional `markupPct` +
 * `laborRate` (the selected customer's pricing level — material markup and labor $/hr).
 */
/**
 * A SUPPLIER QUOTE BECOMES LINE ITEMS — transcription, never a take-off.
 *
 * Erik: "I need to upload an estimate from CED so they can be inserted as line items with a mark
 * up." A supplier quote is the opposite document to a plan: the plan needs everything DERIVED
 * (counts, wire sizes, code calcs), the CED quote already IS the answer — descriptions,
 * quantities, and his real net prices, on paper. So the model's only job here is to read it out
 * faithfully. No take-off, no NEC, no inventing lines the paper doesn't carry, and it never
 * touches the price book or the ladder: the net ON THE QUOTE is the buy price, by definition —
 * re-pricing it from history would replace today's quoted number with an older one.
 *
 * THE MARKUP IS APPLIED IN CODE, off the same ladder every other material line uses (customer
 * level → org default), and each line's flag shows the net it came from — so the office can see
 * at a glance what CED charged versus what the customer is asked.
 *
 * Lands in the cn-v716 PROPOSAL list like every other generate: nothing on the estimate until
 * he ticks and adds.
 */

/**
 * THE UPLOAD ARRIVES BY STORAGE, NOT BY REQUEST BODY (#116). Vercel caps any request at
 * ~4.5MB — beneath a single sheet of Andrew's plan sets — so the browser now uploads to the
 * org's own folder in the `documents` bucket (0013 RLS: org members only) and the action gets
 * a PATH. The download below runs on the USER's client, so a crafted cross-org path dies at
 * RLS instead of at a hand-rolled check. The legacy `file` field still works for any open tab
 * from before this shipped.
 */
/**
 * THE CUSTOMER'S OWN PLAN, READ WHERE IT LIVES (Andrew's estimate said "the plan set is attached
 * but I can't open it" — the PDF sat on the LEAD in intake-uploads while the take-off could only
 * read a file re-uploaded from the office's device). This transport hands the estimator that
 * stored file directly: same three checks as intakeFileUrl (RLS-scoped lead read proves
 * membership → the path must sit in that org's intake folder → the lead must actually carry it),
 * then a service download. NO delete-on-read — the stash is a transport, but this file is the
 * customer's record on the lead and must survive every reading.
 */
async function intakePlanUpload(
  formData: FormData,
): Promise<{ ok: true; bytes: ArrayBuffer; size: number; name: string; mime: string } | { ok: false; error: string } | null> {
  const intakePath = String(formData.get("intakePath") ?? "").trim();
  if (!intakePath) return null; // not this transport — fall through to the stash
  const inquiryId = String(formData.get("inquiryId") ?? "").trim();
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Only office staff can run the estimator." };
  const { data: inq } = await ctx.supabase.from("inquiries").select("id, org_id, intake").eq("id", inquiryId).maybeSingle();
  if (!inq) return { ok: false, error: "The lead this plan belongs to wasn't found." };
  const orgId = String((inq as { org_id?: string }).org_id ?? "");
  if (!isOwnIntakePath(orgId, intakePath)) return { ok: false, error: "That file isn't on this lead." };
  const answers = ((inq as { intake?: { intake_answers?: Record<string, unknown> } }).intake?.intake_answers ??
    {}) as Record<string, unknown>;
  const known = Object.values(answers).some((v) => Array.isArray(v) && v.includes(intakePath));
  if (!known) return { ok: false, error: "That file isn't on this lead." };
  const { data: blob } = await createServiceClient().storage.from(INTAKE_BUCKET).download(intakePath);
  if (!blob) return { ok: false, error: "Couldn't read the customer's plan from storage." };
  return {
    ok: true,
    bytes: await blob.arrayBuffer(),
    size: blob.size,
    name: uploadDisplayName(intakePath),
    mime: blob.type || "application/pdf",
  };
}

async function estimatorUpload(
  formData: FormData,
  opts: { orgId: string | null; keep?: boolean },
): Promise<
  | { ok: true; bytes: ArrayBuffer; size: number; name: string; mime: string; stashPath: string | null }
  | { ok: false; error: string }
> {
  const storagePath = String(formData.get("storagePath") ?? "").trim();
  if (storagePath) {
    // ONLY THE STASH (Panel plan, phase 4). Anything this door reads it may delete, so a path
    // anywhere else in the org's folder (a job's photo, a filed plan) is refused before either.
    if (!isEstimatorStash(opts.orgId, storagePath)) return { ok: false, error: "That upload isn't in the estimator's folder. Upload it again." };
    const supabase = await createClient();
    const { data: blob, error } = await supabase.storage.from("documents").download(storagePath);
    if (error || !blob) return { ok: false, error: "Couldn't read the uploaded file — try the upload again." };
    // THE STASH IS A TRANSPORT, NOT A LIBRARY (audit 7): delete on read, best-effort — an
    // orphan per estimate would grow the bucket forever, and a CED quote's net pricing must
    // not sit where any org member (field techs included) can list and download it. The one
    // exception is an upload the person said is PLANS (keep): the plan door files it
    // (keepPlanUpload), and removes it itself if it can't be kept.
    if (!opts.keep) void supabase.storage.from("documents").remove([storagePath]).then(() => undefined, () => undefined);
    return {
      ok: true,
      bytes: await blob.arrayBuffer(),
      size: blob.size,
      name: String(formData.get("fileName") ?? "") || storagePath.split("/").pop() || "upload",
      mime: blob.type || "",
      stashPath: opts.keep ? storagePath : null,
    };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file to upload." };
  return { ok: true, bytes: await file.arrayBuffer(), size: file.size, name: file.name, mime: file.type, stashPath: null };
}

export async function generateQuoteDraftFromSupplier(
  formData: FormData,
): Promise<
  | { ok: true; items: DraftLineItem[]; questions: string[]; description: string; bookReview: BookReview }
  | { ok: false; error: string }
> {
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    // A SUPPLIER QUOTE IS NEVER KEPT: its net pricing is deleted the moment it is read (audit 7).
    const up = await estimatorUpload(formData, { orgId: gate.orgId });
    if (!up.ok) return up;
    if (up.size > 20 * 1024 * 1024) return { ok: false, error: "File is too large (max 20 MB — the reader's ceiling)." };
    const isPdf = up.mime === "application/pdf" || /\.pdf$/i.test(up.name);
    const isText = /csv|text|plain/.test(up.mime) || /\.(csv|txt)$/i.test(up.name);
    if (!isPdf && !isText) return { ok: false, error: "Upload the supplier quote as a PDF or CSV." };

    const mk = formData.get("markupPct");
    const levelPct = mk != null && String(mk) !== "" ? Number(mk) : null;

    const supabase = await createClient();
    const [{ data: org }, { data: bookRows }] = await Promise.all([
      supabase.from("organizations").select("id, settings").limit(1).maybeSingle(),
      // For the price-book review below — read-only here; price_list_read is staff-only (0056),
      // and guardEstimator already required staff.
      supabase.from("price_list_items").select("id, code, description, unit, buy_price").eq("archived", false),
    ]);
    const orgS = getOrgSettings((org as { settings?: unknown } | null)?.settings);

    const instruction =
      "This is a SUPPLIER QUOTE (a materials price quote from a supply house). TRANSCRIBE its line items " +
      "faithfully — do not take off, derive, or add anything that is not printed on it. For each line: " +
      '{"description": string (the supplier\'s wording, plus the part number if printed), "quantity": number, ' +
      '"unit": string (ea/ft/box/roll/lot — as printed, ea if unstated), "unit_cost": number (the NET/each price ' +
      "printed for that line — never the extended total)}. Do not turn subtotal, tax, freight or total rows into items. " +
      'If the quote prints a SALES TAX amount, report it once as "tax_total" (the dollar amount); null if none is printed. ' +
      'Respond with ONLY a JSON object {"items": [...], "tax_total": number|null}. No prose.';

    const content: unknown[] = isPdf
      ? [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(up.bytes).toString("base64") } },
          { type: "text", text: instruction },
        ]
      : [{ type: "text", text: `${instruction}\n\nTHE QUOTE:\n${new TextDecoder().decode(up.bytes).slice(0, 200_000)}` }];

    // A supplier quote is READ, not estimated: never counted against the allowance and never
    // degraded (plans.ts counts plan take-offs and researched pricing, the skeptic's should-fix 3).
    const model = modelFor("reasoning");
    const client = getAnthropic();
    const msg = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content: content as never }],
    });
    void recordAiUsage({ orgId: (org as { id?: string } | null)?.id, model, surface: "estimator", usage: msg.usage as never });
    if (msg.stop_reason === "max_tokens")
      return { ok: false, error: "That quote ran longer than one pass — split the file and try again." };
    const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    const parsed = (await parseAiJson(client, text, (org as { id?: string } | null)?.id)) as {
      items?: unknown[];
      tax_total?: unknown;
    };

    // MARKUP IN CODE, provenance on the flag. The transcription is the model's; the money is not.
    //
    // ── AND THE SALES TAX HE PAID IS COST, NOT MARGIN ─────────────────────────────────────────
    // Erik: "we do need to account for the tax somehow, it does get covered in the markup but not
    // sure how it should be done properly." Properly is LANDED COST: the tax CED charges him is as
    // much a part of what the material cost as the freight is, so it folds into the buy price
    // BEFORE markup — spread across the lines in proportion to their value, which is exactly how
    // the supplier computed it. Leaving it "in the markup" means the margin quietly eats ~8%, and
    // for an org billing at 0% markup (Vivian Builders' default) it means literally billing below
    // cost on every taxed line. The flag says when a line carries its tax share, so nothing about
    // the number is a mystery. (An org buying on a resale certificate pays no tax and nothing
    // changes; if one ever wants quoted-tax IGNORED on principle, that's a one-line org setting
    // when they ask.)
    const rawItems = (Array.isArray(parsed.items) ? parsed.items : []).map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const qty0 = Number(i.quantity);
      return {
        description: String(i.description ?? "").trim(),
        quantity: Number.isFinite(qty0) && qty0 > 0 ? qty0 : 1,
        unit: String(i.unit ?? "ea").trim() || "ea",
        net: Math.max(0, Number(i.unit_cost) || 0),
      };
    });
    const extended = rawItems.reduce((t, l) => t + l.net * l.quantity, 0);
    const taxTotal = Math.max(0, Number(parsed.tax_total) || 0);
    // Proportional-by-value: a single factor on every net reproduces the supplier's own math.
    const taxFactor = extended > 0 && taxTotal > 0 ? taxTotal / extended : 0;

    const pct = effectiveMarkupPct({ levelPct, itemPct: 0, orgDefaultPct: orgS.default_markup_pct });
    const items: DraftLineItem[] = rawItems
      .map((l) => {
        const landed = l.net * (1 + taxFactor);
        return {
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unit_price: Math.round(landed * (1 + pct / 100) * 100) / 100,
          flag: taxFactor
            ? `supplier net $${l.net.toFixed(2)} + tax share + ${pct}%`
            : `supplier net $${l.net.toFixed(2)} + ${pct}%`,
        };
      })
      .filter((l) => l.description);
    if (!items.length) return { ok: false, error: "Couldn't read any line items off that quote — is it the itemized page?" };

    // THE BOOK REVIEW — read off the PRE-tax nets, because the book stores COST as the supplier
    // states it; the tax share is an estimate-side concern (landed cost), not a catalog fact.
    // Pure matching (lib/pricing/book-review): exact code, then exact normalized description,
    // no fuzzy rung. Everything it proposes is opt-in in the UI; nothing here writes.
    const bookReview = reviewAgainstBook(
      (bookRows ?? []) as never,
      rawItems.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, net: l.net })),
    );
    return { ok: true, items, questions: [], description: "", bookReview };
  } catch (e) {
    return estimatorError(e);
  }
}

export async function generateQuoteDraftFromPlan(
  formData: FormData,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[]; description: string; kept?: KeptPlan } | { ok: false; error: string; kept?: KeptPlan }> {
  // Gate BEFORE the 20 MB file is read and base64'd — an ungated caller shouldn't be able to make
  // the server do that work either.
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  let kept: KeptPlan | undefined;
  try {
    // The lead's stored plan first (intakePath), the office's own upload otherwise. The office's
    // upload through THIS door is plans, so it is kept (Erik's decision 3), never deleted on read.
    const up = (await intakePlanUpload(formData)) ?? (await estimatorUpload(formData, { orgId: gate.orgId, keep: true }));
    if (!up.ok) return { ok: false, error: up.error === "Choose a file to upload." ? "Choose a plan PDF to upload." : up.error };
    const stash: string | null = "stashPath" in up && typeof up.stashPath === "string" ? up.stashPath : null;
    const refuse = async (error: string) => {
      // Not a plan this door reads: it isn't kept either (the stash stays a transport).
      if (stash) void (await createClient()).storage.from("documents").remove([stash]).then(() => undefined, () => undefined);
      return { ok: false as const, error };
    };
    if (up.mime !== "application/pdf" && !/\.pdf$/i.test(up.name)) return refuse("Upload the plan as a PDF.");
    // Cap at 20 MB: base64 inflates ~33%, and Anthropic's per-request ceiling is 32 MB.
    if (up.size > 20 * 1024 * 1024) return refuse("Plan is too large (max 20 MB — the reader's ceiling).");
    // FILED BEFORE THE READ: a take-off that fails still leaves the plans on file.
    if (stash && gate.orgId) {
      kept = await keepPlanUpload((await createClient()) as never, {
        orgId: gate.orgId,
        stashPath: stash,
        name: up.name,
        size: up.size,
        jobId: formData.get("jobId"),
        customerId: formData.get("customerId"),
      });
    }
    const mk = formData.get("markupPct");
    const markupPct = mk != null && String(mk) !== "" ? Number(mk) : undefined;
    const lr = formData.get("laborRate");
    const laborRate = lr != null && String(lr) !== "" ? Number(lr) : undefined;
    const note = String(formData.get("scope") ?? "").trim();
    const b64 = Buffer.from(up.bytes).toString("base64");
    const content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
      { type: "text", text: planTakeoffInstruction(note) },
    ];
    const out = await runEstimator(content, markupPct, laborRate, gate.model);
    return { ok: true, ...out, questions: [...gate.notes, ...out.questions], kept };
  } catch (e) {
    return { ...estimatorError(e), kept };
  }
}

/**
 * The plan-path instruction, shared by every door that hands the estimator a drawing. TRADE-
 * NEUTRAL, deliberately: this text used to open "Take off this electrical plan … per NEC", which
 * was redundant for Erik (the system prompt already orders code-calculated quantities for his
 * trade) and WRONG the moment Vivian Builders' plans arrived — the same one-word-at-a-time
 * regression the runEstimator prompt was rewritten to prevent. The trade lives in ONE place: the
 * system prompt.
 */
function planTakeoffInstruction(note: string): string {
  return (
    "Take off this plan set into estimate line items. Read the LEGEND, schedules, general notes, AND the drawings themselves; count what the sheets show and calculate quantities per the QUANTITIES rules. Only exclude work the plans explicitly mark as existing/complete. Price per the rules, and in 'questions' list what to review — uncertain counts (say if a sheet is too dense to count reliably), plan callouts that imply extra scope, and owner decisions." +
    // The contractor's note OVERRIDES the drawing. A plan can't show what's already been done
    // or a field decision — so honor exclusions like "garage is finished" or "panel & 2in
    // conduit already in" and DON'T bill that work, even though the drawing still depicts it.
    (note
      ? `\n\nTHE CONTRACTOR ADDED THIS SCOPE NOTE — it OVERRIDES the drawings. Apply it strictly: exclude anything called out as already done/existing, honor stated counts and corrections, and DO NOT bill work the note says is complete even if the plans still show it:\n"""${note}"""`
      : "")
  );
}

/**
 * "GENERATE" READS THE PLANS THE CUSTOMER ALREADY SENT (Andrew: "Still not creating … any line
 * items at all. It acknowledges the plans exist, but nothing further…?"). He was right to expect
 * that: his Generate taps ran the TEXT path, whose prefill NAMES the attached plan set while
 * telling the model it cannot open it — so the model honestly asked for the scope in writing
 * instead of inventing lines. When the linked lead carries plan PDFs, the take-off now reads
 * them: every readable PDF inside the same 20MB budget as every other reading, skips named out
 * loud as a review question, the scope box still overriding the drawings.
 */
export async function generateQuoteDraftFromLeadPlans(
  inquiryId: string,
  scope: string,
  markupPct?: number,
  laborRate?: number,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[]; description: string } | { ok: false; error: string }> {
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    const ctx = await requireStaff();
    if ("error" in ctx) return { ok: false, error: ctx.error ?? "Only office staff can run the estimator." };
    const { data: inq } = await ctx.supabase.from("inquiries").select("id, org_id, intake").eq("id", inquiryId).maybeSingle();
    if (!inq) return { ok: false, error: "The lead these plans belong to wasn't found." };
    const orgId = String((inq as { org_id?: string }).org_id ?? "");
    const paths = intakePaths((inq as { intake?: unknown }).intake).filter((p) => isOwnIntakePath(orgId, p));
    if (!paths.length) return { ok: false, error: "This lead has no uploaded plans." };

    const svc = createServiceClient();
    const sized: { path: string; bytes: number | null }[] = [];
    for (const p of paths) {
      if (extOf(p) !== "pdf") {
        sized.push({ path: p, bytes: null });
        continue;
      }
      const { data: meta, error } = await svc.storage.from(INTAKE_BUCKET).info(p);
      sized.push({ path: p, bytes: error ? null : Number((meta as { size?: number } | null)?.size ?? 0) });
    }
    const { read, skipped } = pickReadablePlans(sized);
    if (!read.length) return { ok: false, error: "None of the customer's uploads is a readable plan PDF." };

    const docs: any[] = [];
    for (const p of read) {
      const { data: blob } = await svc.storage.from(INTAKE_BUCKET).download(p);
      if (!blob) {
        skipped.push({ name: uploadDisplayName(p), reason: "file no longer in storage" });
        continue;
      }
      docs.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(await blob.arrayBuffer()).toString("base64") },
      });
    }
    if (!docs.length) return { ok: false, error: "Couldn't read the customer's plans from storage." };

    const content = [...docs, { type: "text", text: planTakeoffInstruction(scope.trim()) }];
    const out = await runEstimator(content, markupPct, laborRate, gate.model);
    // NO SILENT CAPS: what didn't ride is a review item, not a secret.
    if (skipped.length)
      out.questions = [`Not read: ${skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`, ...out.questions];
    return { ok: true, ...out, questions: [...gate.notes, ...out.questions] };
  } catch (e) {
    return estimatorError(e);
  }
}

/**
 * Derive a CIRCUIT SCHEDULE from a saved estimate's line items — the panel layout behind the
 * price (which breaker feeds what, on which wire). Reads the breaker + wire lines to size each
 * circuit and groups loads the way an electrician wires them, then stores it on the quote so it
 * prints as a second page. A draft you correct — the office can edit every row after.
 */
export async function generateCircuitSchedule(
  quoteId: string,
): Promise<{ ok: true; circuits: QuoteCircuit[] } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Not allowed." };
  const supabase = ctx.supabase;

  const { data: quote } = await supabase
    .from("quotes")
    .select("id, title, description, org_id")
    .eq("id", quoteId)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Estimate not found." };
  const { data: items } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit")
    .eq("quote_id", quoteId)
    .order("sort_order");
  const lines = (items ?? []).map((i: any) => `${i.quantity} ${i.unit ?? ""} · ${i.description}`).join("\n");
  if (!lines.trim()) return { ok: false, error: "Add line items first." };

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 3000,
      system:
        "You are a master electrician laying out a residential branch-circuit (panel) schedule from an estimate's line items. " +
        "Use the BREAKER lines to determine how many circuits and their sizes, and the WIRE lines for conductor sizes. " +
        // THE PART NUMBER IS THE SIZE (Panel plan, phase 0; phase 3). E-017 read a Q120 line as
        // "SP 15A": a Siemens Q1xx is ONE pole and the digits after the 1 are the amps. The table
        // comes from the Breakers card's own decoder (src/lib/panel/breaker-catalog.ts), so the
        // estimate and the card can never disagree about what a Q2020 is.
        promptCodeTable() +
        "Group loads the way an electrician actually wires them: kitchen small-appliance (two 20A), dishwasher, disposal, refrigerator/freezer, general receptacles, lighting (15A on 14 AWG), bath, laundry/dryer, range, EACH mini-split on its own circuit, bath fan, smoke/CO. Low-voltage (data/Cat6/coax/thermostat/doorbell) is NOT a breaker — leave it out. " +
        'Respond with ONLY a JSON ARRAY, one object per circuit: {"ckt": string, "description": string, "wire": string, "breaker": string, "load": string}. ' +
        'ckt = circuit position ("1","2"…). wire = e.g. "12/2","14/2","10/3","6/3". breaker = e.g. "20A","2P 30A","2P 50A". load = a short note (room/appliance or estimated VA). Number circuits sequentially, matching the breaker counts in the line items. No prose outside the JSON array.',
      messages: [{ role: "user", content: `Estimate: ${quote.title ?? ""}\n${(quote as any).description ?? ""}\n\nLine items:\n${lines}` }],
    });
    void recordAiUsage({ orgId: (quote as { org_id?: string }).org_id, model: DEFAULT_MODEL, surface: "circuit-schedule", usage: msg.usage as never });
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as any[];
    const circuits: QuoteCircuit[] = arr
      .map((r, i) => ({
        ckt: r.ckt != null ? String(r.ckt).trim() : String(i + 1),
        description: String(r.description ?? "").trim(),
        wire: r.wire ? String(r.wire).trim() : null,
        breaker: r.breaker ? String(r.breaker).trim() : null,
        load: r.load ? String(r.load).trim() : null,
      }))
      .filter((r) => r.description);
    // Read back (the silent-write law): a zero-row update is a 204, and "no error" is not "saved".
    const { data: wrote, error } = await supabase.from("quotes").update({ circuits }).eq("id", quoteId).select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!wrote?.length) return { ok: false, error: "The circuit schedule didn't save. Open the estimate again and retry." };
    // The circuit schedule renders on the printed quote — regenerating drops the stored copy (audit 7).
    await bustDocPdf("quote", quoteId);
    revalidatePath(`/quotes/${quoteId}`);
    return { ok: true, circuits };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message?.includes("ANTHROPIC_API_KEY")
        ? "AI isn't available right now. Try again later."
        : `Circuit schedule failed: ${e?.message ?? "unknown error"}`,
    };
  }
}

/** Save a hand-edited circuit schedule (the office corrects the generated one). Empty → clears it. */
export async function saveCircuitSchedule(
  quoteId: string,
  circuits: QuoteCircuit[],
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const clean = (Array.isArray(circuits) ? circuits : [])
    .map((r) => ({
      ckt: r.ckt ? String(r.ckt).trim() : null,
      description: String(r.description ?? "").trim(),
      wire: r.wire ? String(r.wire).trim() : null,
      breaker: r.breaker ? String(r.breaker).trim() : null,
      load: r.load ? String(r.load).trim() : null,
    }))
    .filter((r) => r.description || r.ckt || r.breaker || r.wire);
  const { data: wrote, error } = await ctx.supabase
    .from("quotes")
    .update({ circuits: clean.length ? clean : null })
    .eq("id", quoteId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "The circuit schedule didn't save. Open the estimate again and retry." };
  // The schedule prints as the second page — a hand correction has to bust the stored PDF just
  // like generating one does, or the share link keeps handing out the old panel (audit v921).
  await bustDocPdf("quote", quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  return { ok: true };
}
