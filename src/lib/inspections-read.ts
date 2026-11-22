import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrgSettings, type OrgSettings } from "@/lib/org-settings";
import { ESTIMATE_VISIT_TYPES } from "@/lib/statuses";
import { readAllPages } from "@/lib/read-all-pages";
import { bucketInspections, type InspectionBucketRow, type InspectionBuckets } from "@/lib/inspections";
import { leadClosedAtFrom } from "@/lib/appointments/visit-settled";
import { offerCustomerOf, offerJobLabel, visitOffer, type OfferCandidate, type VisitOffer } from "@/lib/appointments/visit-offer";
import { reportError } from "@/lib/observe";

/**
 * ONE READER FOR THE INSPECTION BUCKETS (cn-v1172). Erik, 2026-11-19: "lets break the Estimate page
 * into 2 parts consisting of completed inspections in its own new list called Inspections To
 * Estimate". From this release the inspected visits nobody has priced are drawn on the Estimates page
 * and everyone else waiting on an inspection on the Inspections page. Both pages read the visits, the
 * estimates written from them, the billed jobs and the company's clock HERE, and bucket them by the one
 * rule (lib/inspections bucketInspections), so the two pages can never disagree about who is where.
 *
 * A FAILED READ IS RETURNED, NEVER SWALLOWED. Any one of the four reads failing means the buckets
 * cannot be trusted (with the estimates unread, every inspected visit would look unpriced), so the
 * answer is `error` and empty buckets, and each page says it could not load. Never drawn as nobody.
 *
 * THE ESTIMATES AND THE BILLED JOBS ARE READ WHOLE (readAllPages). They decide whether a visit is
 * settled, and the API hands back at most a thousand rows a request and says nothing: a company past
 * that would have seen visits it priced long ago come back as waiting on a price. The visits keep their
 * cap (VISIT_READ_CAP), which the Inspections page says when it is reached.
 *
 * No money column in any read. No catalog (a lib never imports one).
 */

/** How many visits are read at most; when exactly this many come back, `capped` is true. */
export const VISIT_READ_CAP = 500;

/** The visit columns. customer_id: where a row's name leads (inspectionFileHref), and whether a filed
 *  one hangs on nobody (filedWithNobody); left out, every customer's inspection would read as nobody's. */
export const VISIT_COLUMNS =
  "id, type, title, status, starts_at, ends_at, created_at, location, capture, inquiry_id, job_id, customer_id, outcome, customers(name), inquiries(name, converted_at, customer_id)";
/** The jobs made from the visits' leads (cn-v1175): when each lead closed (visitSettled, lead-closed). */
export const LEAD_JOB_COLUMNS = "inquiry_id, created_at";
/** Lead ids per request when reading the jobs made from them. */
const LEAD_IDS_PER_REQUEST = 50;
/** Which leads, jobs and captures already have an estimate: the "written up" signal. The id too: a
 *  lead-less Start Now write-up is matched by capture.quote_id. */
export const ESTIMATE_LINK_COLUMNS = "id, inquiry_id, job_id";
/** The jobs with real billing on them (0205: a visit that became billed work is finished). */
export const BILLED_JOB_COLUMNS = "job_id";
export const ORG_COLUMNS = "settings";

/** One visit as read. */
export type InspectionVisit = InspectionBucketRow & {
  type: string;
  title: string | null;
  ends_at: string | null;
  created_at: string | null;
  location: string | null;
  customer_id: string | null;
  customers?: { name?: string | null } | null;
  inquiries?: { name?: string | null; converted_at?: string | null; customer_id?: string | null } | null;
};

export type InspectionsRead = {
  /** Every visit read, in the read's order. Empty on an error. */
  visits: InspectionVisit[];
  /** bucketInspections over the visits. Empty piles on an error. */
  buckets: InspectionBuckets<InspectionVisit>;
  /** The company's settings, as getOrgSettings reads them (its timezone, its switches). */
  settings: OrgSettings;
  /** The company's timezone: the buckets' midnight, and every row's words. */
  tz: string;
  /** Exactly VISIT_READ_CAP visits came back: older ones may not be listed. */
  capped: boolean;
  /** THE OFFER (cn-v1175, R5, lib/appointments/visit-offer): for an open visit whose day has passed, the
   *  job made for its customer record after it, by visit id. A failed read offers nothing (said to the
   *  ops sink); the rows are as they were. */
  offers: ReadonlyMap<string, VisitOffer>;
  /** Where the read failed, or null. */
  error: { where: "visits" | "estimates" | "billed" | "org" | "leadJobs"; cause: unknown } | null;
};

const EMPTY_BUCKETS = (): InspectionBuckets<InspectionVisit> => ({ toWriteUp: [], upcoming: [], missed: [], filed: [] });

/**
 * Read and bucket. `now` is the caller's ONE clock: the buckets, the list and the rows' words read it,
 * so the three cannot disagree.
 */
export async function readInspectionBuckets(supabase: SupabaseClient, opts: { now: Date }): Promise<InspectionsRead> {
  // Untyped on purpose: the API's typed builder, carried through a generic, is deeper than tsc reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const [visitsRes, quotesRes, billedRes, orgRes] = await Promise.all([
    sb
      .from("appointments")
      .select(VISIT_COLUMNS)
      .in("type", [...ESTIMATE_VISIT_TYPES])
      // THE CAP NEVER CUTS OPEN WORK THAT HAS NO DAY. Newest start first with the visits waiting for a
      // day (no start, 0368) ahead of them all, so the visits kept are every visit waiting for a day plus
      // the latest by date; what the cap cuts is the oldest by date. The order on screen is the list's.
      .order("starts_at", { ascending: false, nullsFirst: true })
      .limit(VISIT_READ_CAP),
    readAllPages<{ id: string; inquiry_id: string | null; job_id: string | null }>((from, to) =>
      sb.from("quotes").select(ESTIMATE_LINK_COLUMNS).order("id").range(from, to),
    ),
    readAllPages<{ job_id: string | null }>((from, to) =>
      sb
        .from("invoices")
        .select(BILLED_JOB_COLUMNS)
        .not("job_id", "is", null)
        .not("status", "in", "(draft,void)")
        // A payment request (cn-v1177) is money asked for ahead of the work, never billed work.
        .neq("invoice_kind", "prepayment")
        .order("id")
        .range(from, to),
    ),
    sb.from("organizations").select(ORG_COLUMNS).limit(1).maybeSingle(),
  ]);

  const settings = getOrgSettings((orgRes?.data as { settings?: unknown } | null)?.settings);
  const tz = settings.timezone;
  const failed = (where: NonNullable<InspectionsRead["error"]>["where"], cause: unknown): InspectionsRead => ({
    visits: [],
    buckets: EMPTY_BUCKETS(),
    settings,
    tz,
    capped: false,
    offers: new Map(),
    error: { where, cause },
  });
  if (orgRes?.error) return failed("org", orgRes.error);
  if (visitsRes?.error || !Array.isArray(visitsRes?.data)) return failed("visits", visitsRes?.error ?? new Error("visits read returned no rows array"));
  if (quotesRes.error) return failed("estimates", quotesRes.error);
  if (billedRes.error) return failed("billed", billedRes.error);

  const visits = visitsRes.data as InspectionVisit[];
  // WHEN EACH LEAD CLOSED (cn-v1175, the one visit rule's lead-closed arm, the same Needs You reads): its
  // own converted_at, or the first job made from it. A failed read is the page's failure, said.
  const leadIds = [...new Set(visits.map((v) => v.inquiry_id).filter((v): v is string => typeof v === "string" && v.length > 0))];
  const leadJobs: { inquiry_id?: string | null; created_at?: string | null }[] = [];
  for (let i = 0; i < leadIds.length; i += LEAD_IDS_PER_REQUEST) {
    const res = await sb.from("jobs").select(LEAD_JOB_COLUMNS).in("inquiry_id", leadIds.slice(i, i + LEAD_IDS_PER_REQUEST)).limit(1000);
    if (res?.error) return failed("leadJobs", res.error);
    leadJobs.push(...((res?.data ?? []) as typeof leadJobs));
  }
  const one = <V,>(v: V | V[] | null | undefined): V | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  const leadClosedAt = leadClosedAtFrom(
    visits.map((v) => ({ id: v.inquiry_id, converted_at: one(v.inquiries)?.converted_at ?? null })),
    leadJobs,
  );
  const ids = (rows: readonly Record<string, unknown>[], col: string) =>
    new Set(rows.map((r) => r[col]).filter((v): v is string => typeof v === "string" && v.length > 0));
  const buckets = bucketInspections(
    visits,
    ids(quotesRes.rows, "inquiry_id"),
    ids(quotesRes.rows, "job_id"),
    opts.now,
    ids(quotesRes.rows, "id"),
    ids(billedRes.rows, "job_id"),
    tz, // "before today" is the company's midnight (a day that passed)
    { leadClosedAt },
  );
  const offers = await readOffers(sb, [...buckets.toWriteUp, ...buckets.missed]);
  return { visits, buckets, settings, tz, capped: visits.length === VISIT_READ_CAP, offers, error: null };
}

/** The jobs a customer record has, for the offer: id, customer, made, number and name. No money column. */
export const OFFER_JOB_COLUMNS = "id, customer_id, created_at, job_number, name";

/**
 * THE OFFER'S ONE READ: the jobs of the customer records the open visits name (their own, else their
 * lead's), made after the oldest of those visits, in batches. A batch that fails offers nothing for its
 * customers and is said to the ops sink; the rows stay as they were (never a guess).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readOffers(sb: any, open: readonly InspectionVisit[]): Promise<Map<string, VisitOffer>> {
  const one = <V,>(v: V | V[] | null | undefined): V | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  const asked = open
    .filter((v) => !v.job_id && !!v.starts_at)
    .map((v) => ({ v, customer: offerCustomerOf({ customer_id: v.customer_id, lead_customer_id: one(v.inquiries)?.customer_id ?? null }) }))
    .filter((x): x is { v: InspectionVisit; customer: string } => !!x.customer);
  const out = new Map<string, VisitOffer>();
  if (!asked.length) return out;
  const customers = [...new Set(asked.map((x) => x.customer))];
  const since = asked.map((x) => String(x.v.starts_at)).sort()[0];
  const candidates: OfferCandidate[] = [];
  for (let i = 0; i < customers.length; i += LEAD_IDS_PER_REQUEST) {
    try {
      const res = await sb
        .from("jobs")
        .select(OFFER_JOB_COLUMNS)
        .in("customer_id", customers.slice(i, i + LEAD_IDS_PER_REQUEST))
        .gt("created_at", since)
        .neq("status", "cancelled")
        .limit(1000);
      if (res?.error) throw res.error;
      for (const j of (res?.data ?? []) as { id: string; customer_id: string | null; created_at: string | null; job_number?: string | null; name?: string | null }[]) {
        candidates.push({ kind: "job", id: String(j.id), customer_id: j.customer_id ?? null, created_at: j.created_at ?? null, label: offerJobLabel(j) });
      }
    } catch (e) {
      reportError("inspections:offers", e);
    }
  }
  for (const { v, customer } of asked) {
    const offer = visitOffer({ starts_at: v.starts_at, job_id: v.job_id, customer_id: customer }, candidates);
    if (offer) out.set(v.id, offer);
  }
  return out;
}
