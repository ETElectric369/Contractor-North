import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { computeOwnerMoney, notCountedLine, readOwnerMoneyInputs, type OwnerMoney } from "@/lib/analytics/owner-money";
import { pnlRow, profitAndLoss } from "@/lib/analytics/profit-and-loss";
import {
  OWNER_HIDDEN_NOTE,
  OWNER_HIDDEN_WHY,
  PERIOD_KINDS,
  TAB_NAMES,
  accountantFileName,
  accountantReadSpan,
  beforeRecordsLine,
  defaultAccountantPeriod,
  lastDayShown,
  parseAccountantPeriod,
  periodChoices,
  periodContaining,
  periodWindow,
  type AccountantPeriodKind,
} from "@/lib/accountant-workbook";
import { AccountantDownload } from "./accountant-download";
import { AccountantPeriodPicker, AccountantPeriodScope } from "./period-picker";
import { accountantPageViewer } from "./viewer";

export const dynamic = "force-dynamic";

const isKind = (v: unknown): v is AccountantPeriodKind => v === "month" || v === "quarter" || v === "year";

/**
 * FOR YOUR ACCOUNTANT: one download (approved 2026-09-27; accountant-workbook.ts).
 *
 * Pick a Month, a Quarter or a Year (whole months only: the money engine counts whole months, and a
 * mid-month day would quietly pull in the whole month). The page shows the two figures that matter,
 * the top and the bottom line of the Summary's profit and loss, Revenue and Net Profit (Owner's
 * Draw), by the profit and loss's own rows and words (profit-and-loss.ts), then one button, Download
 * For Your Accountant, and one small link, Same Thing As CSV Files. The Shop Stock page links here.
 *
 * OFFICE ONLY (requireStaff; a tech is sent to My Day). The totals follow the owner's switch: an
 * office viewer the owner hasn't shared Owner's Draw with sees no totals, and the file leaves them
 * and the owner's rows out too (the route checks again). The figures are read over the SAME span the
 * route reads (accountantReadSpan), so they are the file's to the cent.
 */
export default async function AccountantPage({ searchParams }: { searchParams: Promise<{ period?: string; kind?: string }> }) {
  const ctx = await requireStaff();
  if ("error" in ctx) redirect("/planner");
  const { supabase, orgId, userId } = ctx;
  if (!orgId) redirect("/planner");
  const { period: periodRaw, kind: kindRaw } = await searchParams;

  const [orgRead, meRead] = await Promise.all([
    supabase.from("organizations").select("name, settings").eq("id", orgId).maybeSingle(),
    supabase.from("profiles").select("role").eq("id", userId).maybeSingle(),
  ]);
  const org = orgRead.error ? null : (orgRead.data as { name?: string | null; settings?: unknown } | null);
  const settings = getOrgSettings(org?.settings);
  const tz = settings.timezone;
  const todayYmd = todayStrInTz(tz);
  const period =
    parseAccountantPeriod(periodRaw, todayYmd) ?? (isKind(kindRaw) ? periodContaining(kindRaw, todayYmd) : defaultAccountantPeriod(todayYmd));
  const { showOwner, why } = accountantPageViewer(orgRead, meRead);

  // The totals are read only for a viewer who may see them.
  let cur: OwnerMoney | null = null;
  let problem: string | null = null;
  // A period before North's records: "nothing in it" only when every figure is zero; otherwise the
  // figures, with the records-start line under them (a backdated receipt still counts).
  let beforeRecords: { text: string; nothing: boolean } | null = null;
  if (showOwner) {
    const read = await readOwnerMoneyInputs(supabase, accountantReadSpan(period), tz, todayYmd);
    if (read.inputs) {
      cur = computeOwnerMoney(read.inputs, periodWindow(period), tz, todayYmd);
      beforeRecords = beforeRecordsLine(period, read.inputs.recordsStart, cur.totals);
    } else problem = read.problem;
  }
  const figures = cur?.totals ?? null;
  // THE SUMMARY'S TOP AND BOTTOM LINES, by the profit and loss's own rows: the same words and cents.
  const pnl = figures ? profitAndLoss(figures) : [];
  const revenue = pnlRow(pnl, "revenue");
  const net = pnlRow(pnl, "net_profit");
  const recordsStart = (cur?.caveats.find((c) => c.kind === "records_start") as { date: string } | undefined)?.date ?? null;
  const notCounted = cur ? notCountedLine(cur) : null;
  const through = lastDayShown(period, todayYmd);
  const unfinished = period.end > todayYmd;
  const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  const href = (as: "xlsx" | "csv") => `/analytics/accountant/export?${new URLSearchParams({ period: period.key, as }).toString()}`;
  const segment = "inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg border px-3 text-sm font-medium";
  const kindLabel = PERIOD_KINDS.find((k) => k.kind === period.kind)?.label ?? "Period";

  return (
    <AccountantPeriodScope>
      <div className="mx-auto max-w-3xl">
        <PageHeader title="For Your Accountant" description="One spreadsheet for a month, a quarter or a year: what came in, what went out, who was paid, what's still open and what's in stock.">
          <Link
            href="/analytics"
            className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back To Analytics
          </Link>
        </PageHeader>

        <Card className="mb-4 p-4">
          <div className="mb-3 flex gap-2" role="group" aria-label="Period">
            {PERIOD_KINDS.map((k) => (
              <Link
                key={k.kind}
                href={`/analytics/accountant?kind=${k.kind}`}
                aria-current={period.kind === k.kind ? "true" : undefined}
                className={`${segment} ${period.kind === k.kind ? "border-transparent bg-brand text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
              >
                {k.label}
              </Link>
            ))}
          </div>
          {/* Keyed on the period: whatever changed it (a pick, a Month / Quarter / Year tap, Back), the picker shows it. */}
          <AccountantPeriodPicker
            key={period.key}
            current={period.key}
            kindLabel={kindLabel}
            choices={periodChoices(period.kind, todayYmd, period).map((p) => ({ key: p.key, label: p.label }))}
          />
        </Card>

        <Card className="mb-4 p-4">
          <h2 className="text-base font-semibold text-slate-900">
            {period.label}
            {recordsStart ? <span className="font-normal text-slate-500"> (records start {day(recordsStart)})</span> : null}
          </h2>
          <p className="text-xs text-slate-500">
            Cash basis: money counts on the day it came in or went out.{unfinished ? ` The period isn't over: figures run through ${day(through)}.` : ""}
          </p>
          {!showOwner && why === OWNER_HIDDEN_WHY ? (
            <div className="mt-3 text-sm text-slate-700">
              <p className="font-medium">{OWNER_HIDDEN_NOTE}</p>
              <p className="mt-1 text-xs text-slate-500">{why}</p>
            </div>
          ) : !showOwner ? (
            // A read failed: said as that, never as the owner's switch (the viewer may be the owner).
            <p role="alert" className="mt-3 text-sm text-amber-800">
              {why}
            </p>
          ) : !figures || !revenue || !net ? (
            <p role="alert" className="mt-3 text-sm text-amber-800">
              The figures couldn&apos;t be read just now{problem ? `: ${problem}` : ""}. Try again in a moment.
            </p>
          ) : beforeRecords?.nothing ? (
            <p className="mt-3 text-sm text-slate-700">{beforeRecords.text}</p>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-slate-500">{revenue.label}</div>
                  <div className="text-2xl font-bold tabular-nums text-slate-900">{formatCurrency(revenue.amount ?? 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">{net.label}</div>
                  <div className={`text-2xl font-bold tabular-nums ${(net.amount ?? 0) < 0 ? "text-red-700" : "text-slate-900"}`}>{formatCurrency(net.amount ?? 0)}</div>
                  <div className="text-xs text-slate-500">Before income tax.</div>
                </div>
              </div>
              {beforeRecords && <p className="mt-2 text-xs text-slate-500">{beforeRecords.text}</p>}
              {notCounted && <p className="mt-2 text-xs text-amber-800">{notCounted}</p>}
            </>
          )}
        </Card>

        <Card className="mb-4 p-4">
          {/* Keyed on the period too: a file kept for Save The File (or a line about it) belongs to the
              period it was made for, and a new period starts the card fresh. */}
          <AccountantDownload
            key={period.key}
            xlsxHref={href("xlsx")}
            csvHref={href("csv")}
            xlsxName={accountantFileName(org?.name, period, "xlsx")}
            csvName={accountantFileName(org?.name, period, "csv")}
          />
          <p className="mt-3 text-xs text-slate-500">
            {TAB_NAMES.length} tabs: {TAB_NAMES.join(", ")}. Open is as of the day you download it ({day(todayYmd)}). Stock is what was in stock on {day(through)}. Depreciation is
            your accountant&apos;s call.
          </p>
        </Card>
      </div>
    </AccountantPeriodScope>
  );
}
