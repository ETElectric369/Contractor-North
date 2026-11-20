import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrgSettings, type OrgSettings } from "@/lib/org-settings";
import { ESTIMATE_VISIT_TYPES } from "@/lib/statuses";
import { readAllPages } from "@/lib/read-all-pages";
import { bucketInspections, type InspectionBucketRow, type InspectionBuckets } from "@/lib/inspections";

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
  "id, type, title, status, starts_at, ends_at, created_at, location, capture, inquiry_id, job_id, customer_id, outcome, customers(name), inquiries(name)";
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
  inquiries?: { name?: string | null } | null;
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
  /** Where the read failed, or null. */
  error: { where: "visits" | "estimates" | "billed" | "org"; cause: unknown } | null;
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
    error: { where, cause },
  });
  if (orgRes?.error) return failed("org", orgRes.error);
  if (visitsRes?.error || !Array.isArray(visitsRes?.data)) return failed("visits", visitsRes?.error ?? new Error("visits read returned no rows array"));
  if (quotesRes.error) return failed("estimates", quotesRes.error);
  if (billedRes.error) return failed("billed", billedRes.error);

  const visits = visitsRes.data as InspectionVisit[];
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
  );
  return { visits, buckets, settings, tz, capped: visits.length === VISIT_READ_CAP, error: null };
}
