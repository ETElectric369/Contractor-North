"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMember, requireStaff } from "@/lib/staff-guard";
import { createClient } from "@/lib/supabase/server";
import { translator } from "@/lib/i18n";
import { callerLang } from "@/lib/lang-of";
import { dbError } from "@/lib/db-error";
import { isMissingShelfRpc, shelfForCrew, takeFromStock, undoTake } from "@/lib/stock-ledger";
import { createNotifications, officeRecipients } from "@/lib/notifications";
import { sendPushToProfiles } from "@/lib/push";
import { reportError } from "@/lib/observe";
import { jobLabel } from "@/lib/schedule-options";
import { officeBellOpensShelf, officeBellWords, settleRefusalWords, tookWords, type ShelfRow } from "@/lib/stock-take";

/**
 * TOOK FROM STOCK: THE SERVER DOORS (Shop Stock, Phase 3).
 *
 * ONE VERB FOR EVERYONE (Erik's decision 3): a tech's take counts on the job right away, the office
 * gets a bell, and Undo holds until an invoice bills it. The crew and the office go through the
 * SAME door, and the database decides the rest: stock_draw (0303) is the only way pieces leave the
 * shelf, stamps the cost itself, and hands a tech a count, never a cost.
 *
 * NO MONEY IN, NO MONEY OUT. The input is an item, a job, a count and a note. A key this door does
 * not know (a cost, a price, an amount) is refused out loud, not quietly dropped: a caller that
 * thinks it can price a take has misunderstood the door. The answer carries counts only, for the
 * office too; the office reads what a take cost on Shop Stock and in the job's money.
 */

const TAKE = z
  .object({
    itemId: z.string().uuid(),
    jobId: z.string().uuid(),
    qty: z.number().finite().gt(0).max(1_000_000),
    note: z.string().trim().max(200).nullable().optional(),
    /** The sheet was filled by Nort and a person tapped Take It (recorded as the source for the office). */
    via: z.enum(["sheet", "nort"]).optional(),
  })
  .strict();

const UUID = z.string().uuid();

/**
 * THE CALLER'S WORDS (cn-v1138): a refusal or an answer a person reads comes back in the language on
 * their profile. Read only where it is said, never on the hot path of a take: the member's own client
 * when the door has one, a fresh one before sign-in (a refusal before sign-in reads English when no
 * request is there to read from); English on any failure. The toast after Take It and the office's
 * bell keep lib/stock-take's words.
 */
async function wordsOf(sb?: Parameters<typeof callerLang>[0]): Promise<(key: string) => string> {
  try {
    return translator(await callerLang(sb ?? (await createClient())));
  } catch {
    return translator("en");
  }
}

export type TakeActionResult =
  | { ok: true; drawGroup: string; item: string; unit: string; qty: number; short: number; onHand: number; message: string }
  | { ok: false; error: string };

export type ShelfLoad = { ok: true; rows: ShelfRow[] } | { ok: false; error: string };

/** The shelf for the sheet: names, units and counts. The same read for the crew and the office. */
export async function loadShelf(): Promise<ShelfLoad> {
  const m = await requireMember();
  if ("error" in m) return { ok: false, error: m.error ?? (await wordsOf())("mt_signInAgainStock") };
  return shelfForCrew(m.supabase);
}

/** TAKE IT. One take, one draw group, one bell to the office when the crew took it. */
export async function takeFromStockAction(raw: unknown): Promise<TakeActionResult> {
  const parsed = TAKE.safeParse(raw);
  if (!parsed.success) {
    const t = await wordsOf();
    if (parsed.error.issues.some((i) => i.code === "unrecognized_keys")) return { ok: false, error: t("mt_noMoney") };
    const path = parsed.error.issues[0]?.path[0];
    if (path === "qty") return { ok: false, error: t("mt_sayHowMany") };
    if (path === "itemId") return { ok: false, error: t("mt_pickWhatYouTook") };
    if (path === "jobId") return { ok: false, error: t("mt_pickTheJob") };
    return { ok: false, error: t("mt_takeDidntRead") };
  }
  const input = parsed.data;
  const m = await requireMember();
  if ("error" in m) return { ok: false, error: m.error ?? (await wordsOf())("mt_signInAgainStock") };
  const { supabase, orgId, staff } = m;

  // The job is this company's, said here as well as in stock_draw (0173: a rule at one door is a
  // convention). Its label is the bell's and the toast's.
  const { data: job, error: jobErr } = await supabase.from("jobs").select("id, job_number, name").eq("id", input.jobId).eq("org_id", orgId).maybeSingle();
  if (jobErr) return { ok: false, error: dbError(jobErr) };
  if (!job) return { ok: false, error: (await wordsOf(supabase))("mt_jobNotInCompany") };
  const label = jobLabel(job as { job_number?: string | null; name?: string | null });

  const res = await takeFromStock({
    itemId: input.itemId,
    jobId: input.jobId,
    qty: Math.round(input.qty * 1000) / 1000,
    note: input.note ?? null,
    // The database records a tech's take as 'crew' whatever is sent; this only names the office's.
    source: staff ? (input.via === "nort" ? "nort" : "office") : "crew",
  });
  if (!res.ok) return { ok: false, error: isMissingShelfRpc({ message: res.error }) ? (await wordsOf(supabase))("mt_needsDbUpdate") : res.error };
  if (!res.drawGroup) return { ok: false, error: (await wordsOf(supabase))("mt_recordDidntSay") };

  revalidatePath("/materials/[id]", "page");

  // THE OFFICE HEARS ABOUT EVERY CREW TAKE, one bell and one push each (decision 3). The office's
  // own takes are its own news. After the answer: the chain is several round trips, and a man at
  // the truck waiting on the office's phone is exactly the lag the 60 mph law forbids. Everything it
  // needs is resolved here, in request scope.
  if (!staff) {
    const words = officeBellWords({ who: m.name, qty: res.qty, unit: res.unit, item: res.item, job: label, short: res.short, onHandAfter: res.onHand });
    // A short (this take's, or an older one the shelf below zero says is open) opens Shop Stock on
    // its item, where Settle From The Shelf is.
    const url = officeBellOpensShelf({ short: res.short, onHandAfter: res.onHand }) ? `/inventory?item=${input.itemId}` : `/jobs/${input.jobId}?tab=materials`;
    const actorId = m.userId;
    after(() => tellOfficeAboutTake(supabase, orgId, actorId, words, url, input.jobId));
  }

  return {
    ok: true,
    drawGroup: res.drawGroup,
    item: res.item,
    unit: res.unit,
    qty: res.qty,
    short: res.short,
    onHand: res.onHand,
    message: tookWords({ qty: res.qty, unit: res.unit, item: res.item, job: label, short: res.short, onHandAfter: res.onHand }),
  };
}

/** Never throws: the take is saved, and a bell must never unsave it. A dead bell is logged. */
async function tellOfficeAboutTake(
  supabase: { from: (t: string) => any },
  orgId: string,
  actorId: string,
  words: { title: string; body: string },
  url: string,
  jobId: string,
): Promise<void> {
  try {
    const office = await officeRecipients(supabase, actorId);
    if (!office.length) return;
    const wrote = await createNotifications(orgId, office, { type: "stock_taken", title: words.title, body: words.body, url });
    if (wrote) await sendPushToProfiles(office, "assigned", { title: words.title, body: words.body, url }).catch(() => {});
  } catch (e) {
    reportError("stock.tellOfficeAboutTake", e, { orgId, jobId });
  }
}

/** UNDO, until an invoice bills it. stock_undo refuses a billed take and names the invoice, and a
 *  tech may undo only his own; both refusals come back in the database's own words. */
export async function undoTakeAction(drawGroup: string, jobId?: string | null): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!UUID.safeParse(drawGroup).success) return { ok: false, error: (await wordsOf())("mt_takeNotKnown") };
  const m = await requireMember();
  if ("error" in m) return { ok: false, error: m.error ?? (await wordsOf())("mt_signInAgainStock") };
  const res = await undoTake(drawGroup);
  if (!res.ok) return { ok: false, error: res.error };
  const t = await wordsOf(m.supabase);
  if (!res.undone) return { ok: false, error: t("mt_alreadyUndone") };
  if (jobId && UUID.safeParse(jobId).success) revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/materials/[id]", "page");
  return { ok: true, message: t("mt_undone") };
}

/**
 * SETTLE PIECES TAKEN PAST THE SHELF, once a roll is on it (the office's answer to a Settle item).
 * settle_short writes real draws at the roll's cost, all or nothing; until then the short costs $0
 * and bills nothing.
 */
export async function settleShortAction(shortId: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!UUID.safeParse(shortId).success) return { ok: false, error: (await wordsOf())("mt_takeNotOnRecord") };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? (await wordsOf())("mt_officeOnly") };
  const { supabase, orgId } = ctx;
  const t = await wordsOf(supabase);
  if (!orgId) return { ok: false, error: t("mt_noCompany") };
  const { data, error } = await supabase.rpc("settle_short", { p_short: shortId });
  if (error) return { ok: false, error: settleRefusalWords(dbError(error)) };
  if (!(data as { draw_group?: unknown } | null)?.draw_group) return { ok: false, error: t("mt_recordDidntSettle") };
  revalidatePath("/inventory");
  revalidatePath("/jobs/[id]", "page");
  return { ok: true, message: t("mt_settled") };
}
