import Link from "next/link";
import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { formatCurrency } from "@/lib/utils";
import { isMissingShelf } from "@/lib/job-cost";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ACCOUNTANT_LISTS, accountantList, dataRowCount, parseWindow, readAccountantInputs, toolsBilledList, type CsvTable } from "@/lib/accountant-lists";

export const dynamic = "force-dynamic";

/**
 * EXPORT FOR ACCOUNTANT (Shop Stock, Phase 4). One page: a date range and four Download CSV buttons,
 * each showing how many rows and what they add up to before anyone taps it. Below, for the office
 * only, the tools already billed to customers: listed, never changed.
 *
 * OFFICE ONLY (requireStaff; a tech is sent to My Day). The downloads themselves are the route next
 * to this page, which checks again. The app does no depreciation math: "Depreciation is your
 * accountant's call." is the whole of its advice.
 */
export default async function AccountantPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await requireStaff();
  if ("error" in ctx) redirect("/planner");
  const { supabase, orgId } = ctx;
  if (!orgId) redirect("/planner");
  const { from, to } = await searchParams;

  const { data: orgRow } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  const tz = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone;
  const w = parseWindow(from, to, todayStrInTz(tz));

  const [read, exportsRead] = await Promise.all([
    readAccountantInputs(supabase, orgId),
    supabase.from("accountant_exports").select("list, from_at, to_at, row_count, created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(8),
  ]);
  const remembered = !exportsRead.error || !(isMissingShelf(exportsRead.error) || /accountant_exports/.test(String(exportsRead.error.message ?? "")));
  const recent = (exportsRead.error ? [] : exportsRead.data ?? []) as { list: string; from_at: string | null; to_at: string; row_count: number; created_at: string }[];

  const q = (key: string) => `/analytics/accountant/export?${new URLSearchParams({ list: key, from: w.from, to: w.to }).toString()}`;
  const sumCol = (t: CsvTable, col: number) => {
    const total = t.rows.find((r) => r[0] === "Total");
    return total && typeof total[col] === "number" ? (total[col] as number) : 0;
  };
  const moneyCol: Record<string, number> = { stock_bought: 4, stock_used: 4, on_hand: 3, tools: 4 };
  const day = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}/${ymd.slice(0, 4)}`;
  const billed = read.ok ? toolsBilledList(read.inputs, tz) : null;
  const titleOf = (k: string) => ACCOUNTANT_LISTS.find((l) => l.key === k)?.title ?? k;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Export For Accountant" description="Plain lists your accountant can open in a spreadsheet: shop stock, and tools.">
        <Link
          href="/analytics"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back To Analytics
        </Link>
      </PageHeader>

      <Card className="mb-4 p-4">
        <form className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="acct-from">From</Label>
            <Input id="acct-from" type="date" name="from" defaultValue={w.from} className="h-11" />
          </div>
          <div>
            <Label htmlFor="acct-to">To</Label>
            <Input id="acct-to" type="date" name="to" defaultValue={w.to} className="h-11" />
          </div>
          <button type="submit" className="inline-flex min-h-[44px] items-center rounded-lg bg-brand px-4 text-sm font-medium text-white">
            Show These Dates
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          {day(w.from)} to {day(w.to)}. On Hand is what was on the shelf at the end of {day(w.to)}.
        </p>
      </Card>

      {!read.ok ? (
        <Card className="mb-4 p-4">
          <p className="text-sm text-amber-800">{read.error}</p>
        </Card>
      ) : (
        <div className="mb-4 space-y-3">
          {ACCOUNTANT_LISTS.map((l) => {
            const t = accountantList(l.key, read.inputs, w, tz);
            const n = dataRowCount(t);
            return (
              <Card key={l.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900">{l.title}</h2>
                  <p className="text-sm text-slate-500">{l.says}</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {n === 0 ? "Nothing in these dates." : `${n} ${n === 1 ? "row" : "rows"}, ${formatCurrency(sumCol(t, moneyCol[l.key]))} at cost.`}
                    {!read.shelf && l.key !== "tools" ? " The shelf isn't switched on for this database yet." : ""}
                  </p>
                </div>
                <a
                  href={q(l.key)}
                  download
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Download className="h-4 w-4" /> Download CSV
                </a>
              </Card>
            );
          })}
          <p className="text-sm font-medium text-slate-700">Depreciation is your accountant&apos;s call.</p>
          <p className="text-xs text-slate-500">
            {remembered
              ? "Every download is remembered. A write-off, a return or a count that went out in a Stock Used or On Hand download stays as it is; Count It puts things right from today."
              : "Downloads aren't remembered yet (one database update, 0350, isn't applied), so a write-off can still be undone after it went to your accountant."}
          </p>
        </div>
      )}

      {billed && (
        <Card className="mb-4 p-4">
          <h2 className="text-base font-semibold text-slate-900">Tools Billed To Customers</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            For you, not the accountant: tools on a job&apos;s receipt that the customer was billed for. Listed only; nothing here changes them.
          </p>
          {billed.rows.length === 0 ? (
            <p className="mt-2 text-sm text-slate-400">None.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {billed.rows.map((r, i) => (
                <li key={i} className="px-3 py-2 text-sm">
                  <p className="font-medium text-slate-900">{String(r[4] ?? "")}</p>
                  <p className="text-xs text-slate-500">
                    {[r[0] ? day(String(r[0])) : null, r[1], r[2] ? `${r[2]}${r[3] ? ` ${r[3]}` : ""}` : r[3], `${formatCurrency(Number(r[5]) || 0)} at cost`, String(r[6] ?? "")]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {recent.length > 0 && (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-slate-900">Recent Downloads</h2>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {recent.map((e, i) => (
              <li key={i}>
                {titleOf(e.list)}, {e.row_count} {e.row_count === 1 ? "row" : "rows"}, downloaded {day(todayStrInTz(tz, new Date(e.created_at)))}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
