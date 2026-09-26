import { formatCurrency, hoursBetween } from "@/lib/utils";
import { payRateForEntry } from "@/lib/payroll-math";
import { isPaidByDraw } from "@/lib/profile-columns";

/** One billable-labor line for a worker on a job. `sourceIds` are the time_entry ids whose hours
 *  this line bills: the line's CLAIM on them (0255). A claim is what lets a second invoice bill only
 *  what is new: the hours a line holds are never imported onto another one. */
export type LaborLine = {
  personId: string;
  name: string;
  rate: number;
  rawHours: number;
  quantity: number;
  amount: number;
  sourceIds: string[];
  /** Where `rate` came from. "bill_rate": the person's own (under the level's ceiling). "level" /
   *  "default": they have NO bill rate, so the customer's level rate or the org's default labor rate
   *  (the office is told: "No bill rate set"). "none": no bill rate and nothing to fall back to, so
   *  the line is $0 and the office is told that too. Never their pay rate (audit v994 PL2). */
  rateFrom: "bill_rate" | "level" | "default" | "none";
};

/**
 * DROP THE HOURS ANOTHER INVOICE ALREADY BILLS (0255, "the invariant moves to the row").
 *
 * Erik, 2026-09-11: "i couldnt even make an invoice for 85 whitney… kept referring to the old
 * invoice even though i have new time and new bills". Each labor line claims the entry ids it
 * billed, so the rule is what it always meant: an hour is billed on at most ONE non-void invoice.
 * Feed this `claimed` (every source id held by the job's OTHER non-void invoices) and it returns
 * the entries still free to bill, in the shape computeJobLaborBilling takes.
 *
 * A SPLIT IS A CUT NOW (0288/0289). A split shift is two or more ordinary entries, each on its own
 * job, and a piece that carries hours an invoice already bills carries that invoice's claim by its
 * own id (split_time_entry appends it). So there is nothing left to re-derive here: the old
 * allocation rows, and the created_at rule that told an old split from one made after the bill
 * (the mechanism behind INV-078 claiming the Jul 14 hour), are gone with the table.
 */
export function withoutClaimedLabor(
  jobEntries: any[],
  claimed: ReadonlySet<string>,
): { jobEntries: any[]; skippedIds: string[] } {
  const skippedIds: string[] = [];
  const entries: any[] = [];
  for (const e of jobEntries ?? []) {
    if (e?.id && claimed.has(String(e.id))) {
      skippedIds.push(String(e.id));
      continue;
    }
    entries.push(e);
  }
  return { jobEntries: entries, skippedIds };
}

/**
 * Per-job LABOR COST (what we PAY): the one implementation shared by the job hub and /analytics so a
 * job can't show two different profits. Counts the closed entries on `jobId`, each costed at its OWN
 * pay rate (rate_override ?? base) via payRateForEntry. Accepts the job's own entries (job hub,
 * pre-filtered) OR all entries (analytics): same result either way.
 *
 * A split shift is ordinary entries (0288), so each piece is simply an entry on its own job. A
 * job-less piece carrying a time code (Drive, Shop) belongs to no job and is costed to none.
 *
 * THE OWNER'S HOURS ARE HOURS, NOT A COST (0286). The owner is paid by owner's draw: his hours count
 * in `hours` (the job took them) and again in `ownerHours` (so a screen can say "Your Hours" and
 * "$X per hour you worked"), they add $0 to `cost`, and they are NEVER `unratedHours`: his rate is
 * not missing, he simply has none, and "3 hours have no rate" about the owner would be a false
 * alarm. Billing is untouched: computeJobLaborBilling still bills him at his bill_rate.
 */
export function laborCostForJob(
  entries: any[],
  jobId: string,
  fallbackRate = 0,
): { hours: number; cost: number; unratedHours: number; ownerHours: number } {
  // UNRATED HOURS ARE REPORTED, NEVER SWALLOWED (v800 audit). A worker with no hourly_rate and
  // no fallback costs $0/hr, so their labor vanished from job profit entirely: a labor-only job
  // with an unrated crew member read as PURE PROFIT. The cost still cannot be invented (that is
  // the office's number), but the hours it could not price come back with it.
  let hours = 0;
  let cost = 0;
  let unratedHours = 0;
  let ownerHours = 0;
  for (const e of entries ?? []) {
    if (e?.job_id !== jobId || e.status !== "closed" || !e.clock_out) continue;
    const owner = isPaidByDraw(e?.profiles) || e?.paid_by_draw === true;
    const rate = owner ? 0 : payRateForEntry(e, fallbackRate);
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    hours += h;
    if (owner) {
      ownerHours += h;
      continue;
    }
    if (!(rate > 0)) unratedHours += h;
    cost += h * rate;
  }
  return {
    hours: Math.round(hours * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    unratedHours: Math.round(unratedHours * 100) / 100,
    ownerHours: Math.round(ownerHours * 100) / 100,
  };
}

/** Compute per-person billable labor for a job from its CLOSED time: the single source of truth
 *  shared by importLaborIntoInvoice (which inserts these lines) and jobProgressFinancials / the job
 *  page (which sum the total). Keeping the algorithm in one place is what makes the panel's "work to
 *  date" reconcile to the penny with the labor lines that actually get billed.
 *
 *  Rule (Erik's): bill the EXACT time on this job, which is every closed entry on it, lunch
 *  deducted. A split shift is ordinary entries (0288), one job each, so "the time on this job" is
 *  simply the entries on this job; there is no second ledger to reconcile any more. Rate =
 *  bill_rate (capped at the level rate) ?? level rate ?? default_labor_rate. Quantity is rounded to
 *  the quarter hour PER PERSON (so a 2.6h person bills 2.5h, matching the printed line).
 *
 *  NEVER THEIR PAY RATE (audit v994 PL2, Erik's law). This used to fall back from bill_rate to
 *  hourly_rate, so a new tech at $40 pay with no bill rate was billed to the customer at $40: his
 *  wage, on the customer's paper (the portal shows a draft's lines live), and underpriced. A person
 *  with no bill rate now bills at the customer's level rate or the org's default labor rate, and the
 *  line carries `rateFrom` so the office is told "No bill rate set". The owner is unaffected: the
 *  view that supplies the rates (profile_pay, and payViewRow for the service role) already folds his
 *  figure into bill_rate. A pay figure on the profile is not read here at all.
 *
 *  jobEntries: closed time_entries on the job, each with id, clock_in/out, lunch, job_code, profiles. */
export function computeJobLaborBilling(
  jobEntries: any[],
  defaultRate: number,
  /** The customer's pricing-level labor rate: a CEILING on hourly billing for that customer tier
   *  (Erik 7/24): a person billing ABOVE it drops to it (Erik $150 → Local $125), a person below
   *  keeps their own rate (Brian stays $95). A person with no rate at all bills the level rate
   *  directly. Absent/0 → per-person bill_rate then org default, as before. */
  levelRate?: number | null,
  /**
   * CODES THE ORG MARKED NON-BILLABLE: job_codes.billable = false.
   *
   * Every org is seeded with SHOP ("Shop / yard time") and PTO ("Paid time off") already set false
   * (0004:467). So a shift clocked into a real job with code SHOP (prefabbing FOR that job, a
   * perfectly natural pick) must not bill the customer for shop time.
   *
   * IT MUST BE THIS PREDICATE AND NOT "HAS A CODE AT ALL". Every ordinary punch carries a code
   * (SVC, ROUGH, TRIM, PANEL), so skipping any coded hour would zero out the whole labor book.
   *
   * Empty set = bill everything. That is the safe default for any caller that hasn't got the
   * org's codes to hand.
   */
  nonBillableCodes: ReadonlySet<string> = new Set(),
): { lines: LaborLine[]; total: number } {
  const unbillable = (code: unknown): boolean => {
    const c = String(code ?? "").trim();
    return !!c && nonBillableCodes.has(c);
  };
  const rawLevel = Number(levelRate);
  const level = Number.isFinite(rawLevel) && rawLevel > 0 ? rawLevel : 0;
  const rawDefault = Number(defaultRate);
  const def = Number.isFinite(rawDefault) && rawDefault > 0 ? rawDefault : 0;
  // Track the best REAL rate seen for a person (NOT frozen on first-seen: two entries can carry
  // different rate snapshots). Key on id, falling back to name so two distinct rate-less workers
  // don't collapse into one bucket.
  const perPerson = new Map<string, { name: string; realRate: number; hours: number; sourceIds: string[] }>();
  // `sourceId` is the entry the hours came from, folded into the person's line as its claim (0255).
  // A row that adds no hours claims nothing: nothing was billed off it.
  const addHours = (prof: any, hrs: number, sourceId?: unknown) => {
    if (!(hrs > 0)) return;
    const key = String(prof?.id ?? prof?.full_name ?? "unknown");
    // BILL rate (what the customer is charged), NOT pay: never hourly_rate, and never a time
    // entry's rate_override (a PAY-rate override, payroll only, see payRateForEntry).
    const raw = Number(prof?.bill_rate ?? 0);
    const realRate = Number.isFinite(raw) && raw > 0 ? raw : 0; // 0 = no usable rate on this snapshot
    const cur = perPerson.get(key);
    if (cur) {
      cur.hours += hrs;
      if (realRate > cur.realRate) cur.realRate = realRate;
      if (sourceId) cur.sourceIds.push(String(sourceId));
    } else {
      perPerson.set(key, { name: prof?.full_name ?? "Crew", realRate, hours: hrs, sourceIds: sourceId ? [String(sourceId)] : [] });
    }
  };
  for (const e of jobEntries ?? []) {
    if (!e?.clock_out) continue;
    if (unbillable(e.job_code)) continue;
    const lunch = Math.max(0, Number(e.lunch_minutes) || 0); // a negative lunch can't add billable time
    addHours(e.profiles, (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - lunch / 60, e.id);
  }
  const lines: LaborLine[] = [...perPerson.entries()].map(([personId, p]) => {
    const personal = p.realRate > 0 ? p.realRate : 0;
    const rate = personal > 0 ? (level > 0 ? Math.min(personal, level) : personal) : level > 0 ? level : def;
    const rateFrom: LaborLine["rateFrom"] = personal > 0 ? "bill_rate" : level > 0 ? "level" : def > 0 ? "default" : "none";
    const quantity = Math.round(p.hours * 4) / 4; // quarter-hour
    return { personId, name: p.name, rate, rawHours: p.hours, quantity, amount: Math.round(quantity * rate * 100) / 100, sourceIds: p.sourceIds, rateFrom };
  });
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { lines, total };
}

/**
 * WHAT THE OFFICE IS TOLD ABOUT A LINE PRICED WITHOUT A BILL RATE (audit v994 PL2; nothing silent).
 *
 * One sentence per person the labor import priced at the customer's level rate or the org's default
 * rate because they have no bill rate of their own, and one for anyone it could price at nothing at
 * all. The importer puts these in its warnings (the toast, and the line under the import row), and
 * the invoice editor marks the line itself.
 */
export function noBillRateWarnings(lines: readonly LaborLine[]): string[] {
  const out: string[] = [];
  for (const l of lines ?? []) {
    if (l.rateFrom === "level") {
      out.push(`No bill rate set for ${l.name} - billed at this customer's level rate, ${formatCurrency(l.rate)} an hour. Set one on the Team page`);
    } else if (l.rateFrom === "default") {
      out.push(`No bill rate set for ${l.name} - billed at your default labor rate, ${formatCurrency(l.rate)} an hour. Set one on the Team page`);
    } else if (l.rateFrom === "none" && l.quantity > 0) {
      out.push(`No bill rate set for ${l.name} and no default labor rate - their ${l.quantity} hours are on this bill at $0. Set a bill rate on the Team page or a default labor rate in Settings`);
    }
  }
  return out;
}

/**
 * profile_pay (0215/0216), row for row, for a server that has no signed-in user. The view is
 * `where org_id = auth_org_id()`, so the SERVICE ROLE reads nothing from it and every rate would be
 * $0. The customer portal prices the work not on a bill yet exactly as the importer will, as the
 * service role, so it reads profiles in the one org the portal link names and applies the view's
 * own CASE: an owner is paid by draw (hourly 0) and bills at bill_rate, else his hourly figure.
 * Keep in step with the view.
 */
export function payViewRow(p: { id: string; role?: string | null; hourly_rate?: number | string | null; bill_rate?: number | string | null }) {
  const owner = p.role === "owner";
  const hourly = p.hourly_rate == null ? null : Number(p.hourly_rate);
  const bill = p.bill_rate == null ? null : Number(p.bill_rate);
  return { id: p.id, hourly_rate: owner ? 0 : hourly, bill_rate: owner ? (bill ?? hourly) : bill };
}

/**
 * THE RATES A CUSTOMER'S PAGE MAY PRICE WITH: payViewRow with the PAY figure taken out.
 *
 * computeJobLaborBilling no longer reads hourly_rate at all (audit v994 PL2: it used to fall back to
 * it, and the portal shows a draft's lines live, so that fallback put a wage on a customer's page).
 * The pay figure is still dropped here, on the one path whose reader is a customer, so no future
 * reader of these rows can price with it by accident. (An owner's figure is a bill figure: the view
 * pays an owner by draw, so payViewRow already moved it to bill_rate.)
 */
export function customerRateRow(p: Parameters<typeof payViewRow>[0]) {
  return { ...payViewRow(p), hourly_rate: null };
}

/** The reads computeJobLaborBilling needs, run against a job_id. Centralised so import and
 *  financials fetch identical data.
 *
 *  `scope.orgId`: the caller is the SERVICE ROLE (the customer portal), which RLS does not narrow.
 *  Every read is then pinned to that org by hand, and the rates come from customerRateRow (never
 *  a pay rate: this path is only the customer's page). A signed-in
 *  caller leaves it out and RLS scopes the reads as it always has. */
export async function fetchJobLaborRows(
  supabase: any,
  jobId: string,
  scope?: { orgId: string },
): Promise<{ jobEntries: any[]; nonBillableCodes: Set<string> }> {
  const orgId = scope?.orgId ?? null;
  let entriesQ = supabase
    .from("time_entries")
    // job_code on the ENTRY: an un-billable code (SHOP, PTO) is read here and nowhere else.
    // `id` (0255): the row's identity is what a labor line CLAIMS. The projection law: the fix
    // for "which hours did that invoice cover" was a select list.
    .select("id, clock_in, clock_out, lunch_minutes, job_code, profiles(id, full_name)")
    .eq("job_id", jobId)
    .eq("status", "closed");
  // The org's own answer to "which of these hours does a customer pay for". Fetched HERE so all
  // three consumers (the job hub, the invoice import and the progress draw) cannot disagree.
  let codesQ = supabase.from("job_codes").select("code").eq("billable", false);
  if (orgId) {
    entriesQ = entriesQ.eq("org_id", orgId);
    codesQ = codesQ.eq("org_id", orgId);
  }
  const [entriesRead, codesRead, payRead] = await Promise.all([
    entriesQ,
    codesQ,
    // BILL RATES COME FROM THE STAFF-SCOPED VIEW (0215/0216), not from an embed on profiles:
    // those columns are revoked from the authenticated role. The view returns the whole org to
    // office staff and nothing but your own row to a tech. The service role reads the table in
    // the one org it was handed, through the view's own rule with the pay figure removed
    // (customerRateRow).
    orgId
      ? supabase
          .from("profiles")
          .select("id, role, hourly_rate, bill_rate")
          .eq("org_id", orgId)
          .then((r: { data: any[] | null; error: unknown }) => ({ data: (r.data ?? []).map(customerRateRow), error: r.error }))
      : supabase.from("profile_pay").select("id, hourly_rate, bill_rate"),
  ]);
  // A LOST READ IS NOT AN EMPTY ONE (audit v1018 money-1). No hours reads as $0 of labor, no codes
  // bills the SHOP hours, no rates bills every hour at the default: each one a figure on a customer's
  // bill (the importer, the Unbilled card, the Progress Summary) that nobody worked out. Throw, and
  // every caller says the job's work couldn't be read.
  for (const r of [entriesRead, codesRead, payRead]) if (r.error) throw r.error;
  const jobEntries = entriesRead.data;
  const codes = codesRead.data;
  const payRows = payRead.data;
  const rateById = new Map<string, { hourly_rate: number | null; bill_rate: number | null }>();
  for (const r of (payRows ?? []) as any[]) if (r?.id) rateById.set(String(r.id), r);
  const withRate = (prof: any) => (prof?.id ? { ...prof, ...(rateById.get(String(prof.id)) ?? {}) } : prof);
  for (const e of (jobEntries ?? []) as any[]) {
    e.profiles = withRate(e.profiles);
  }
  return {
    jobEntries: jobEntries ?? [],
    nonBillableCodes: new Set(((codes ?? []) as { code: string }[]).map((c) => String(c.code).trim()).filter(Boolean)),
  };
}

/** The customer's pricing-level labor rate for a JOB (null when the job has no customer,
 *  the customer has no level, or the level has no labor rate). THE one resolver every
 *  labor-billing consumer shares — invoice import, job work-to-date panel, and progress
 *  financials must pass the SAME value or the penny-reconcile promise breaks. */
export async function customerLaborRateForJob(supabase: any, jobId: string): Promise<number | null> {
  // A failed read throws (audit v1018 money-1): "no level" would bill the customer's hours at the
  // default rate instead of the rate they were quoted.
  const { data, error } = await supabase
    .from("jobs")
    .select("customers(pricing_levels(labor_rate))")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  const raw = Number((data as any)?.customers?.pricing_levels?.labor_rate);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** The material markup % to bill a JOB at: the customer's pricing-level markup when the
 *  customer has a level, else the org default. THE one resolver for materials, mirroring
 *  customerLaborRateForJob — the draw/finish-job importers and the work-to-date panel must
 *  all seed from this or a level customer gets billed at the org rate on one path and their
 *  negotiated rate on another (two totals for identical work). A level markup of 0 is a real
 *  answer (bill at cost), so only null/absent falls through to the default. */
export async function customerMaterialMarkupForJob(
  supabase: any,
  jobId: string,
  orgDefaultPct: number,
): Promise<number> {
  // A failed read throws, like the labor rate's: the org default is not the customer's markup.
  const { data, error } = await supabase
    .from("jobs")
    .select("customers(pricing_levels(markup_pct))")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  const raw = Number((data as any)?.customers?.pricing_levels?.markup_pct);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  const def = Number(orgDefaultPct);
  return Number.isFinite(def) && def >= 0 ? def : 0;
}
