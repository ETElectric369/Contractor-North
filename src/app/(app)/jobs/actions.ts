"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { pushCalendarItem, deleteCalendarItem } from "@/lib/calendar-sync";
import { JOB_STATUSES } from "@/lib/job-status";
import { DRAW_KINDS } from "@/lib/invoice-math";
import { emptyToNull } from "@/lib/forms";
import { notifyJobCrewAdded } from "@/lib/crew-notify";
import { visibleJobIdOrNull, visiblePoIdOnJobOrNull, visibleTemplateIdOrNull } from "@/lib/job-visibility";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { customerMaterialMarkupForJob } from "@/lib/labor-billing";
import { reportError } from "@/lib/observe";
import { escapeLike } from "@/lib/utils";
import { shouldImportActuals } from "@/lib/invoice-import-rule";
import { revalidateMoney } from "@/lib/revalidate-money";
import { claimedSourcesOnJob, unbilledWorkForJob } from "@/lib/unbilled-work";
import { changeOrderLines, type ChangeOrderRow } from "@/lib/change-order-billing";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createInvoiceFromQuote,
  createBlankInvoice,
  importLaborIntoInvoice,
  importCostsIntoInvoice,
  importChangeOrdersIntoInvoice,
  emailInvoice,
} from "../billing/actions";

export type Result = { ok: boolean; error?: string };

/** What the callers of createInvoiceForJob get back. `importWarning` is misnamed by history —
 *  it is THE note the caller must put in front of the user (an info toast before the redirect),
 *  whether it says "opened the draft you already started" or "labor couldn't be pulled in". */
export type CreateInvoiceForJobResult = {
  ok: boolean;
  error?: string;
  id?: string;
  importWarning?: string;
  /** true when `importWarning` reports something that did NOT happen (an import failed, a shell
   *  couldn't be dropped) — the "heads up" kind — as opposed to a plain statement of what did
   *  ("Opened the draft you already started", "Started INV-062 for what's new"). Nort's read-back
   *  and the toasts key their tone on this, not on the sentence. */
  partial?: true;
  /** Set on the "nothing new to bill" refusal: the invoice that already carries every hour and
   *  bill on the job, so the caller can offer the door that works ("Open INV-0xx"). */
  billedOn?: { id: string; number: string };
  /** The refusal was "nothing new to bill" — not a failure. finishJob treats it as success
   *  (the ordinary invoice → paid → finish rhythm); every other ok:false is a real failure. */
  nothingNew?: true;
};

/**
 * THE FULL UNBILLED PICTURE, READ BEFORE A NUMBER IS MINTED. The second invoice on a job exists
 * only to carry what is new since the last one; deciding that AFTER minting meant a shell got a
 * number, imported nothing, and was deleted — burning INV-063 so the next real invoice read
 * INV-064 with a gap the bookkeeper has to explain. The question is asked of the same arithmetic
 * the importers run (unbilledWorkForJob: labor lines over the unclaimed rows, materials over the
 * unclaimed bills and live POs; changeOrderLines over the unclaimed approved change orders), so
 * this answer and the draft that would have been built from it cannot disagree.
 *
 * It is the WHOLE picture, whatever the caller asked to import. The first cut read only the parts
 * the caller's importLabor / importCosts toggles were on, so Finish Job with both toggles off on
 * a T&M job with five new hours answered "nothing new to bill" — a sentence that was false, and
 * that the Overview card's own running total contradicted on the same screen. The toggles decide
 * only what gets PULLED IN (createInvoiceForJob); what they leave off is named, never denied.
 *
 * A read failure answers "not sure" (null): minting is then guarded by the post-import empty
 * check, which only costs a number — refusing on a hiccup would cost the office its invoice.
 */
type UnbilledPicture = {
  /** Unclaimed labor rows exist, and the hours they would bill. */
  labor: boolean;
  hours: number;
  /** Unclaimed bills / live orders exist, and how many. */
  costs: boolean;
  billsCount: number;
  /** Approved change orders no non-void invoice holds — read only for a quoted job. */
  changeOrders: number;
};
async function unbilledPicture(supabase: SupabaseClient, jobId: string, want: { changeOrders: boolean }): Promise<UnbilledPicture | null> {
  try {
    const [unbilled, cos] = await Promise.all([
      unbilledWorkForJob(supabase, jobId),
      want.changeOrders ? unclaimedChangeOrderLines(supabase, jobId) : 0,
    ]);
    return {
      labor: unbilled.laborByPerson.length > 0,
      hours: unbilled.hours,
      costs: unbilled.billsCount > 0,
      billsCount: unbilled.billsCount,
      changeOrders: cos,
    };
  } catch (e) {
    reportError("createInvoiceForJob.unbilledPicture", e, { jobId });
    return null;
  }
}

/** The "nothing new to bill" refusal — one sentence, whichever check raised it. Names where the
 *  work already is and the door for anything else. */
function nothingNewRefusal(prior: { id: string }, priorLabel: string, quoted: boolean): CreateInvoiceForJobResult {
  return {
    ok: false,
    nothingNew: true,
    error: quoted
      ? `The contract on this job is already billed on ${priorLabel} and there are no approved change orders to add — nothing new to bill. To bill an extra, add a change order, or start a blank invoice from Billing.`
      : `Everything worked so far is already on ${priorLabel} — nothing new to bill. To bill something else (a referral, a fee), start a blank invoice from Billing.`,
    billedOn: { id: prior.id, number: priorLabel },
  };
}

type PulledIn = {
  /** What landed, per importer, in the office's nouns — "1 time entry", "2 bills". */
  parts: string[];
  count: number;
  /** Importers that FAILED (a DB error — never a "nothing to pull" no-op). */
  missed: string[];
};

/**
 * Run the importers a caller asked for into one draft and count what landed. ONE helper for both
 * doors — the draft just minted and the one already open — so they can't drift in what they pull
 * or how they say it. Each import is CAPTURED: a "nothing to pull" no-op (empty:true) is fine; a
 * real failure must NOT be swallowed — a field tech invoicing by voice can't see the screen, so a
 * silently empty invoice goes out under-billed. It is logged AND named to the caller.
 */
async function pullNewWorkInto(
  supabase: SupabaseClient,
  jobId: string,
  invoiceId: string,
  want: { labor: boolean; costs: boolean; changeOrders: boolean },
  markup: number,
): Promise<PulledIn> {
  const out: PulledIn = { parts: [], count: 0, missed: [] };
  type Outcome = { ok: boolean; empty?: boolean; error?: string; stats?: { pulled_in: number } };
  const fail = (e: unknown): Outcome => ({ ok: false, error: String((e as { message?: unknown })?.message ?? e), empty: false });
  const take = (r: Outcome, noun: [string, string], what: string, tag: string) => {
    if (r.ok) {
      // pulled_in counts SOURCE ROWS newly on the invoice (a refreshed line whose claims did not
      // change is not "pulled in") — the honest number, not the RPC's lines-touched.
      const n = r.stats?.pulled_in ?? 0;
      if (n > 0) out.parts.push(`${n} ${n === 1 ? noun[0] : noun[1]}`);
      out.count += n;
      return;
    }
    if (!r.empty) {
      reportError(`createInvoiceForJob.${tag}`, r.error, { jobId, invoiceId });
      out.missed.push(what);
    }
  };
  if (want.labor) take(await importLaborIntoInvoice(invoiceId).catch(fail), ["time entry", "time entries"], "labor", "labor");
  // ALWAYS pass the org markup — importing costs at markup 0 bills materials at cost.
  if (want.costs) take(await importCostsIntoInvoice(invoiceId, markup).catch(fail), ["bill", "bills"], "materials", "costs");
  if (want.changeOrders) take(await importChangeOrdersIntoInvoice(invoiceId).catch(fail), ["change order", "change orders"], "change orders", "changeOrders");
  revalidatePath(`/jobs/${jobId}`); // the Overview running total moves with the claims
  return out;
}

/** "INV-061 and INV-063" for any strings — the office's own list phrasing. */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const fmtHours = (h: number) => `${Math.round(h * 100) / 100} h`;

/** How many approved change orders would land on a new invoice — importChangeOrdersIntoInvoice's
 *  exact predicate (approved, unclaimed by another non-void invoice, non-zero via changeOrderLines). */
async function unclaimedChangeOrderLines(supabase: SupabaseClient, jobId: string): Promise<number> {
  const [{ data: cos, error }, claims] = await Promise.all([
    supabase.from("change_orders").select("id, co_number, description, amount").eq("job_id", jobId).eq("status", "approved"),
    claimedSourcesOnJob(supabase, jobId),
  ]);
  if (error) throw error; // a failed read is not an empty list — the caller answers "not sure"
  const free = ((cos ?? []) as ChangeOrderRow[]).filter((c) => !claims.owner.has(String(c.id)));
  return changeOrderLines(free).length;
}

/** Create an invoice for a job — from its quote if it has one, else blank — carrying only the
 *  work not already on another invoice. */
export async function createInvoiceForJob(
  jobId: string,
  opts: { importLabor?: boolean; importCosts?: boolean } = {},
): Promise<CreateInvoiceForJobResult> {
  // Defaults are decided AFTER we know whether this invoice came from a quote — see
  // fromQuote below. A quoted job is billed by its CONTRACT; auto-importing the actuals
  // on top of the copied quote lines double-bills it (audit 2026-07-20: a $20k quote +
  // 64 logged hours + a $6k PO shipped a $35.5k draft). An explicit `true` from a caller
  // that really wants T&M on top of a quote still works.
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // A scheduled (draw-billed) job bills through its milestone draws, not a standard invoice —
  // the mirror of setPaymentSchedule's guard, so the two billing paths can never mix (which
  // would corrupt the job's billing state).
  const { data: milestone } = await supabase
    .from("payment_milestones")
    .select("id")
    .eq("job_id", jobId)
    .limit(1)
    .maybeSingle();
  if (milestone)
    return { ok: false, error: "This job bills on a payment schedule — request the next draw from Billing instead." };

  // ONLY A DRAFT CAPTURES THE CLICK (85 Whitney, 2026-09-11). cn-v479 handed back the newest
  // non-void standard invoice whatever its status, so once INV-061 was PAID every "New Invoice"
  // opened that locked invoice with a note, and the 5 new hours and two CED bills logged since had
  // no door at all — "it kept referring to the old invoice". The invariant was never "one standard
  // invoice per job"; it is "never the same hour or bill twice", and that now lives on the ROW:
  // the importers skip anything already claimed by another non-void invoice, so a second invoice
  // is safe and carries exactly what is new. One open DRAFT per job is still the rule — a second
  // draft would race the first for the same unclaimed rows — and it is said out loud, so landing
  // on it never reads as "it made a new one".
  const { data: stdRows } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, quote_id")
    .eq("job_id", jobId)
    .eq("invoice_kind", "standard")
    .neq("status", "void")
    .order("created_at", { ascending: false });
  const standards = (stdRows ?? []) as { id: string; invoice_number: string | null; status: string; quote_id: string | null }[];
  const draft = standards.find((r) => r.status === "draft");
  // The newest invoice that already went out (sent / partial / paid / overdue). When one exists
  // this call mints the SECOND invoice — for what is new since — and a "nothing new" refusal
  // must name it, because "New Invoice does nothing" is the sentence that filed tonight's bug.
  const prior = standards.find((r) => r.status !== "draft") ?? null;
  const priorLabel = prior?.invoice_number ?? "an earlier invoice";

  // WHICH quote is the contract? A DECLINED or EXPIRED quote is not one — the customer
  // said no (or it lapsed) and the work, if it happened, is being billed T&M. Taking the
  // newest quote regardless of status meant a rejected bid still suppressed the actuals
  // import AND had its lines copied onto the invoice: the job would bill the price the
  // customer refused and none of the hours actually worked. An ACCEPTED quote wins over a
  // newer un-answered one, matching contractTotalFromQuotes' accepted-first rule.
  const { data: quoteRows } = await supabase
    .from("quotes")
    .select("id, status")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  const usableQuotes = ((quoteRows ?? []) as { id: string; status: string | null }[]).filter(
    (q) => q.status !== "declined" && q.status !== "expired",
  );
  const quote = usableQuotes.find((q) => q.status === "accepted") ?? usableQuotes[0] ?? null;

  // THE CONTRACT IS BILLED ONCE. createInvoiceFromQuote is idempotent per quote — asked again it
  // returns the quote's existing invoice, which after a send is the locked one we just stopped
  // landing on. So once the quote's invoice has gone out, the next invoice on this job starts
  // blank; what is new on a quoted job is its approved change orders (and actuals only when a
  // caller deliberately asks), never the quote lines a second time.
  const quoteBilled = !!quote && standards.some((r) => r.quote_id === quote.id);
  const fromQuote = !!quote && !quoteBilled;

  // THE contract-vs-actuals switch. FinishJobButton already initialised its toggles to
  // !hasQuote — this makes that rule structural, so the three entry points that pass no
  // opts (job Invoices tab "New invoice", /billing "Create Invoice →", and Nort's
  // job.invoice verb) can't double-bill a quoted job. It keys on whether the JOB is quoted,
  // not on which invoice this is: a quoted job's second invoice must not suddenly bill 64
  // logged hours on top of a signed price.
  const wantLabor = shouldImportActuals(!!quote, opts.importLabor);
  const wantCosts = shouldImportActuals(!!quote, opts.importCosts);
  // A quoted job's approved change orders ride onto its SECOND invoice (the contract is out, so
  // the money that is new is its extras — each keyed co:<id>, so one already on the first invoice
  // is skipped, not re-billed). A T&M job is not touched here — there an approved change order
  // and the hours logged for the same work would double up, and the office decides that on the
  // invoice.
  const wantChangeOrders = !!prior && !!quote;
  // The customer's pricing-level markup when they have one, else the org default — the same seed
  // the manual "Materials from Costs" box uses, so a level customer can't be billed at the org
  // rate here and their negotiated rate there.
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const markup = await customerMaterialMarkupForJob(supabase, jobId, getOrgSettings((org as any)?.settings).material_markup_percent);

  if (draft) {
    // THE OPEN DRAFT TAKES WHAT'S NEW, TOO. The Overview card's "Create Invoice for $X" is priced
    // from the rows no non-void invoice claims — the draft's own lines included — so landing on the
    // draft WITHOUT pulling those rows in made the button a lie whenever a draft already existed
    // (the hours the card counted were nowhere on the document it opened). The importers skip every
    // row another non-void invoice holds and refresh this draft's own lines in place (0175/0255),
    // so running them here is exactly the New Invoice import, onto the document the office already
    // has open; the note says what landed. One open DRAFT per job is still the rule — a second
    // would race the first for the same unclaimed rows — and it is said out loud, so landing on it
    // never reads as "it made a new one".
    const label = draft.invoice_number ?? "the draft you already started";
    const pulled = await pullNewWorkInto(supabase, jobId, draft.id, { labor: wantLabor, costs: wantCosts, changeOrders: wantChangeOrders }, markup);
    if (pulled.missed.length) {
      return { ok: true, id: draft.id, partial: true, importWarning: `Opened ${label}, but ${joinAnd(pulled.missed)} couldn't be pulled in — review the line items before sending.` };
    }
    if (pulled.count > 0) {
      return { ok: true, id: draft.id, importWarning: `Opened ${label} and pulled in what's new — ${joinAnd(pulled.parts)}.` };
    }
    // Nothing landed — but "nothing new" is decided from the FULL picture, never from the parts
    // the caller asked for (toggles off) or the rows an edited line holds back. If work is still
    // unbilled, the sentence names it and the door that pulls it in; only a truly empty picture
    // says "nothing new".
    const still = await unbilledPicture(supabase, jobId, { changeOrders: wantChangeOrders });
    const stillOff: string[] = [];
    if (still && !quote && still.labor) stillOff.push(`${fmtHours(still.hours)} of time (Labor from Timecards pulls it in)`);
    if (still && !quote && still.costs) stillOff.push(`${still.billsCount} ${still.billsCount === 1 ? "bill" : "bills"} (Materials from Costs pulls ${still.billsCount === 1 ? "it" : "them"} in)`);
    if (still && quote && still.changeOrders > 0) stillOff.push(`${still.changeOrders} approved change ${still.changeOrders === 1 ? "order" : "orders"} (Change Orders pulls ${still.changeOrders === 1 ? "it" : "them"} in)`);
    return {
      ok: true,
      id: draft.id,
      importWarning: stillOff.length
        ? `Opened ${label} — still unbilled on this job: ${joinAnd(stillOff)}.`
        : `Opened ${label} — nothing new to pull in since.`,
    };
  }

  // THE SECOND INVOICE CARRIES WHAT IS NEW — and "nothing new" is decided from the FULL picture,
  // not from the parts the caller asked to import. (The first invoice may start empty on purpose;
  // a quote's invoice always carries the quote lines; neither is asked.) On a quoted job the logged
  // actuals are the contract's, not extras — they count only when a caller deliberately asks for
  // them (the Overview card makes the same call: it doesn't exist on a quoted job) — so there the
  // picture is the approved change orders. The refusal names where the work already is and the
  // door for anything else.
  const picture = prior && !fromQuote ? await unbilledPicture(supabase, jobId, { changeOrders: !!quote }) : null;
  if (prior && picture) {
    const laborNew = picture.labor && (!quote || wantLabor);
    const costsNew = picture.costs && (!quote || wantCosts);
    if (!laborNew && !costsNew && picture.changeOrders === 0) return nothingNewRefusal(prior, priorLabel, !!quote);
  }
  // Work the caller deliberately left off (Finish Job's toggles) is NOT "nothing new": the draft
  // is still minted — blank, or with the rest — and the note names what stayed unbilled and the
  // button on the invoice that pulls it in. Never a refusal that contradicts the Overview card.
  const leftOff: string[] = [];
  if (picture && !quote && picture.labor && !wantLabor) leftOff.push(`${fmtHours(picture.hours)} of time (Labor from Timecards pulls it in)`);
  if (picture && !quote && picture.costs && !wantCosts) {
    leftOff.push(`${picture.billsCount} ${picture.billsCount === 1 ? "bill" : "bills"} (Materials from Costs pulls ${picture.billsCount === 1 ? "it" : "them"} in)`);
  }

  let res: { ok: boolean; error?: string; id?: string };
  if (fromQuote && quote) {
    res = await createInvoiceFromQuote(quote.id);
  } else {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id, name, description")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return { ok: false, error: "Job not found." }; // L4: never persist a dangling/cross-org job_id
    res = await createBlankInvoice({
      customer_id: job.customer_id ?? null,
      job_id: jobId, // keep the job link so the invoice can pull Labor/Materials
      title: job.name ?? "",
      description: (job as any)?.description ?? null, // scope shown above the line items
      tax_rate: 0,
    });
  }

  // Pre-fill the draft from the job's logged LABOR (hours × rate) + MATERIALS (POs/bills,
  // marked up), best-effort — both importers no-op cleanly when there's nothing to pull.
  // THIS is the fix for "Create invoice lands on an empty draft" — so you can invoice
  // straight from the field instead of having to be back at a desk with the data entered.
  if (res.ok && res.id) {
    const pulled = await pullNewWorkInto(supabase, jobId, res.id, { labor: wantLabor, costs: wantCosts, changeOrders: wantChangeOrders }, markup);
    if (pulled.missed.length) {
      return { ...res, partial: true, importWarning: `Invoice created, but ${joinAnd(pulled.missed)} couldn't be pulled in — review the line items before sending.` };
    }
    if (prior) {
      const { data: made } = await supabase
        .from("invoices")
        .select("invoice_number, invoice_items(id)")
        .eq("id", res.id)
        .maybeSingle();
      const landed = ((made as { invoice_items?: { id: string }[] } | null)?.invoice_items ?? []).length;
      const newNumber = (made as { invoice_number?: string | null } | null)?.invoice_number ?? "a new invoice";
      // NEVER MINT AN EMPTY INVOICE SILENTLY. The first invoice on a job may start empty on purpose
      // (nothing logged yet, lines to be typed); the SECOND exists only to carry what is new, so
      // if the imports the caller ASKED FOR landed nothing, the honest answer is a refusal that
      // names where the work already is and the door for anything else — not a blank draft that
      // reads as "the app lost my hours". (Drift only: the picture above already refused the plain
      // case before a number was minted.) An invoice the caller asked to start EMPTY — every
      // import declined while the picture shows work — is not this: it is kept, and said.
      if (landed === 0 && !leftOff.length && (wantLabor || wantCosts || wantChangeOrders)) {
        // Drop the shell — it has no lines and no payments yet, nothing references it. Silent-write
        // law: a delete that hits zero rows is a 204, so check it landed; if it didn't, the draft
        // stays and is SAID so (the next "New Invoice" opens it), never a quiet leftover.
        const { data: gone, error: dropErr } = await supabase.from("invoices").delete().eq("id", res.id).select("id");
        if (dropErr || !gone?.length) {
          reportError("createInvoiceForJob.dropEmpty", dropErr?.message ?? "zero rows deleted", { jobId, invoiceId: res.id });
          return { ...res, partial: true, importWarning: `Nothing new since ${priorLabel} — this invoice starts empty.` };
        }
        revalidateMoney();
        revalidatePath(`/jobs/${jobId}`);
        return nothingNewRefusal(prior, priorLabel, !!quote);
      }
      if (landed === 0) {
        // Blank on purpose. The work the caller left off is named with its door, so the empty
        // draft can never read as "nothing new" while the Overview card shows a figure.
        return {
          ...res,
          importWarning: leftOff.length
            ? `Started ${newNumber} empty, as asked — still unbilled since ${priorLabel}: ${joinAnd(leftOff)}.`
            : `Started ${newNumber} empty, as asked.`,
        };
      }
      return {
        ...res,
        importWarning:
          `Started ${newNumber} for what's new since ${priorLabel} — ${landed} ${landed === 1 ? "line" : "lines"} pulled in.` +
          (leftOff.length ? ` Left off, as asked: ${joinAnd(leftOff)}.` : ""),
      };
    }
  }
  return res;
}

/** Set a job's status (partial — keeps everything else). For voice: "mark the Miller job on
 *  hold / in progress". Org-scoped by RLS (a cross-org id is a clean no-op). */
export async function setJobStatus(
  id: string,
  status: string,
  /** Why it's parked — only read for on_hold. A hold without a reason is a shrug (0234). */
  reason?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!(JOB_STATUSES as readonly string[]).includes(status)) return { ok: false, error: `Status must be one of: ${JOB_STATUSES.join(", ")}.` };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  /* A HOLD ALWAYS CARRIES ITS WHY (audit v921). Both dropdowns ask before parking (0234), but this
     writer took on_hold from anyone — the assistant included — and wrote the word alone, leaving
     hold_reason NULL. J-013 is sitting in production exactly like that: "On hold" on the job page,
     on the rail and on My Day, with nothing to act on, which is the dead end 0234 was written to
     prevent. So a park needs a reason: the one passed here, or one the job already carries. */
  const holdReason = String(reason ?? "").trim();
  if (status === "on_hold" && !holdReason) {
    const { data: cur } = await supabase.from("jobs").select("hold_reason").eq("id", id).maybeSingle();
    if (!String((cur as { hold_reason?: string | null } | null)?.hold_reason ?? "").trim())
      return { ok: false, error: "Say why it's on hold — open the job and pick On hold; it asks for the reason." };
  }
  // The hold reason lives and dies WITH the hold (0234): any status that isn't on_hold clears it,
  // whichever control moved the status — a stale "waiting on the permit" on an active job is a
  // false alarm every reader would believe.
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status,
      ...(status !== "on_hold" ? { hold_reason: null } : holdReason ? { hold_reason: holdReason } : {}),
    })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data || !data.length) return { ok: false, error: "Job not found." };
  // Google reconcile (fire-safe): leaving the active set deletes the event,
  // re-activating a scheduled job re-pushes it.
  await pushCalendarItem("job", id);
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/schedule"); // and on/off the calendar (the deleted schedule copy did this)
  return { ok: true };
}

export type FinishJobResult = {
  ok: boolean;
  error?: string;
  /** The invoice to land on: the draft just built, the job's latest draw, or — when there was
   *  nothing new to bill — the invoice that already carries the work. */
  id?: string;
  sent?: boolean;
  /** What actually happened, in one sentence. Named `speak` because it is the field the action
   *  registry relays verbatim (Nort's job.finish returns this object as-is, and the chat route's
   *  projection keeps `speak`); the button shows the same sentence. Set on every success. */
  speak?: string;
  /** A hard "it did NOT do all of what you asked" (an import failed): relayed by every surface. */
  warning?: string;
};

/**
 * Finish a job: mark it complete and put its billing in front of the office — a draft invoice
 * built from the quote when there is one (else the logged labor + materials, per the toggles),
 * the latest draw on a draw-billed job, or the invoice that already carries everything.
 *
 * "NOTHING NEW TO BILL" IS THE ORDINARY CASE, NOT A FAILURE. Erik's T&M rhythm is invoice →
 * paid on the spot → finish the job; createInvoiceForJob rightly refuses to mint a second,
 * empty invoice then (nothingNew), and forwarding that refusal made Manage → Finish Job and
 * Nort's job.finish unable to finish exactly the job that was done right. So the job is
 * completed, the caller is handed the invoice that holds the work, and the sentence says so.
 * Only a REAL failure (auth, a DB error, an import that broke) fails the finish.
 */
export async function finishJob(
  jobId: string,
  // importLabor/importCosts OPTIONAL: an unspecified flag lets createInvoiceForJob's
  // contract rule decide (quoted job → the quote IS the bill; T&M job → import the
  // actuals). FinishJobButton passes its explicit toggles; Nort passes neither.
  opts: { importLabor?: boolean; importCosts?: boolean; sendInvoice?: boolean },
): Promise<FinishJobResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // One place marks the job complete — checked (the silent-write law: a zero-row update on a
  // cross-org or deleted id is a 204, and "finished" would have been a lie).
  const complete = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { data, error } = await supabase.from("jobs").update({ status: "complete" }).eq("id", jobId).select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "Job not found." };
    await pushCalendarItem("job", jobId); // finished job leaves Google (fire-safe)
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
    revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
    revalidatePath("/billing");
    return { ok: true };
  };

  // A draw-billed job is finished with a Final draw, not a standard invoice. Mark it
  // complete without creating a conflicting standard invoice (H4), and hand back the
  // latest draw so the UI lands on the job's billing instead of a dead-end.
  const { data: draws } = await supabase
    .from("invoices")
    .select("id")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", [...DRAW_KINDS])
    .order("created_at", { ascending: false })
    .limit(1);
  if (draws && draws.length) {
    const done = await complete();
    if (!done.ok) return done;
    return { ok: true, id: draws[0].id, speak: "Job finished. It bills on a payment schedule — the Final draw is requested from Billing." };
  }

  // createInvoiceForJob does the imports (labor at rate, materials WITH org markup), honoring the
  // toggles. The old code re-imported here a SECOND time with markup 0, which deleted the marked-up
  // material lines and re-inserted them at raw cost — every finished-job invoice billed materials at
  // cost. That redundant second import is gone.
  const inv = await createInvoiceForJob(jobId, { importLabor: opts.importLabor, importCosts: opts.importCosts });
  if (!inv.ok && inv.nothingNew) {
    // Already fully billed (see the header) — finish, and hand back the invoice that holds it all.
    // Nothing is emailed: there is no new invoice to send, and the one that exists already went out.
    const done = await complete();
    if (!done.ok) return done;
    return {
      ok: true,
      id: inv.billedOn?.id,
      sent: false,
      speak: inv.billedOn
        ? `Job finished. Everything worked is already on ${inv.billedOn.number} — nothing new to bill.`
        : "Job finished. Nothing new to bill.",
    };
  }
  if (!inv.ok || !inv.id) return { ok: false, error: inv.error ?? "Could not create the invoice." };

  const done = await complete();
  if (!done.ok) return done;

  // Auto-invoice: when asked, email the draft to the customer now. Best-effort —
  // if they have no email (emailInvoice returns an error), the invoice simply stays
  // a draft and surfaces in the "To be invoiced" queue for manual review/send.
  let sent = false;
  if (opts.sendInvoice) {
    const mailed = await emailInvoice(inv.id);
    sent = mailed.ok;
  }

  return {
    ok: true,
    id: inv.id,
    sent,
    // Say what the invoice step actually did — "Opened the draft you already started" and
    // "Started INV-062 for what's new since INV-061" are facts, not warnings; a failed import is.
    speak: inv.importWarning && !inv.partial ? `Job finished. ${inv.importWarning}` : "Job finished — its draft invoice is ready to review.",
    ...(inv.partial && inv.importWarning ? { warning: inv.importWarning } : {}),
  };
}

export type DeleteJobResult = {
  ok: boolean;
  error?: string;
  /** The caller must show these to the user and call again with confirmDestructive. */
  needsConfirm?: boolean;
  /** Plain-English list of what deleting the job PERMANENTLY destroys. */
  destroys?: string[];
};

/**
 * Delete a job — with the linked-record guard deleteCustomer has always had.
 *
 * Deleting a job is not the tidy operation the old confirm dialog promised. Quotes,
 * invoices and time entries do survive (their job_id is ON DELETE SET NULL), but a dozen
 * child tables are ON DELETE CASCADE and vanish with no undo: the contract — including
 * signed_at / signed_name / signed_ip / signed_body, the frozen legal record the DB
 * otherwise makes immutable — the lien record with its served CA 20-day Preliminary
 * Notice, the insurance claim, the payment schedule, permits, change orders, and every
 * job photo. There is no soft delete and no backup surface, so a mis-tap on a duplicated
 * job was unrecoverable.
 *
 * Two tiers:
 *   HARD BLOCK on records that must never disappear on a mis-tap — a customer-SIGNED
 *   contract, or a lien record whose preliminary notice has actually been served (that
 *   notice is the basis of lien rights). Void the contract / clear the record first, or
 *   cancel the job instead of deleting it.
 *   ITEMIZED CONFIRM for everything else: the first call returns what would be destroyed
 *   so the dialog can name it, and only a second call with confirmDestructive proceeds.
 */
export async function deleteJob(
  id: string,
  opts: { confirmDestructive?: boolean } = {},
): Promise<DeleteJobResult> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const headCount = (table: string, apply?: (q: any) => any) => {
    const q = supabase.from(table).select("id", { count: "exact", head: true }).eq("job_id", id);
    return apply ? apply(q) : q;
  };
  const [
    { count: signedContracts },
    { count: liveContracts },
    { data: lien },
    { count: claims },
    { count: billedMilestones },
    { count: milestones },
    { count: docs },
    { count: permits },
    { count: changeOrders },
  ] = await Promise.all([
    headCount("contracts", (q: any) => q.eq("status", "signed")),
    headCount("contracts", (q: any) => q.in("status", ["draft", "sent"])),
    supabase.from("lien_records").select("prelim_sent_at").eq("job_id", id).maybeSingle(),
    headCount("insurance_claims"),
    headCount("payment_milestones", (q: any) => q.eq("status", "billed")),
    headCount("payment_milestones"),
    headCount("documents"),
    headCount("permits"),
    headCount("change_orders"),
  ]);

  // ── Tier 1: legal records that a delete must never be able to take with it ──
  const prelimServed = !!(lien as { prelim_sent_at: string | null } | null)?.prelim_sent_at;
  const blockers: string[] = [];
  if (signedContracts) blockers.push("a contract the customer has signed");
  if (prelimServed) blockers.push("a served preliminary notice (your lien rights)");
  if (billedMilestones) blockers.push(`${billedMilestones} already-billed payment milestone${billedMilestones > 1 ? "s" : ""}`);
  if (blockers.length) {
    return {
      ok: false,
      error:
        `This job has ${blockers.join(" and ")}. Deleting it would destroy that permanently, ` +
        `with no undo. Void or unlink those records first — or set the job to cancelled instead of deleting it.`,
    };
  }

  // ── Tier 2: name what really goes, then require a second, informed confirm ──
  const destroys: string[] = [];
  if (liveContracts) destroys.push(`${liveContracts} contract${liveContracts > 1 ? "s" : ""}`);
  if (lien) destroys.push("the lien / preliminary-notice record");
  if (claims) destroys.push(`${claims} insurance claim${claims > 1 ? "s" : ""}`);
  if (milestones) destroys.push(`${milestones} payment milestone${milestones > 1 ? "s" : ""}`);
  if (docs) destroys.push(`${docs} document${docs > 1 ? "s" : ""} / photo${docs > 1 ? "s" : ""}`);
  if (permits) destroys.push(`${permits} permit${permits > 1 ? "s" : ""}`);
  if (changeOrders) destroys.push(`${changeOrders} change order${changeOrders > 1 ? "s" : ""}`);
  if (destroys.length && !opts.confirmDestructive) {
    return {
      ok: false,
      needsConfirm: true,
      destroys,
      error: `Deleting this job also permanently deletes ${destroys.join(", ")}.`,
    };
  }

  // BEFORE the row goes (it reads google_event_id off the row). Fire-safe.
  await deleteCalendarItem("job", id);
  // THE STAMP FOLLOWS THE DEED, IN REVERSE (audit v800 — found four of these already orphaned
  // in production). /leads hides any inquiry with converted_at set, so a lead whose job is
  // deleted leaves the inbox FOREVER pointing at nothing. deleteQuote learned this; deleteJob
  // never did. Note the un-stamp must NOT filter on converted_to='quote' — convertInquiry
  // writes 'estimate' or 'job', so that filter is exactly why the quote-side guard missed these.
  const { data: victim } = await supabase.from("jobs").select("id, inquiry_id").eq("id", id).maybeSingle();
  const { error } = await supabase.from("jobs").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  const sourceLead = (victim as { inquiry_id?: string | null } | null)?.inquiry_id ?? null;
  if (sourceLead) {
    const [{ count: quotesLeft }, { count: jobsLeft }] = await Promise.all([
      supabase.from("quotes").select("id", { count: "exact", head: true }).eq("inquiry_id", sourceLead),
      supabase.from("jobs").select("id", { count: "exact", head: true }).eq("inquiry_id", sourceLead),
    ]);
    if (!quotesLeft && !jobsLeft) {
      await supabase
        .from("inquiries")
        // "new", not "open": INQUIRY_STATUSES is new/contacted/quoted/won/lost, and a lead
        // released back to the inbox is a fresh one again. "open" is not in that vocabulary and
        // rendered as an unknown chip (v800 verification).
        .update({ converted_to: null, converted_at: null, status: "new", updated_at: new Date().toISOString() })
        .eq("id", sourceLead)
        .not("converted_at", "is", null);
      revalidatePath("/leads");
    }
  }
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/schedule");
  return { ok: true };
}

/** Edit every job field in one place: details, address, schedule, customer
 *  (existing or created inline), and assigned staff. */
export async function updateJob(
  id: string,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Job name is required." };

  // Optionally create a customer inline (when none selected).
  let customerId = emptyToNull(formData.get("customer_id"));
  const newCustomerName = String(formData.get("new_customer_name") ?? "").trim();
  if (!customerId && newCustomerName) {
    const { data: cust, error: cErr } = await supabase
      .from("customers")
      .insert({
        name: newCustomerName,
        phone: emptyToNull(formData.get("new_customer_phone")),
        email: emptyToNull(formData.get("new_customer_email")),
        status: "active",
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  const start = String(formData.get("scheduled_start") ?? "");
  const end = String(formData.get("scheduled_end") ?? "");
  const assigned = formData.getAll("assigned_to").map(String).filter(Boolean);

  // Scope the template to the caller's org — a job can't reference another org's template.
  const codeTemplatePatch = formData.has("code_template_id")
    ? { code_template_id: await visibleTemplateIdOrNull(supabase, emptyToNull(formData.get("code_template_id")) as string | null) }
    : {};

  // Old crew first — this writer also changes assigned_to, so newly ADDED members
  // get the same bell + "assigned" push as setJobCrew (the shared diff helper).
  const { data: prevJob } = await supabase
    .from("jobs")
    .select("assigned_to, org_id, job_number")
    .eq("id", id)
    .maybeSingle();

  const { data: saved, error } = await supabase
    .from("jobs")
    .update({
      name,
      description: emptyToNull(formData.get("description")),
      customer_id: customerId,
      ...(formData.get("billing_type") != null ? { billing_type: String(formData.get("billing_type")) } : {}),
      ...codeTemplatePatch,
      address: emptyToNull(formData.get("address")),
      unit: emptyToNull(formData.get("unit")),
      city: emptyToNull(formData.get("city")),
      state: emptyToNull(formData.get("state")),
      zip: emptyToNull(formData.get("zip")),
      scheduled_start: start ? new Date(start).toISOString() : null,
      scheduled_end: end ? new Date(end).toISOString() : null,
      assigned_to: assigned,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    // THE SILENT-WRITE LAW (audit v921): a zero-row update is a 204, not an error — editing a job
    // that was deleted (or belongs to another org) answered "Saved" and wrote nothing.
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!saved?.length) return { ok: false, error: "That job isn't available." };

  if (prevJob) {
    const p = prevJob as { assigned_to: string[] | null; org_id: string | null; job_number: string | null };
    // Awaited (not `void`): serverless can drop an un-awaited promise after the action
    // returns. The helper never throws, so this can't break the job update.
    await notifyJobCrewAdded({ id, org_id: p.org_id, job_number: p.job_number, name }, p.assigned_to, assigned, ctx.userId);
  }

  // This writer touches name/address/schedule — keep Google current (fire-safe).
  await pushCalendarItem("job", id);

  revalidatePath(`/jobs/${id}`);
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/schedule");
  return { ok: true };
}

export async function createBill(input: {
  job_id: string | null; // null = company overhead (no job)
  supplier: string;
  bill_number: string;
  amount: number;
  status: string;
  bill_date: string | null;
  notes: string;
  category?: string | null;
  /** The purchase order this bill pays (migration 0142). Setting it makes the bill
   *  SUPERSEDE that PO in every material-cost sum, so one delivery entered as both a
   *  PO and the supplier's invoice is costed and billed ONCE, at the invoiced amount. */
  po_id?: string | null;
  /** The receipt document this bill was entered FROM (quick Add Cost with a file attached).
   *  Recording the link in organized_items is what makes the receipt-analyzer idempotent:
   *  a later "Record as cost" tap on that same file answers "already recorded" instead of
   *  creating a duplicate bill — the exact double-entry Erik hit on J-033. */
  receipt_document_id?: string | null;
}): Promise<Result & { id?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.supplier.trim()) return { ok: false, error: "Supplier is required." };

  // Drop a job_id the caller can't see (e.g. a crafted voice/registry call) — never
  // persist a cross-org job reference on a bill.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);
  // The PO link: keep it only when the PO is visible (RLS) AND on THIS bill's job — a bill
  // may only supersede a PO on its own job, or the supersede silently drops another job's
  // order from the cost rollup. A mismatched/foreign id is ignored (the bill still saves).
  const poId = await visiblePoIdOnJobOrNull(supabase, input.po_id ?? null, jobId);

  const { data: created, error } = await supabase
    .from("bills")
    .insert({
      job_id: jobId,
      po_id: poId,
      supplier: input.supplier.trim(),
      bill_number: input.bill_number.trim() || null,
      amount: input.amount || 0,
      status: input.status || "unpaid",
      bill_date: input.bill_date || null,
      notes: input.notes.trim() || null,
      category: input.category ?? null,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  // Best-effort receipt link (never fails the bill): only when the document is visible
  // via RLS AND on this bill's job — same containment rule as the po_id link above.
  if (input.receipt_document_id && created?.id) {
    const { data: doc } = await supabase
      .from("documents")
      .select("id, job_id, file_url")
      .eq("id", input.receipt_document_id)
      .maybeSingle();
    if (doc && doc.job_id === jobId) {
      await supabase.from("organized_items").insert({
        kind: "receipt",
        title: input.supplier.trim(),
        vendor: input.supplier.trim(),
        amount: input.amount || 0,
        item_date: input.bill_date || null,
        category: input.category ?? null,
        status: "filed",
        job_id: jobId,
        document_id: doc.id,
        bill_id: created.id,
        file_url: doc.file_url,
        created_by: ctx.userId,
      });
    }
  }

  if (input.job_id) revalidatePath(`/jobs/${input.job_id}`);
  revalidatePath("/bills");
  return { ok: true, id: created?.id };
}

/** Link an already-uploaded receipt document to an already-saved bill — the retry path.
 *  When the photo upload fails on the first save, the bill exists with NO link, so a later
 *  upload of that same receipt (retry button, or the job's Receipts tab) reads it as a fresh
 *  cost and files a SECOND bill for the same money — the Tao Zhu double-charge class. This
 *  writes the same organized_items link createBill would have, making the file answer
 *  "already recorded". Same containment rule: the document must be visible and on the bill's job. */
export async function linkReceiptToBill(billId: string, documentId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const [{ data: bill }, { data: doc }] = await Promise.all([
    supabase.from("bills").select("id, job_id, supplier, amount, bill_date, category").eq("id", billId).maybeSingle(),
    supabase.from("documents").select("id, job_id, file_url").eq("id", documentId).maybeSingle(),
  ]);
  if (!bill || !doc) return { ok: false, error: "Couldn't find that cost or receipt." };
  if (!bill.job_id || doc.job_id !== bill.job_id) return { ok: false, error: "That receipt isn't on this cost's job." };

  // Idempotent: a re-tap must not stack duplicate links.
  const { data: existing } = await supabase
    .from("organized_items")
    .select("id")
    .eq("document_id", doc.id)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true };

  const { error } = await supabase.from("organized_items").insert({
    kind: "receipt",
    title: bill.supplier ?? "Receipt",
    vendor: bill.supplier ?? null,
    amount: bill.amount ?? 0,
    item_date: bill.bill_date ?? null,
    category: bill.category ?? null,
    status: "filed",
    job_id: bill.job_id,
    document_id: doc.id,
    bill_id: bill.id,
    file_url: doc.file_url,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${bill.job_id}`);
  return { ok: true };
}

export async function updateBill(
  id: string,
  patch: {
    supplier?: string;
    bill_number?: string | null;
    amount?: number;
    status?: string;
    bill_date?: string | null;
    notes?: string | null;
    category?: string | null;
    job_id?: string | null;
    po_id?: string | null;
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (patch.supplier !== undefined) {
    if (!patch.supplier.trim()) return { ok: false, error: "Supplier is required." };
    clean.supplier = patch.supplier.trim();
  }
  if (patch.bill_number !== undefined) clean.bill_number = patch.bill_number?.trim() || null;
  if (patch.amount !== undefined) clean.amount = patch.amount || 0;
  if (patch.status !== undefined) clean.status = patch.status;
  if (patch.bill_date !== undefined) clean.bill_date = patch.bill_date || null;
  if (patch.notes !== undefined) clean.notes = patch.notes?.trim() || null;
  if (patch.category !== undefined) clean.category = patch.category ?? null;
  if (patch.job_id !== undefined) clean.job_id = patch.job_id || null;

  // One stored-row read of the bill's current job — feeds BOTH the old-job revalidation (a
  // re-pointed bill's cost must leave its old job) AND the PO same-job check below. Read
  // whenever either needs it: a job move, or a PO link on a bill whose job isn't changing.
  let oldJobId: string | null = null;
  if (patch.job_id !== undefined || (patch.po_id !== undefined && !!patch.po_id)) {
    const { data: prev } = await supabase.from("bills").select("job_id").eq("id", id).maybeSingle();
    oldJobId = (prev as { job_id: string | null } | null)?.job_id ?? null;
  }

  // Linking/unlinking the PO this bill pays MOVES money: a linked PO stops being counted
  // (the bill supersedes it), an unlinked one starts counting again. The bill may only
  // supersede a PO on ITS OWN job — a cross-job link would silently cancel a DIFFERENT
  // job's order — so scope the check to the bill's TARGET job (the just-changed job when
  // this update moves it, else its stored job). A mismatch is ignored (clears the link).
  if (patch.po_id !== undefined) {
    const targetJob = patch.job_id !== undefined ? patch.job_id || null : oldJobId;
    clean.po_id = await visiblePoIdOnJobOrNull(supabase, patch.po_id || null, targetJob);
  }

  const { data, error } = await supabase.from("bills").update(clean).eq("id", id).select("job_id").maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  for (const jid of new Set([oldJobId, (data as any)?.job_id].filter(Boolean) as string[])) revalidatePath(`/jobs/${jid}`);
  revalidatePath("/bills");
  revalidatePath("/analytics"); // bill cost moves job profitability
  return { ok: true };
}

export async function setBillStatus(
  id: string,
  status: string,
  jobId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("bills").update({ status }).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function deleteBill(id: string, jobId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("bills").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function updateJobNotes(
  jobId: string,
  notes: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // A ZERO-ROW UPDATE IS A 204 (the silent-write law). When RLS refuses the row — a job that
  // isn't this org's, or one deleted out from under the editor — Postgres answers "0 rows, no
  // error", and this used to return { ok: true } so the Notes tab flashed "Saved" over text that
  // never landed. Ask for the id back; an empty answer is the refusal it is.
  const { data, error } = await supabase
    .from("jobs")
    .update({ notes: notes.trim() || null })
    .eq("id", jobId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing saved — that job isn't here, or this login can't edit it." };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/** Inline-edit the job's description (scope) right on the Overview tab. */
export async function updateJobDescription(
  jobId: string,
  description: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Same zero-row rule as updateJobNotes: a refused write must not read as "Saved".
  const { data, error } = await supabase
    .from("jobs")
    .update({ description: description.trim() || null })
    .eq("id", jobId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing saved — that job isn't here, or this login can't edit it." };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function addDocument(input: {
  job_id: string;
  name: string;
  category: string;
  file_url: string; // storage path within the 'documents' bucket
  size_bytes: number;
}): Promise<Result & { id?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data, error } = await supabase
    .from("documents")
    .insert({
      job_id: input.job_id,
      name: input.name,
      category: input.category || "Receipt",
      kind: "other",
      file_url: input.file_url,
      size_bytes: input.size_bytes || null,
      uploaded_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath(`/jobs/${input.job_id}`);
  return { ok: true, id: data?.id };
}

/** Rename / re-categorize an already-uploaded document. Staff only; partial patch.
 *  RLS scopes the update to the caller's org, so a crafted id can't reach another
 *  org's document — mirrors updateBill's pattern. */
export async function updateDocument(
  id: string,
  patch: {
    name?: string;
    category?: string | null;
  },
  jobId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false, error: "Name is required." };
    clean.name = patch.name.trim();
  }
  if (patch.category !== undefined) clean.category = patch.category ?? null;

  const { error } = await supabase.from("documents").update(clean).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function deleteDocument(
  id: string,
  _path: string | null, // ignored: the file path comes from the ROW, never the caller (audit v921)
  jobId: string,
): Promise<Result> {
  const supabase = await createClient();
  // Read the row FIRST (RLS scopes it to the caller's org) so we delete the file it actually
  // points at, not a client path that could name another org's object; row-check the delete.
  const { data: row } = await supabase.from("documents").select("id, file_url").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "Document not found." };
  const storedPath = (row as { file_url?: string | null }).file_url ?? null;
  const { data: del, error } = await supabase.from("documents").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!del?.length) return { ok: false, error: "Document not found." };
  if (storedPath) await supabase.storage.from("documents").remove([storedPath]);
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export type JobImportRow = {
  customer: string;
  job_name: string;
  value?: number;
  status?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  email?: string;
  phone?: string;
};
export type JobImportResult = { name: string; status: "created" | "failed"; reason?: string };

/** Bulk-import jobs from a roster (migration importer): find-or-create the customer,
 *  create the job, and record its contract value as an ACCEPTED quote so the job's
 *  Contract / Invoiced / Paid math works. Staff only; best-effort per row. */
export async function importJobs(
  rows: JobImportRow[],
): Promise<{ ok: boolean; error?: string; results?: JobImportResult[] }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  const results: JobImportResult[] = [];
  for (const r of (rows ?? []).slice(0, 200)) {
    const cname = (r.customer || "").trim();
    const jobName = (r.job_name || "").trim() || cname;
    if (!cname && !jobName) {
      results.push({ name: "(blank)", status: "failed", reason: "Missing customer and job name." });
      continue;
    }

    // Find-or-create the customer (match by name, narrowed by email when given) — RLS
    // already scopes this to the caller's org.
    let customerId: string | null = null;
    if (cname) {
      const email = (r.email || "").trim().toLowerCase();
      let q = supabase.from("customers").select("id").ilike("name", escapeLike(cname)).limit(1);
      if (email) q = q.ilike("email", escapeLike(email));
      const { data: hit } = await q.maybeSingle();
      if (hit) customerId = hit.id;
      else {
        const { data: nc, error: ce } = await supabase
          .from("customers")
          .insert({
            name: cname,
            email: r.email?.trim() || null,
            phone: r.phone?.trim() || null,
            address: r.address?.trim() || null,
            city: r.city?.trim() || null,
            state: r.state?.trim() || null,
            zip: r.zip?.trim() || null,
            status: "active",
            created_by: userId,
          })
          .select("id")
          .single();
        if (ce) {
          results.push({ name: jobName, status: "failed", reason: ce.message });
          continue;
        }
        customerId = nc.id;
      }
    }

    // Legacy CSV statuses from the old lifecycle: an "estimate" row is a job waiting to be
    // scheduled; an "invoiced" row is finished work (money owed lives in AR, not job status).
    // Anything else off-spine imports as in_progress.
    const rawStatus = (r.status || "").trim();
    const mapped = rawStatus === "estimate" ? "to_be_scheduled" : rawStatus === "invoiced" ? "complete" : rawStatus;
    const status = (JOB_STATUSES as readonly string[]).includes(mapped) ? mapped : "in_progress";
    const { data: job, error: je } = await supabase
      .from("jobs")
      .insert({
        name: jobName,
        customer_id: customerId,
        status,
        address: r.address?.trim() || null,
        city: r.city?.trim() || null,
        state: r.state?.trim() || null,
        zip: r.zip?.trim() || null,
        created_by: userId,
      })
      .select("id, job_number")
      .single();
    if (je) {
      results.push({ name: jobName, status: "failed", reason: je.message });
      continue;
    }

    // Contract value -> accepted quote + a single line item.
    const value = Number(r.value) || 0;
    let valueNote = "";
    if (value > 0) {
      const { data: quote, error: qe } = await supabase
        .from("quotes")
        .insert({
          job_id: job.id,
          customer_id: customerId,
          status: "accepted",
          title: "Imported contract",
          subtotal: value,
          tax: 0,
          total: value,
          created_by: userId,
        })
        .select("id")
        .single();
      if (quote) {
        await supabase
          .from("quote_line_items")
          .insert({ quote_id: quote.id, description: jobName || "Contract", quantity: 1, unit: "ea", unit_price: value, sort_order: 0 });
      } else if (qe) {
        // Job was created but the contract value didn't attach — flag it instead of
        // silently dropping the money.
        valueNote = " — value not saved, add it manually";
      }
    }
    results.push({ name: `${job.job_number} · ${jobName}${valueNote}`, status: "created" });
  }
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/crm");
  return { ok: true, results };
}
