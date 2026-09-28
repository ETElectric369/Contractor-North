import { checkComeBackDay } from "@/lib/come-back-days";
import { dbError } from "@/lib/db-error";
import type { ActionItem, WaitingItem } from "./types";
import { waitingRow } from "./types";

/**
 * ENDLESS ROWS GET A SNOOZE (Erik, 2026-09-27, "yes to all", answer 5; migration 0367).
 *
 * Some Needs You rows have no day of their own and no honest ending: No Costs Yet on a labor-only
 * job (it never will have costs), To Buy while a part is back-ordered (nobody can buy it this week).
 * They sat on the list every morning with nothing to do about them, which is what made My Day a
 * pile Erik stopped opening. Such a row gets a Snooze that picks a day: it then waits in the Waiting
 * fold with that day and its reason, and comes back on it.
 *
 * The day lives in ONE small table, public.needs_you_waits (0367): one row per (company, item_key),
 * item_key being the row's stable key as the build makes it (waitKey). A wait whose day has come is
 * ignored (the row is back), and one whose row is gone matches nothing and is never drawn; each save
 * clears the company's waits whose day has passed. No "No Date": every wait has one.
 *
 * THE CODE SHIPS BEFORE 0367 IS RUN. Until then the read answers "not ready": no Snooze door on any
 * row and no error anywhere, exactly the list of the day before.
 */

/** The kinds whose rows can be snoozed this way: the endless ones. */
export const WAITABLE_KINDS = ["job_unbilled_work", "materials_needed"] as const;
export type WaitableKind = (typeof WAITABLE_KINDS)[number];

export function isWaitableKind(kind: unknown): kind is WaitableKind {
  return typeof kind === "string" && (WAITABLE_KINDS as readonly string[]).includes(kind);
}

/** The row's stable key: its kind and the record it is about ("materials_needed:<job id>"). */
export function waitKey(kind: WaitableKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

/** Postgres undefined_table (42P01) or PostgREST's "not in the schema cache" (PGRST205): 0367 isn't run. */
export function isMissingWaitsTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? "");
  if (code === "42P01" || code === "PGRST205") return true;
  return /needs_you_waits/.test(String(e?.message ?? "")) && /does not exist|could not find/i.test(String(e?.message ?? ""));
}

export type NeedsYouWaits = {
  /** The table is there: a Snooze door may be drawn. */
  ready: boolean;
  /** item_key → the day it comes back and why, for waits whose day hasn't come. */
  waits: Map<string, { until: string; reason: string | null }>;
};

/**
 * This company's waits whose day is after today. `ready` false when the table isn't there (0367 not
 * run) or the read failed: then no row offers a Snooze and nothing folds (a failed read never hides
 * a row). Org-filtered by hand as well as by its policy.
 */
export async function readNeedsYouWaits(supabase: any, orgId: string | null, todayStr: string): Promise<NeedsYouWaits> {
  const none: NeedsYouWaits = { ready: false, waits: new Map() };
  if (!orgId) return none;
  try {
    const { data, error } = await supabase
      .from("needs_you_waits")
      .select("item_key, until, reason")
      .eq("org_id", orgId)
      .gt("until", todayStr)
      .limit(500);
    if (error) return none;
    const waits = new Map<string, { until: string; reason: string | null }>();
    for (const r of (data ?? []) as { item_key?: string | null; until?: string | null; reason?: string | null }[]) {
      if (!r.item_key || !r.until) continue;
      waits.set(String(r.item_key), { until: String(r.until).slice(0, 10), reason: (r.reason ?? "").trim() || null });
    }
    return { ready: true, waits };
  } catch {
    return none;
  }
}

/**
 * THE FOLD: every Now row whose key has a wait moves to the Waiting fold with its day and reason. A
 * row whose wait's day has come was never in `waits` (the read asks for later days only), so it
 * stays. Pure.
 */
export function foldWaitingRows(
  items: Omit<ActionItem, "stream">[],
  waits: NeedsYouWaits["waits"],
): { now: Omit<ActionItem, "stream">[]; waiting: WaitingItem[] } {
  const now: Omit<ActionItem, "stream">[] = [];
  const waiting: WaitingItem[] = [];
  for (const it of items) {
    const w = it.waitKey ? waits.get(it.waitKey) : undefined;
    const row = w ? waitingRow({ id: it.id, kind: it.kind, title: it.title, why: w.reason ?? "Snoozed", backOn: w.until, href: it.href }) : null;
    if (row) waiting.push(row);
    else now.push(it);
  }
  return { now, waiting };
}

/**
 * SNOOZE AN ENDLESS ROW (job.snoozeNeedsYou). The day is today or later, on the company's calendar
 * (`todayStr`); the reason is optional. One row per key: a second Snooze moves the day. Each save
 * also clears this company's waits whose day has passed. Staff only, by the table's policy and by the
 * registry. A zero-row write is said, never assumed landed.
 */
export async function saveNeedsYouWait(
  supabase: any,
  input: { orgId: string | null; userId: string | null; key: string; date: string; reason?: string | null; todayStr: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!input.orgId || !input.userId) return { ok: false, error: "Sign in to your company first." };
  const day = checkComeBackDay(input.todayStr, input.date);
  if (!day.ok) return { ok: false, error: day.error };
  const reason = (input.reason ?? "").trim().slice(0, 200) || null;
  const { data, error } = await supabase
    .from("needs_you_waits")
    // Who and when are the database's (needs_you_waits_stamp): the signed-in person and now.
    .upsert({ org_id: input.orgId, item_key: input.key, until: day.day, reason, created_by: input.userId }, { onConflict: "org_id,item_key" })
    .select("id");
  if (error) {
    return {
      ok: false,
      error: isMissingWaitsTable(error) ? "Snooze needs one database update before it can hold a day. Nothing was changed." : dbError(error),
    };
  }
  if (!data?.length) return { ok: false, error: "That didn't save - check your access and try again." };
  // The waits whose day has passed are done: cleared here, on a write, never on a read. Best effort.
  try {
    await supabase.from("needs_you_waits").delete().eq("org_id", input.orgId).lt("until", input.todayStr);
  } catch {
    /* a leftover row whose day has passed is ignored by every read */
  }
  return { ok: true };
}
