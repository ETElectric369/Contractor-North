import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { isMissingShelf } from "@/lib/job-cost";
import { reportError } from "@/lib/observe";
import {
  ACCOUNTANT_LISTS,
  accountantList,
  dataRowCount,
  exportWindow,
  isAccountantListKey,
  parseWindow,
  readAccountantInputs,
  toCsv,
} from "@/lib/accountant-lists";

export const dynamic = "force-dynamic";

/**
 * EXPORT FOR ACCOUNTANT, ONE CSV (Shop Stock, Phase 4). GET ?list=stock_bought|stock_used|on_hand|tools
 * &from=YYYY-MM-DD&to=YYYY-MM-DD (the org's own days; On Hand is as of `to`).
 *
 * STAFF ONLY, HERE: requireStaff is the refusal (a tech, a stranger, a deactivated seat get a 403 and
 * no rows), and every read names the company's org_id on top of the tables' own staff-only rules.
 *
 * EVERY DOWNLOAD IS REMEMBERED (0350's accountant_exports), because a write-off the accountant
 * already has must not be quietly undone after. If the record can't be written, the file is not
 * handed over: a list the app doesn't know it gave out is exactly the silent drift this guards.
 * Before 0350 there is no record to write, and the page says downloads aren't remembered yet.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireStaff();
  if ("error" in ctx) return new NextResponse(ctx.error ?? "This is office-only.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  const { supabase, orgId } = ctx;
  if (!orgId) return new NextResponse("Your sign-in isn't attached to a company.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });

  const sp = req.nextUrl.searchParams;
  const key = sp.get("list");
  if (!isAccountantListKey(key)) return new NextResponse("Pick one of the four lists.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });

  const { data: orgRow } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  const tz = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone;
  const w = parseWindow(sp.get("from"), sp.get("to"), todayStrInTz(tz));

  const read = await readAccountantInputs(supabase, orgId);
  if (!read.ok) return new NextResponse(read.error, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  const table = accountantList(key, read.inputs, w, tz);

  const win = exportWindow(key, w, tz);
  const { error: recErr } = await supabase
    .from("accountant_exports")
    .insert({ org_id: orgId, list: key, from_at: win.from_at, to_at: win.to_at, row_count: dataRowCount(table) })
    .select("id");
  if (recErr && !isMissingShelf(recErr) && !/accountant_exports/.test(String(recErr.message ?? ""))) {
    reportError("accountant.export.record", recErr, { orgId, key });
    return new NextResponse("The download couldn't be recorded, so it wasn't made. Try again in a moment.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const meta = ACCOUNTANT_LISTS.find((l) => l.key === key)!;
  const name = key === "on_hand" ? `${meta.file}-${w.to}.csv` : `${meta.file}-${w.from}-to-${w.to}.csv`;
  return new NextResponse(toCsv(table), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
