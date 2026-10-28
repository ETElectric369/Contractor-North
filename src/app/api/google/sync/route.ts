import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { syncOrgCalendars } from "@/lib/calendar-sync";
import { reportError } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";

export const runtime = "nodejs";
// Many calendars × paginated pulls can outlive the default 10s.
export const maxDuration = 300;

/**
 * The Google Calendar sync runner (Vercel Cron, every 15 min). For each org's
 * connection: pull the selected Google calendars into external_events
 * (incremental sync tokens; cn="1" echoes skipped) and run the backstop push
 * sweep of CN items changed since last_synced_at — the safety net for the
 * SQL-side schedule writes (customer pick-a-time confirm) and any live push
 * that failed transiently. Per-org failures are isolated: one org's expired
 * grant never blocks another's sync.
 *
 * Protected by CRON_SECRET (Vercel sends it automatically):
 *   GET /api/google/sync   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const result: Record<string, unknown> = { ok: true };
  try {
    const { data: conns, error } = await supabase
      .from("calendar_connections")
      .select("*")
      .eq("provider", "google");
    if (error) throw new Error(error.message);

    const orgs: unknown[] = [];
    for (const conn of conns ?? []) {
      try {
        orgs.push(await syncOrgCalendars(supabase, conn));
      } catch (e) {
        // syncOrgCalendars is internally fail-soft; this is the belt-and-suspenders.
        reportError("cron-gcal-sync-org", e, { orgId: conn.org_id });
        orgs.push({ org_id: conn.org_id, error: e instanceof Error ? e.message : "failed" });
      }
    }
    result.orgs = orgs;
  } catch (e: any) {
    result.ok = false;
    result.error = e?.message ?? "failed";
    // A blocker (cn-v1136): the connections could not be read, so no company synced; a per-company
    // failure above stays an error. WAITED FOR, and a 500 (skeptic #42 S6, skeptic #34's rule for
    // the other crons): this function answers on the tick it files, so a fire-and-forget write can
    // freeze with the response, and Vercel's cron log reads only the status.
    await reportBlockerAwaited("cron-gcal-sync", e);
    return NextResponse.json(result, { status: 500 });
  }

  return NextResponse.json(result);
}
