"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { createNotifications } from "@/lib/notifications";
import { revalidatePath } from "next/cache";
import { reportError } from "@/lib/observe";
import { estimateLines, syncJobTasks } from "@/lib/estimate/sync-job-tasks";
import { materialsWords, syncJobMaterials } from "@/lib/estimate/sync-job-materials";
import { supersedeRevised } from "@/lib/estimate/revision";
import { FINISH_WINDOW_MS } from "@/lib/estimate/finish-window";
import { workOrderFromQuote } from "@/lib/estimate/work-order-from-quote";
import { takeOffFromQuote, takeOffWords } from "@/lib/estimate/take-off-from-quote";
import { closeVisitsBehindQuote } from "@/lib/appointments/behind-quote";

/**
 * Ping office staff that a customer accepted a quote: called by acceptPublicQuote AFTER
 * accept_public_quote succeeded and the finish ran. Reads the real quote by its unguessable share
 * token and only fires when it is actually accepted — so it can't be used to send arbitrary
 * notifications. NOT EXPORTED (skeptic #39, S4): exported from a "use server" file it was a server
 * action of its own, and anyone holding the link could POST it to re-ring the bell inside the
 * two-minute window. The one door is acceptPublicQuote.
 */
async function notifyQuoteAccepted(token: string, /** What the crew's list did on this acceptance (takeOffWords), when it did anything. */ said: string | null = null): Promise<void> {
  try {
    if (!token) return;
    const sb = createServiceClient();
    const { data: q } = await sb
      .from("quotes")
      .select("id, quote_number, status, org_id, accepted_at, job_id, customers(name)")
      .eq("public_token", token)
      .maybeSingle();
    if (!q || q.status !== "accepted" || !q.org_id) return;
    // Only push within 2 min of the actual acceptance — bounds replay of this hook
    // to a real, fresh acceptance (matches the inquiry hook's freshness guard).
    if (!q.accepted_at || Date.now() - new Date(q.accepted_at).getTime() > 120_000) return;

    const name = (q as any).customers?.name;
    const who = name ? ` from ${name}` : "";
    const jobId = (q as { job_id?: string }).job_id;
    const staff = await orgStaffIds(q.org_id);
    const payload = {
      title: "Estimate accepted",
      body: `${q.quote_number || "An estimate"} was accepted${who} — schedule the job.${said ? ` ${said}` : ""}`,
      // Deep-link straight to the job so "schedule it right there" is one tap.
      url: jobId ? `/jobs/${jobId}` : "/quotes",
    };
    await createNotifications(q.org_id, staff, { type: "quote_accepted", ...payload }); // the bell
    await sendPushToProfiles(staff, "quote_accepted", payload); // + push if enabled
  } catch {
    /* best-effort */
  }
}

/* How long after the customer's tap the finishing call is honoured: FINISH_WINDOW_MS, in
   lib/estimate/finish-window — a "use server" file exports only async functions. */

/**
 * FINISH WHAT THE CUSTOMER'S ACCEPT STARTED (W3, cn-v1075). accept_public_quote (SQL, 0369) makes
 * the job and nothing else, while the office's accept (createJobFromQuote) also births the job's
 * tasks, its work order and its materials take-off, and closes the visit behind the estimate. Two
 * doors, one thing: this runs the same rules behind the public door, with the service client and the
 * company's own id, so a job is the same job whichever door it came through. Internal since cn-v1133:
 * acceptPublicQuote runs it AWAITED right after the RPC, in the one server call, so a closed tab
 * never leaves an empty job — and THEN rings the office with what the list did (the return).
 *
 * WHAT HOLDING THE LINK LETS YOU DO: nothing but this, once, soon. It reads the quote by its
 * unguessable token, does nothing unless the quote is accepted, has its job and was accepted within
 * FINISH_WINDOW_MS, and every piece is idempotent by key (tasks by source_key, one work order and
 * one list per quote). The window is what bounds a replay: without it the link could re-make a
 * work order or a list the office had deleted, months later. Two calls in the same instant are
 * settled by the database: tasks_job_source_key_uq (0358), work_orders_one_per_quote_uq and
 * material_lists_one_per_quote_uq (0388) refuse the second, and each rule reads that as "the other
 * door won".
 *
 * Best-effort and never silent: a piece that fails is reported to the ops sink; the job stands and
 * the office is rung regardless.
 */
async function finishPublicAcceptance(token: string): Promise<string | null> {
  /** The crew's list followed this acceptance (a revision's plain rows re-counted, removed, kept): the office hears it. */
  let listSaid: string | null = null;
  try {
    if (!token) return null;
    const sb = createServiceClient();
    const { data: q } = await sb
      .from("quotes")
      // inquiry_id and revises_quote_id (cn-v1133): the links the visit closer reads, as the office door does.
      .select("id, status, org_id, job_id, created_by, accepted_at, inquiry_id, revises_quote_id")
      .eq("public_token", token)
      .maybeSingle();
    if (!q || q.status !== "accepted" || !q.org_id || !q.job_id) return null;
    if (!q.accepted_at || Date.now() - new Date(q.accepted_at).getTime() > FINISH_WINDOW_MS) return null;
    const who = { orgId: q.org_id as string, userId: (q.created_by as string | null) ?? null };
    const jobId = q.job_id as string;
    // THE ONE RULE, not the bare birth (item 1, 2026-10-10): the customer may accept a REBUILT estimate
    // (walked back to sent, lines re-written with new ids) or a second estimate on the job — the rule
    // matches orphans by name, offsets a later estimate's order and lets the size follow. The status
    // has already flipped (accept_public_quote), so "the figure before this acceptance" is the job's
    // OTHER accepted estimates: none on a first birth, which is the birth's own rule (null → set).
    const before = await estimateLines(sb, { jobId, orgId: who.orgId, except: q.id });
    // A REVISION SUPERSEDES THE ESTIMATE IT REVISES (0391): after the figure before is read (the
    // original's hours are what the box held, so the size can follow), before the sync (so the job's
    // accepted estimates are one price for the work when its tasks and list are brought in step).
    const sup = await supersedeRevised(sb, { revisionId: q.id, orgId: who.orgId });
    if (sup.error) {
      // The original still counts as accepted: a sync now would double the job's tasks and hours. The
      // paperwork below is per estimate (safe); the office's Accept runs the sync when it retries.
      reportError("finishPublicAcceptance:supersede", new Error(sup.error), { quoteId: q.id, jobId });
    } else {
      const born = await syncJobTasks(sb, {
        jobId,
        orgId: who.orgId,
        createdBy: who.userId,
        // The figure before, whole and per task line (0395): a task still holding what its line said on
        // the job's other accepted estimates follows that line, the same rule the office's Accept hands through.
        sizeBefore: before.error ? undefined : before.minutes,
        tasksBefore: before.error ? undefined : before.taskMinutes,
      });
      if (born.error) reportError("finishPublicAcceptance:tasks", new Error(born.error), { quoteId: q.id, jobId });
    }
    const wo = await workOrderFromQuote(sb, { quoteId: q.id, orgId: who.orgId, userId: who.userId });
    if (!wo.ok) reportError("finishPublicAcceptance:workOrder", new Error(wo.error ?? "refused"), { quoteId: q.id, jobId });
    const list = await takeOffFromQuote(sb, { quoteId: q.id, orgId: who.orgId, userId: who.userId });
    if (!list.ok) reportError("finishPublicAcceptance:materials", new Error(list.error ?? "refused"), { quoteId: q.id, jobId });
    else listSaid = takeOffWords(list); // the first destructive write on this door: never silent
    // A rebuilt or second estimate accepted through the link: its list follows its lines (0390) — on a
    // first birth the take-off just wrote every keyed row and this changes nothing. Each part's count
    // before (cn-v1133) is the job's other accepted estimates', as the tasks' figure is.
    if (!sup.error) {
      const mats = await syncJobMaterials(sb, { jobId, orgId: who.orgId, userId: who.userId, partsBefore: before.error ? undefined : before.partCounts });
      if (mats.error) reportError("finishPublicAcceptance:materialsSync", new Error(mats.error), { quoteId: q.id, jobId });
      else {
        // What the list did on the link — a row re-counted, renamed, matched, kept — reaches the office in
        // the bell's body, in the office door's own words (materialsWords, as jobFollows says them). It
        // used to be discarded here, so a moved or renamed row was silent (skeptic #39, S5).
        const said = materialsWords(mats);
        if (said) listSaid = listSaid ? `${listSaid} ${said}` : said;
      }
    }
    // THE VISIT BEHIND THIS ESTIMATE IS WON, AND ATTACHED TO THE JOB (cn-v1069 on the office door; parity
    // cn-v1133): the inspection the estimate was written up from read "still open business" after the
    // customer's own Accept. Best-effort, as on the office door: a lost write is reported, the job stands.
    // The service client is not fenced by RLS, so the company's id scopes its read and writes (S6).
    const closed = await closeVisitsBehindQuote(sb, { id: q.id, inquiry_id: (q.inquiry_id as string | null) ?? null, job_id: jobId, revises_quote_id: (q.revises_quote_id as string | null) ?? null }, { jobId, outcome: "won", orgId: who.orgId });
    if (closed.error) reportError("finishPublicAcceptance:visits", new Error(closed.error), { quoteId: q.id, jobId });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/work-orders");
    revalidatePath("/materials");
  } catch (e) {
    reportError("finishPublicAcceptance", e);
  }
  return listSaid;
}

/**
 * THE CUSTOMER'S ACCEPT, IN ONE SERVER CALL (cn-v1133). The button used to run the RPC from the
 * customer's browser and fire the finish without waiting — a closed tab left a job with no tasks, no
 * work order and no list. Now: (1) accept_public_quote, through the same cookie-bound server client
 * the token page reads public_quote with (the RPC is keyed by the unguessable token, so the anon
 * client is right); (2) the finish, AWAITED; (3) the office rung, with what the list did. The
 * acceptance is COMMITTED by the RPC whatever follows: a finish that fails is filed (reportError
 * inside it) and the customer still sees "accepted" — the office's Accept catches the job up.
 * The refusal words are the button's own (unchanged).
 */
export async function acceptPublicQuote(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!token) return { ok: false, error: "Could not accept. Please try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_public_quote", { p_token: token });
  const answer = (data ?? null) as { ok?: boolean; error?: string } | null;
  if (error || !answer?.ok) return { ok: false, error: error?.message ?? answer?.error ?? "Could not accept. Please try again." };
  let listSaid: string | null = null;
  try {
    listSaid = await finishPublicAcceptance(token);
  } catch (e) {
    reportError("acceptPublicQuote:finish", e); // the finish catches its own; this is the belt to its braces
  }
  // The office hears either way (its own guards: accepted, within two minutes of the tap).
  await notifyQuoteAccepted(token, listSaid);
  return { ok: true };
}
