/**
 * WHICH PROFILE COLUMNS A SIGNED-IN PERSON MAY READ (v800 audit).
 *
 * `profiles` carries the pay spine — hourly_rate, bill_rate, home_address,
 * commute_baseline_miles — on the same row as everyone's name and role, and RLS cannot
 * restrict columns. Migration 0216 revokes those four from the `authenticated` role, so any
 * `select("*")` on profiles becomes a permission error. This is the explicit list that
 * replaces `*`, and the pay columns come from the staff-scoped `profile_pay` view (0215)
 * instead.
 *
 * Adding a column to `profiles` means adding it here too — that is deliberate. A new column
 * is invisible until someone decides it is safe for every member of the org to read.
 */
export const PROFILE_SAFE_COLS =
  "id, full_name, email, phone, role, avatar_url, active, created_at, updated_at, org_id, language, home_lat, home_lng, push_prefs, must_reset_password, crew_lead, deactivated_at, deactivated_by, onboarded_at, nort_humor, nort_register, nort_notes, lessons_seen";

/** The pay/address columns — readable only through `profile_pay`, never off `profiles`. */
export const PROFILE_PAY_COLS = "id, org_id, full_name, hourly_rate, bill_rate, home_address, commute_baseline_miles, active, paid_by_draw";

export type ProfilePayRow = {
  id: string;
  org_id: string | null;
  full_name: string | null;
  hourly_rate: number | null;
  bill_rate: number | null;
  home_address: string | null;
  commute_baseline_miles: number | null;
  active?: boolean;
  /** 0286: an owner is paid by owner's draw. The view already reads his hourly_rate as 0. */
  paid_by_draw?: boolean | null;
};

/** The rate facts every reader of `payRateMap` gets per person. */
export type PayRates = {
  hourly_rate: number | null;
  bill_rate: number | null;
  commute_baseline_miles: number | null;
  /** 0286: true for an owner. His hours are billed and counted, never a cost. */
  paid_by_draw: boolean;
};

/**
 * IS THIS PERSON PAID BY OWNER'S DRAW? (migration 0286, Erik 2026-09-23: "get rid of the owners
 * wages and make everything not a cost part of the owners draw").
 *
 * Every owner is. The flag rides out of profile_pay beside the rates, so a reader that already has
 * the rates in hand has the answer too. A MISSING flag reads false, and that is safe rather than a
 * gap: the same view already returns hourly_rate 0 for an owner, so a reader that never asks this
 * question still costs his hours at $0. Asking it is how a reader tells his hours apart (counted,
 * billed, never "unrated").
 */
export function isPaidByDraw(profile: { paid_by_draw?: unknown } | null | undefined): boolean {
  return profile?.paid_by_draw === true;
}

/** Index a profile_pay read by profile id, for merging onto a profiles list. */
export function payById(rows: ProfilePayRow[] | null | undefined): Map<string, ProfilePayRow> {
  const m = new Map<string, ProfilePayRow>();
  for (const r of rows ?? []) if (r?.id) m.set(String(r.id), r);
  return m;
}

/** Every rate the CALLER is entitled to, keyed by profile id.
 *
 *  PostgREST embeds like `profiles(hourly_rate)` cannot survive 0216's column revoke — column
 *  privileges are per-ROLE, and staff and techs are the same `authenticated` role, so the embed
 *  would break for everyone. Surfaces that legitimately show rates therefore fetch them from the
 *  staff-scoped `profile_pay` view and merge them onto the embedded profile. A tech who reaches
 *  one of these code paths simply gets no rates, which is the point. */
export async function payRateMap(supabase: any): Promise<Map<string, PayRates>> {
  return (await payRateMapRead(supabase)).rates;
}

/**
 * THE SAME READ, WITH ITS FAILURE STILL ATTACHED (2026-09-17).
 *
 * payRateMap swallows the error and hands back an empty Map, which for most callers is a display
 * that goes quiet. On the Pay page it is not: the rate MULTIPLIES every live dollar, so a dropped
 * read prices every unlocked hour at zero, and a man owed thousands reads "Paid Up". That page's
 * own rule is that the money reads come back whole or it shows no amount at all, and this read was
 * the one left outside it. Callers that only decorate a screen keep using payRateMap; anything
 * computing money asks for the problem too and refuses with it.
 */
export async function payRateMapRead(
  supabase: any,
): Promise<{
  rates: Map<string, PayRates>;
  problem: string | null;
}> {
  // paid_by_draw rides the same read (0286), so every surface that prices hours also knows whose
  // hours are the owner's, with no second query that could fail on its own.
  const { data, error } = await supabase.from("profile_pay").select("id, hourly_rate, bill_rate, commute_baseline_miles, paid_by_draw");
  const m = new Map<string, PayRates>();
  if (error || !Array.isArray(data)) return { rates: m, problem: "the pay rates could not be read" };
  for (const r of data as ProfilePayRow[]) {
    if (r?.id) m.set(String(r.id), {
      hourly_rate: r.hourly_rate ?? null,
      bill_rate: r.bill_rate ?? null,
      commute_baseline_miles: r.commute_baseline_miles ?? null,
      paid_by_draw: isPaidByDraw(r),
    });
  }
  return { rates: m, problem: null };
}


/** Merge those rates onto rows whose embedded `profiles` no longer carries them.
 *  `pick` returns the row's profile id and the object holding the embedded profile. */
export function attachRates<T>(
  rows: T[] | null | undefined,
  rates: Map<string, PayRates>,
  pick: (row: T) => { id: string | null | undefined; holder: { profiles?: unknown } | null | undefined },
): T[] {
  for (const row of rows ?? []) {
    const { id, holder } = pick(row);
    if (!id || !holder?.profiles) continue;
    holder.profiles = { ...(holder.profiles as object), ...(rates.get(String(id)) ?? {}) };
  }
  return rows ?? [];
}
