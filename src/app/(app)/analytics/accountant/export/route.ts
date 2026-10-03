import { deflateRawSync } from "node:zlib";
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { viewerSeesOwnerMoney } from "@/lib/bank-viewer";
import { featureOn } from "@/lib/features";
import { todayStrInTz, tzDayStartUtc, wallClockInTz } from "@/lib/tz";
import { readAllPages } from "@/lib/read-all-pages";
import { readAccountantInputs } from "@/lib/accountant-lists";
import { readOwnerMoneyInputs } from "@/lib/analytics/owner-money";
import { contentDisposition } from "@/lib/download-name";
import {
  ACCOUNTANT_PERIOD_INVOICE_COLS,
  accountantFileName,
  accountantReadSpan,
  buildAccountantWorkbook,
  parseAccountantPeriod,
  periodWindow,
  workbookCsvZip,
  workbookXlsx,
} from "@/lib/accountant-workbook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A refusal, in words, as plain text: the page's button reads it and says it on the card. */
const say = (words: string, status: number) =>
  new NextResponse(words, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));

/**
 * ONE DOWNLOAD FOR YOUR ACCOUNTANT. GET ?period=2026-09|2026-Q3|2026 [&as=xlsx|csv]
 *
 * The spreadsheet (as=xlsx, the default) or the same six tabs as a .zip of CSV files (as=csv), named
 * after the company and the period ("ET Electric 2026 Q3.xlsx"). See accountant-workbook.ts.
 *
 * STAFF ONLY, HERE: requireStaff is the refusal (a tech, a stranger, a deactivated seat get a 403 in
 * words and not one row read). THE TOTALS AND THE OWNER'S ROWS follow the owner's switch: an office
 * viewer the owner hasn't shared the owner's money with gets a file with no Revenue, no Total COGS, Gross
 * Profit or Total Overhead, no Net Profit, no Owner's Draw and none of the owner's own rows - including
 * his build time and its contra (analytics/page.tsx's rule).
 *
 * THE SIGNED-IN READER ONLY: readOwnerMoneyInputs names no company and relies on the database's
 * row rules, so it must never run through a service client. The other reads name the org_id too.
 *
 * NOTHING SILENT: any read that doesn't come back whole refuses the download in words. A file with
 * a quietly missing tab or a zero standing in for a failed read is never handed over. Downloads are
 * no longer recorded (0350's table stays, unused).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireStaff();
  if ("error" in ctx) return say(ctx.error ?? "This is for the office only.", 403);
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return say("Your sign-in isn't attached to a company.", 403);

  const sp = req.nextUrl.searchParams;
  const asRaw = sp.get("as") ?? "xlsx";
  if (asRaw !== "xlsx" && asRaw !== "csv") return say("Ask for the spreadsheet or the CSV files.", 400);
  const as: "xlsx" | "csv" = asRaw;

  const [orgRead, meRead] = await Promise.all([
    supabase.from("organizations").select("name, settings").eq("id", orgId).maybeSingle(),
    supabase.from("profiles").select("role").eq("id", userId).maybeSingle(),
  ]);
  const org = orgRead.data as { name?: string | null; settings?: unknown } | null;
  if (orgRead.error || !org) return say("Your company couldn't be read just now. Nothing was made; try again.", 503);
  if (meRead.error) return say("Your sign-in couldn't be checked just now. Nothing was made; try again.", 503);
  const settings = getOrgSettings(org.settings);
  const tz = settings.timezone;
  const todayYmd = todayStrInTz(tz);

  const period = parseAccountantPeriod(sp.get("period"), todayYmd);
  if (!period) return say("Pick a month, a quarter or a year that has already started.", 400);
  // WHO GETS THE OWNER'S BOTTOM LINE IN THE FILE: the one rule (bank-viewer.ts), the same function
  // the page's viewer and every bank door ask. This route used to spell the condition out itself.
  const showOwner = viewerSeesOwnerMoney((meRead.data as { role?: string } | null)?.role, settings.office_sees_owner_money);
  const salesTaxOn = featureOn(settings.features, "sales_tax");

  const win = periodWindow(period);
  // The page reads this same span, so its figures are the file's to the cent.
  const span = accountantReadSpan(period);
  const startIso = tzDayStartUtc(win.start, tz).toISOString();
  const endIso = tzDayStartUtc(win.end, tz).toISOString();

  const [money, lists, ar, periodInvoices, taxRates] = await Promise.all([
    readOwnerMoneyInputs(supabase, span, tz, todayYmd),
    readAccountantInputs(supabase, orgId),
    // What customers owe, as of today: every invoice sent and not paid (computeArAging's own rule
    // drops paid, void and draft; the read leaves them out first).
    readAllPages<any>((f, t) =>
      supabase
        .from("invoices")
        .select("id, customer_id, invoice_number, status, total, amount_paid, due_date, created_at, customers(name)")
        .eq("org_id", orgId)
        .not("status", "in", "(paid,void,draft)")
        .order("id")
        .range(f, t),
    ),
    // EVERY INVOICE MADE IN THE PERIOD, drafts and voids included, ALWAYS - not only when Sales Tax is
    // switched on. The workbook's Invoices Made In This Period list and its Sales Tax rows are both
    // built from these rows, so the two cannot disagree about a period's tax; with Sales Tax off a
    // company used to have no list of its own invoices in the file at all.
    readAllPages<any>((f, t) =>
      supabase
        .from("invoices")
        .select(ACCOUNTANT_PERIOD_INVOICE_COLS)
        .eq("org_id", orgId)
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .order("id")
        .range(f, t),
    ),
    salesTaxOn ? supabase.from("tax_rates").select("name, rate").eq("org_id", orgId).order("rate") : Promise.resolve(null),
  ]);
  if (!money.inputs) return say(`The money couldn't be read just now: ${money.problem ?? "a read didn't come back"}. Nothing was made; try again.`, 503);
  if (!lists.ok) return say(lists.error, 503);
  if (ar.error) return say("What customers owe couldn't be read just now. Nothing was made; try again.", 503);
  // NOTHING SILENT: a half-read list of invoices would hand over a period whose own invoices are quietly
  // missing, and with Sales Tax on it would take the tax figures down with it.
  if (periodInvoices.error) return say("The invoices of this period couldn't be read just now. Nothing was made; try again.", 503);
  if ((taxRates as { error?: unknown } | null)?.error) {
    return say("Sales tax couldn't be read just now. Nothing was made; try again.", 503);
  }

  const wb = buildAccountantWorkbook({
    company: org.name ?? null,
    period,
    tz,
    todayYmd,
    showOwner,
    money: money.inputs,
    lists: lists.inputs,
    shelf: lists.shelf,
    arInvoices: ar.rows,
    periodInvoices: periodInvoices.rows,
    salesTax: salesTaxOn ? { taxRates: ((taxRates as { data?: any[] } | null)?.data ?? []) as any[] } : null,
  });
  // Stamped on the company's own clock: an unzipper reads a zip's time as local time.
  const modified = wallClockInTz(tz);
  const bytes = as === "xlsx" ? workbookXlsx(wb, { deflate, modified }) : workbookCsvZip(wb, { deflate, modified });
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": as === "xlsx" ? XLSX_TYPE : "application/zip",
      "content-disposition": contentDisposition(accountantFileName(org.name, period, as)),
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    },
  });
}
