import Link from "next/link";
import { Fold } from "@/components/why-fold";
import { fillText } from "@/lib/i18n";
import { InspectionRowMenu } from "./inspection-row-menu";
import type { FoldRow, ListRow } from "./list-rows";

/**
 * THE INSPECTIONS LIST (cn-v1171). The meeting's notes, 2026-11-19: a boxed "START INSPECTION", and
 * "Just a list of people/leads that Need Inspections". Each inspection is a card of its own with
 * space between, the Leads list's look (leads/inquiry-row). Everything here comes finished from the
 * page: who, where the name leads, the when, the state word, the boxed button and the ⋯'s moves.
 */

/** The row's one boxed button: the house's primary button, as a link on a 44px target. */
export const PRIMARY =
  "btn-gloss inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[rgb(var(--glass-ink))] px-4 text-sm font-medium text-white shadow-sm hover:bg-[rgb(var(--glass-ink))]/90";

export function InspectionList({ rows, tz }: { rows: readonly ListRow[]; tz: string }) {
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <InspectionCard key={row.id} row={row} tz={tz} />
      ))}
    </ul>
  );
}

/**
 * ONE INSPECTION. Line 1: who in bold, a link to their file when there is one (Erik: "on the
 * inspections page lets have just the lead which will be where all of their info is stored"), and the
 * when at the right. Line 2: what it is, and the state in a plain slate word (amber means a real
 * deadline in this app, and none of these is one). Then the boxed button and the ⋯.
 */
function InspectionCard({ row, tz }: { row: ListRow; tz: string }) {
  const name = "inline-flex min-h-11 min-w-0 items-center font-semibold text-slate-900 [overflow-wrap:anywhere]";
  return (
    <li data-row={row.id} data-state={row.state} className="flex flex-col gap-1.5 rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-x-3">
        {row.whoHref ? (
          <Link href={row.whoHref} className={`${name} hover:text-brand hover:underline`} data-who="">
            {row.who}
          </Link>
        ) : (
          <span className={name} data-who="">
            {row.who}
          </span>
        )}
        {row.edge && (
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-slate-600" data-edge="">
            {row.edge}
          </span>
        )}
      </div>
      {(row.what || row.stateWord) && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-slate-600">
          {row.what && <span data-what="">{row.what}</span>}
          {row.stateWord && (
            <span className="text-xs font-medium text-slate-500" data-state-word="">
              {row.stateWord}
            </span>
          )}
        </p>
      )}
      <div className="flex w-full flex-wrap items-center justify-end gap-2" data-doors="">
        <Link href={row.primary.href} className={PRIMARY} data-primary="">
          {row.primary.label}
        </Link>
        <InspectionRowMenu row={row} tz={tz} />
      </div>
    </li>
  );
}

/**
 * FILED UNDER NOBODY (cn-v1171). The page's Filed side is gone (Erik said yes: a finished inspection
 * is found in its person's file). The few with no lead, no customer and no job have no file, so they
 * wait here, folded shut, each opening its visit. Drawn only when there is one.
 */
export function FiledWithNobodyFold({ rows, t }: { rows: readonly FoldRow[]; t: (key: string) => string }) {
  if (rows.length === 0) return null;
  return (
    <Fold
      className="mt-6 rounded-xl border border-slate-200 bg-white px-4 py-1"
      summaryClassName="text-sm font-semibold text-slate-700"
      summary={fillText(t("ip_btn_notFiledFold"), { n: String(rows.length) })}
    >
      <p className="pb-1 text-xs text-slate-600">{t("ip_notFiledLine")}</p>
      <ul className="divide-y divide-slate-100 pb-2">
        {rows.map((r) => (
          <li key={r.id} data-fold-row={r.id}>
            <Link href={r.href} className="flex min-h-11 flex-wrap items-baseline gap-x-2 py-2 hover:text-brand">
              <span className="font-medium text-slate-900">{r.who}</span>
              {r.what && <span className="text-xs text-slate-600">{r.what}</span>}
              <span className="ml-auto text-xs tabular-nums text-slate-600" data-ending="">
                {[r.day, r.ending].filter(Boolean).join(" · ")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Fold>
  );
}
