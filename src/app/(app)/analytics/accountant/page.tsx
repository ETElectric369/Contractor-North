import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import { getOwnerMoneyViews } from "@/lib/analytics/owner-money";
import {
  NET_LABEL,
  OWNER_HIDDEN_NOTE,
  PERIOD_KINDS,
  TAB_NAMES,
  accountantFileName,
  defaultAccountantPeriod,
  lastDayShown,
  parseAccountantPeriod,
  periodChoices,
  periodContaining,
  periodWindow,
  type AccountantPeriodKind,
} from "@/lib/accountant-workbook";
import { AccountantDownload } from "./accountant-download";

export const dynamic = "force-dynamic";

const isKind = (v: unknown): v is AccountantPeriodKind => v === "month" || v === "quarter" || v === "year";

/**
 * FOR YOUR ACCOUNTANT: one download (approved 2026-09-27; accountant-workbook.ts).
 *
 * Pick a Month, a Quarter or a Year (whole months only: the money engine counts whole months, and a
 * mid-month day would quietly pull in the whole month). The page shows the two figures that matter,
 * Received and Net, then one button, Download For Your Accountant, and one small link, Same Thing As
 * CSV Files. The Shop Stock page links here.
 *
 * OFFICE ONLY (requireStaff; a tech is sent to My Day). Net follows the owner's switch: an office
 * viewer the owner hasn't shared Owner's Draw with sees Received only, and the file leaves Net and
 * the owner's rows out too (the route checks again).
 */
export default async function AccountantPage({ searchParams }: { searchParams: Promise<{ period?: string; kind?: string }> }) {
  const ctx = await requireStaff();
  if ("error" in ctx) redirect("/planner");
  const { supabase, orgId, userId } = ctx;
  if (!orgId) redirect("/planner");
  const { period: periodRaw, kind: kindRaw } = await searchParams;

  const [{ data: orgRow }, { data: me }] = await Promise.all([
    supabase.from("organizations").select("name, settings").eq("id", orgId).maybeSingle(),
    supabase.from("profiles").select("role").eq("id", userId).maybeSingle(),
  ]);
  const org = orgRow as { name?: string | null; settings?: unknown } | null;
  const settings = getOrgSettings(org?.settings);
  const tz = settings.timezone;
  const todayYmd = todayStrInTz(tz);
  const period =
    parseAccountantPeriod(periodRaw, todayYmd) ?? (isKind(kindRaw) ? periodContaining(kindRaw, todayYmd) : defaultAccountantPeriod(todayYmd));
  const showOwner = (me as { role?: string } | null)?.role === "owner" || settings.office_sees_owner_money;

  const { views, problem } = await getOwnerMoneyViews(supabase, [periodWindow(period)], tz, todayYmd);
  const figures = views?.[0]?.totals ?? null;
  const through = lastDayShown(period, todayYmd);
  const unfinished = period.end > todayYmd;
  const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  const href = (as: "xlsx" | "csv") => `/analytics/accountant/export?${new URLSearchParams({ period: period.key, as }).toString()}`;
  const segment = "inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg border px-3 text-sm font-medium";

  return (
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
        <form className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <Label htmlFor="acct-period">Which {PERIOD_KINDS.find((k) => k.kind === period.kind)?.label}</Label>
            <select
              id="acct-period"
              name="period"
              defaultValue={period.key}
              className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
            >
              {periodChoices(period.kind, todayYmd).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Show This Period
          </button>
        </form>
      </Card>

      <Card className="mb-4 p-4">
        <h2 className="text-base font-semibold text-slate-900">{period.label}</h2>
        <p className="text-xs text-slate-500">
          Cash basis: money counts on the day it came in or went out.{unfinished ? ` The period isn't over: figures run through ${day(through)}.` : ""}
        </p>
        {!figures ? (
          <p role="alert" className="mt-3 text-sm text-amber-800">
            The figures couldn&apos;t be read just now{problem ? `: ${problem}` : ""}. Try again in a moment.
          </p>
        ) : (
          <div className={`mt-3 grid gap-3 ${showOwner ? "grid-cols-2" : "grid-cols-1"}`}>
            <div>
              <div className="text-xs text-slate-500">Received</div>
              <div className="text-2xl font-bold tabular-nums text-slate-900">{formatCurrency(figures.received)}</div>
            </div>
            {showOwner && (
              <div>
                <div className="text-xs text-slate-500">{NET_LABEL}</div>
                <div className={`text-2xl font-bold tabular-nums ${figures.left < 0 ? "text-red-700" : "text-slate-900"}`}>{formatCurrency(figures.left)}</div>
              </div>
            )}
          </div>
        )}
        {!showOwner && (
          <p className="mt-2 text-xs text-slate-500">{OWNER_HIDDEN_NOTE}</p>
        )}
      </Card>

      <Card className="mb-4 p-4">
        <AccountantDownload
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
  );
}
