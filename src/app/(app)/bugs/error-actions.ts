"use server";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { requirePlatformAdmin } from "@/lib/platform-admin";

/** One row of the error sink (error_events, 0399), as Bug Watch shows it: the FIRST sighting's
 *  payload is kept, a repeat only bumps the count and overwrites `last_payload`, and a fixed one that
 *  returns comes back as new. `org` is the company's name for a platform admin, null for a failure
 *  that belongs to no company (a cron, the layout) — and null to anyone else, who never sees a row. */
export type ErrorEvent = {
  id: string;
  title: string;
  /** Where it was caught: the `where` the sink was handed ("app-layout:bug-count"). */
  culprit: string;
  level: string;
  status: string;
  event_count: number;
  first_seen: string;
  last_seen: string;
  org: string | null;
  payload: unknown;
  last_payload: unknown;
};

const ERROR_COLUMNS = "id, title, culprit, level, status, event_count, first_seen, last_seen, org_id, payload, last_payload";

/** PostgREST's row cap: the open read asks for exactly this many, and when exactly this many come
 *  back the page says the list may be cut. */
export const OPEN_ERRORS_LIMIT = 1000;
/** The closed-and-trace read: the newest 300 by last sighting, as the whole list used to be. */
export const REST_ERRORS_LIMIT = 300;
/** The rest, as PostgREST's `or` filter spells it: closed rows (fixed, ignored) or trace rows of any status. */
export const REST_ERRORS_FILTER = "status.in.(fixed,ignored),level.eq.trace";
/** The company's name when platform_org_label could not answer (N4): said, never a silent null. */
export const UNKNOWN_COMPANY = "Unknown Company";

/** Every company's caught failures, newest repeat first, for North's own team (cn-v1136: the sink
 *  triages itself on Bug Watch). Platform-admin gated in the app layer (belt) over the RLS read
 *  policy error_events_platform_read (suspenders, 0399); the viewer's own client does the read.
 *
 *  TWO READS (skeptic #42, S4): one list of the newest 300 let trace rows (one per voice turn, kept
 *  fourteen days) crowd an old open error off the page while the badge, an exact head count, still
 *  counted it. So (1) the OPEN non-trace rows — new or triaged, level not trace — up to PostgREST's
 *  cap of 1,000, newest sighting first (`openCapped` says when exactly that many came back, and the
 *  page says it); (2) the REST — fixed or ignored, or any trace — the newest 300. The New tab's
 *  count is then the badge's error half: open non-trace rows at new.
 *
 *  A FAILED READ IS NOT AN EMPTY LIST (cn-v1130's rule): either read's error rides beside empty rows
 *  so the page can say it; the gate's nothing stays a plain nothing (error null), like the reports.
 *  A company's label that could not be read is filed and said as "Unknown Company" (N4). */
export async function listErrorEvents(): Promise<{ rows: ErrorEvent[]; error: string | null; openCapped: boolean }> {
  const ctx = await requirePlatformAdmin();
  if ("error" in ctx) return { rows: [], error: null, openCapped: false };
  const supabase = ctx.supabase;
  const [open, rest] = await Promise.all([
    supabase
      .from("error_events")
      .select(ERROR_COLUMNS)
      .in("status", ["new", "triaged"])
      .neq("level", "trace")
      .order("last_seen", { ascending: false })
      .limit(OPEN_ERRORS_LIMIT),
    supabase
      .from("error_events")
      .select(ERROR_COLUMNS)
      .or(REST_ERRORS_FILTER)
      .order("last_seen", { ascending: false })
      .limit(REST_ERRORS_LIMIT),
  ]);
  if (open.error) return { rows: [], error: dbError(open.error), openCapped: false };
  if (rest.error) return { rows: [], error: dbError(rest.error), openCapped: false };
  const openRows = (open.data ?? []) as any[];
  // The two reads cannot overlap (open is status new/triaged AND not trace; rest is closed OR trace),
  // but a row is a row once: keyed by id in case the database's answer ever says otherwise.
  const byId = new Map<string, any>();
  for (const r of [...openRows, ...((rest.data ?? []) as any[])]) if (!byId.has(r.id)) byId.set(r.id, r);
  const rows = [...byId.values()];

  // Company labels, for a platform admin only: platform_org_label (0176) returns the NAME and nothing
  // else, and null to everyone else. One round trip per distinct company on the page; a row with no
  // company (a cron's, the layout's) keeps null; a label the RPC could not give is filed and said.
  const orgIds = [...new Set(rows.map((r) => r.org_id).filter(Boolean))] as string[];
  const orgNames = new Map<string, string>();
  for (const id of orgIds) {
    const { data: label, error: labelErr } = await supabase.rpc("platform_org_label", { p_org: id });
    if (labelErr) {
      reportError("bug-watch:org-label", labelErr, { orgId: id });
      orgNames.set(id, UNKNOWN_COMPANY);
    } else if (label) orgNames.set(id, label as string);
  }

  return {
    openCapped: openRows.length >= OPEN_ERRORS_LIMIT,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title ?? "",
      culprit: r.culprit ?? "",
      level: r.level ?? "error",
      status: r.status ?? "new",
      event_count: typeof r.event_count === "number" ? r.event_count : 1,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      org: r.org_id ? (orgNames.get(r.org_id) ?? null) : null,
      payload: r.payload ?? null,
      last_payload: r.last_payload ?? null,
    })),
    error: null,
  };
}

/** The four words the sink knows (0399's check): new → triaged → fixed | ignored, and back to new. */
const ERROR_STATUSES = new Set(["new", "triaged", "fixed", "ignored"]);

/** Mark one error. Writes are RPC-only (0399): platform_set_error_status is the one narrow door —
 *  status only, platform admins only — and answers false when the row is not there, which is said
 *  in words rather than reported as done (the silent-write law). */
export async function setErrorEventStatus(id: string, status: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requirePlatformAdmin();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ERROR_STATUSES.has(status)) return { ok: false, error: "Unknown status." };
  const { data, error } = await ctx.supabase.rpc("platform_set_error_status", { p_id: id, p_status: status });
  if (error) return { ok: false, error: dbError(error) };
  if (data === true) return { ok: true };
  return { ok: false, error: "That row isn't there any more." };
}
