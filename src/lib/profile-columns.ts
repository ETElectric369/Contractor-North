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
export const PROFILE_PAY_COLS = "id, org_id, full_name, hourly_rate, bill_rate, home_address, commute_baseline_miles, active";

export type ProfilePayRow = {
  id: string;
  org_id: string | null;
  full_name: string | null;
  hourly_rate: number | null;
  bill_rate: number | null;
  home_address: string | null;
  commute_baseline_miles: number | null;
  active?: boolean;
};

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function payRateMap(
  supabase: any,
): Promise<Map<string, { hourly_rate: number | null; bill_rate: number | null; commute_baseline_miles: number | null }>> {
  const { data } = await supabase.from("profile_pay").select("id, hourly_rate, bill_rate, commute_baseline_miles");
  const m = new Map<string, { hourly_rate: number | null; bill_rate: number | null; commute_baseline_miles: number | null }>();
  for (const r of (data ?? []) as ProfilePayRow[]) {
    if (r?.id) m.set(String(r.id), {
      hourly_rate: r.hourly_rate ?? null,
      bill_rate: r.bill_rate ?? null,
      commute_baseline_miles: r.commute_baseline_miles ?? null,
    });
  }
  return m;
}

/** Merge those rates onto rows whose embedded `profiles` no longer carries them.
 *  `pick` returns the row's profile id and the object holding the embedded profile. */
export function attachRates<T>(
  rows: T[] | null | undefined,
  rates: Map<string, { hourly_rate: number | null; bill_rate: number | null; commute_baseline_miles: number | null }>,
  pick: (row: T) => { id: string | null | undefined; holder: { profiles?: unknown } | null | undefined },
): T[] {
  for (const row of rows ?? []) {
    const { id, holder } = pick(row);
    if (!id || !holder?.profiles) continue;
    holder.profiles = { ...(holder.profiles as object), ...(rates.get(String(id)) ?? {}) };
  }
  return rows ?? [];
}
