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

/**
 * The pay/address columns — readable only through `profile_pay`, never off `profiles`.
 *
 * NOT EXPORTED, AND THAT IS THE POINT (the /team defect, 2026-10-01). This list used to be exported
 * and /team selected it by hand with no error check. The moment it grew `cost_rate` for 0373, the
 * page's read began failing WHOLE in the window between a push and Erik applying the migration -
 * PostgREST answers `42703 column "cost_rate" does not exist` and drops every row - so the roster
 * rendered every rate at $0.00, a false "No bill rate set" on every line, blank home addresses, a 0
 * commute baseline and NO Cost box on the owner's row, which is the only door this feature has. Then
 * a save wrote those zeros back as nulls over real stored data.
 *
 * The ladder that survives that window lived in payRateMapRead and nowhere else. Now there is ONE
 * reader for these columns, `profilePayRead`, the ladder is behind it, and there is no column list to
 * select by hand - a would-be second reader has nothing to import. A tripwire
 * (build-time-is-a-cost.test.ts) fails if a file names one of the young columns in a select anyway.
 */
const PROFILE_PAY_BASE =
  "id, org_id, full_name, hourly_rate, bill_rate, home_address, commute_baseline_miles, active";

export type ProfilePayRow = {
  id: string;
  org_id: string | null;
  full_name: string | null;
  hourly_rate: number | null;
  bill_rate: number | null;
  home_address: string | null;
  commute_baseline_miles: number | null;
  active?: boolean;
  /** 0286: an owner is paid by owner's draw — not on payroll. The view reads his hourly_rate as 0. */
  paid_by_draw?: boolean | null;
  /** 0373: what an hour of the OWNER'S OWN BUILD TIME costs the business. Null = nobody has said
   *  yet, which is not $0: see lib/build-time-cost.ts. Never his bill rate, never a wage. */
  cost_rate?: number | null;
};

/** The rate facts every reader of `payRateMap` gets per person. */
export type PayRates = {
  hourly_rate: number | null;
  bill_rate: number | null;
  commute_baseline_miles: number | null;
  /** 0286: true for an owner. He is not on payroll; his hours are billed and counted. */
  paid_by_draw: boolean;
  /** 0373: the owner's build-time COST rate. Null = not set yet, never read as $0 in silence. */
  cost_rate: number | null;
};

/**
 * IS THIS PERSON PAID BY OWNER'S DRAW — that is, NOT ON PAYROLL? (migration 0286.)
 *
 * Every owner is. The flag rides out of profile_pay beside the rates, so a reader that already has
 * the rates in hand has the answer too. A MISSING flag reads false, and that is safe rather than a
 * gap: the same view already returns hourly_rate 0 for an owner, so no reader can turn his row into
 * a wage.
 *
 * IT NO LONGER MEANS "HIS HOURS ARE NEVER A COST" (Erik, 2026-10-01: "build time, including my build
 * time is considered COGS"). The flag carries ONE fact now — he is not on payroll, so he has no
 * Earned, no Owed and no pay period. What his build time COSTS is a different question with its own
 * rate and its own expression: lib/build-time-cost.ts. A reader that wants a cost asks that; a
 * reader that wants to know who is on the Pay board asks this.
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

const PAY_RATE_COLS = "id, hourly_rate, bill_rate, commute_baseline_miles";

/** 42703 = undefined_column: the shape a select naming a not-yet-migrated column fails with. */
function isUndefinedColumn(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? "");
  const message = String((error as { message?: string })?.message ?? "");
  return code === "42703" || /column .*(paid_by_draw|cost_rate).* does not exist/i.test(message);
}

/** What a reader is told when the view could not be read at all: said in words, never drawn as $0. */
const PAY_READ_PROBLEM = "the pay rates could not be read";

/**
 * THE YOUNG COLUMNS, NEWEST LAST — the ones a deployed app may name before the view has them.
 *
 * Add a column to profile_pay and it goes on the END of this list, which is the whole of what a future
 * migration window costs: the ladder below drops them one at a time, youngest first, so a database at
 * any point in the sequence answers with everything it actually has.
 */
const PAY_VIEW_YOUNG = ["paid_by_draw", "cost_rate"] as const;

/**
 * THE ONE READ OF `profile_pay`, WITH THE MIGRATION WINDOW IN IT (inspection/schema.ts
 * tolerateMissingColumns).
 *
 * A push to main deploys before the migration is applied, and a select naming a column the view has
 * not got yet fails WHOLE - every row dropped, not just the column. Without this, a caller that
 * swallows the error prices all crew labor at $0 with no word said, and a caller that renders the rows
 * draws a roster of zeros that a save then writes back as nulls. Both have happened.
 *
 * ONE COLUMN BACK AT A TIME, AND THE ORDER MATTERS. A database with 0286 but not 0373 has
 * paid_by_draw and not cost_rate; dropping straight to the base columns would lose the DRAW FLAG along
 * with the cost rate, and without the flag the owner reads as crew with no pay rate - a false "hours
 * with no rate" alarm about a wage he has never had, and on /team a Pay box where his Cost box belongs.
 *
 * Only undefined_column is tolerated. Any other failure comes back as `problem`, for the caller to say.
 */
async function payViewRead(
  supabase: any,
  base: string,
): Promise<{ rows: ProfilePayRow[]; problem: string | null }> {
  // `: number` on purpose: PAY_VIEW_YOUNG is `as const`, so its `.length` is the literal 2 and the
  // compiler would narrow `keep` to 2 forever and call `keep === 0` unreachable.
  for (let keep: number = PAY_VIEW_YOUNG.length; keep >= 0; keep -= 1) {
    const cols = [base, ...PAY_VIEW_YOUNG.slice(0, keep)].join(", ");
    const { data, error } = await supabase.from("profile_pay").select(cols);
    if (!error && Array.isArray(data)) return { rows: data as ProfilePayRow[], problem: null };
    // A missing column is the only failure worth another try, and only while a rung is left to drop.
    if (!error || !isUndefinedColumn(error) || keep === 0) return { rows: [], problem: PAY_READ_PROBLEM };
  }
  return { rows: [], problem: PAY_READ_PROBLEM };
}

/**
 * EVERY PAY/ADDRESS COLUMN FOR THE WHOLE ROSTER, OR THE REASON THERE ARE NONE (/team).
 *
 * The one door for a full `profile_pay` read: the same ladder, the same tolerance, the same reported
 * problem as the rates read. A page that draws these rows asks for the problem too and says it, because
 * an empty roster and a roster of $0.00 look identical on screen and only one of them is true.
 */
export async function profilePayRead(
  supabase: any,
): Promise<{ rows: ProfilePayRow[]; problem: string | null }> {
  return payViewRead(supabase, PROFILE_PAY_BASE);
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
  // paid_by_draw rides the same read (0286) and cost_rate rides it too (0373), so every surface that
  // prices hours knows whose hours are the owner's AND what his build time costs, with no second
  // query that could fail on its own. The migration-window ladder is payViewRead's, shared with the
  // roster read: one function, so a window that breaks one reader cannot be open on the other.
  const { rows, problem } = await payViewRead(supabase, PAY_RATE_COLS);
  const m = new Map<string, PayRates>();
  if (problem) return { rates: m, problem };
  for (const r of rows) {
    if (r?.id) m.set(String(r.id), {
      hourly_rate: r.hourly_rate ?? null,
      bill_rate: r.bill_rate ?? null,
      commute_baseline_miles: r.commute_baseline_miles ?? null,
      paid_by_draw: isPaidByDraw(r),
      cost_rate: r.cost_rate ?? null,
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
