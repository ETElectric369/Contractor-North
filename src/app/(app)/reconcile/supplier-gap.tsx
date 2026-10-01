import Link from "next/link";
import { Card } from "@/components/ui/card";
import { WhyFold } from "@/components/why-fold";
import { formatCurrency } from "@/lib/utils";
import { RECONCILE_KINDS } from "@/lib/reconcile-kinds";

/**
 * ONE SUPPLIER'S TWO RECORDS, DRAWN AGAINST EACH OTHER.
 *
 * Both figures are HANDED IN, already produced by lib/supplier-owed.ts: `theirs` is that account's
 * line out of `whatISupplierOwed` (their own open papers, to the cent, checkable against their
 * portal) and `ours` is `whatIBoughtNotSettled` over the papers the resolver placed on that account.
 * This file adds nothing up. It subtracts the two to say how far apart they are, and that is all.
 */
export interface SupplierGapRow {
  accountId: string;
  name: string;
  /** `whatISupplierOwed`'s line for this account, model `their-own-papers`. */
  theirs: number;
  /** `whatIBoughtNotSettled` over this account's own papers. */
  ours: number;
  /** How many of our tickets that is, so the row is never a bare number. */
  oursPapers: number;
}

/** How far apart one supplier's two records are. */
export const gapOf = (row: Pick<SupplierGapRow, "ours" | "theirs">): number =>
  Math.round(Math.abs((Number(row.ours) || 0) - (Number(row.theirs) || 0)) * 100) / 100;

/** THE ONE NUMBER THE PAGE LEADS WITH: every supplier's gap, added up. */
export const moneyInDispute = (rows: readonly SupplierGapRow[]): number =>
  Math.round((rows ?? []).reduce((sum, r) => sum + gapOf(r), 0) * 100) / 100;

/** The rows worth drawing: a supplier whose two records do not agree. Zero draws nothing. */
export const disagreeing = (rows: readonly SupplierGapRow[]): SupplierGapRow[] =>
  (rows ?? []).filter((r) => gapOf(r) > 0.005).sort((a, b) => gapOf(b) - gapOf(a) || a.name.localeCompare(b.name));

/**
 * TWO BARS, NOT TWO PARAGRAPHS (Erik's text-to-visual law: a schedule block shows planned against
 * actual, so a reconcile row shows ours against theirs). Both bars are scaled to the bigger of the
 * two, so the longer bar is always the bigger pile and the eye gets the answer before the words do.
 */
function Side({ label, amount, under, widest, tone }: { label: string; amount: number; under: string; widest: number; tone: "ours" | "theirs" }) {
  const pct = widest > 0.005 ? Math.max(2, Math.round((amount / widest) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-slate-600">{label}</span>
        <span className="shrink-0 font-semibold tabular-nums text-slate-900">{formatCurrency(amount)}</span>
      </div>
      <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone === "ours" ? "bg-slate-500" : "bg-brand"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-500">{under}</p>
    </div>
  );
}

/**
 * ── WHAT YOU BOUGHT, AND WHAT THEY SAY YOU OWE ───────────────────────────────────────────────
 *
 * The page's lead, and the one row on it that is READ-ONLY BY DESIGN. Erik's law: Reconcile never
 * owns a record and never becomes the only door. The figures belong to lib/supplier-owed.ts and the
 * place a payment is recorded or an account edited is the Suppliers card on /bills, so this section
 * carries no button — only a link to the screen that does.
 *
 * It replaces two apologetic paragraphs folded away inside that card ("that is your own paperwork,
 * not a bill from them, so it is a different number from the one above and neither is wrong"). The
 * paragraphs were true. A man between jobs cannot act on them.
 */
export function SupplierGap({
  rows,
  couldNotTotal,
  failed,
}: {
  rows: SupplierGapRow[];
  /** Accounts whose figure could not be totalled, by name. Nothing is left out silently. */
  couldNotTotal: { accountId: string; name: string }[];
  /** Which reads failed, by name, for the same reason. */
  failed: string[];
}) {
  const def = RECONCILE_KINDS["supplier-gap"];
  const live = disagreeing(rows);
  if (!live.length && !couldNotTotal.length && !failed.length) return null;
  const total = moneyInDispute(live);

  return (
    <Card id={def.anchor} className="mb-6 scroll-mt-20 p-4">
      <h2 className="text-base font-semibold text-slate-900">
        {def.heading}
        {live.length > 0 ? ` · ${live.length} ${live.length === 1 ? "Supplier" : "Suppliers"}` : ""}
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {live.length > 0
          ? `${formatCurrency(total)} between what your tickets say and what their own papers say.`
          : "Nothing to compare just now."}
      </p>
      <WhyFold>
        <p>
          {def.ours}, against {def.theirs.toLowerCase()}. Both are right about their own side: theirs is a bill
          they have sent, yours is paper you brought back from the counter. Where they differ, something is on one
          book and not the other.
        </p>
        <p>
          Nothing on this section changes anything. You record a payment, edit an account or file one of their papers
          on the Suppliers card on Bills, which is where those live.
        </p>
      </WhyFold>

      {failed.length > 0 && (
        <p className="mt-2 text-sm text-amber-800" role="alert">
          Couldn&apos;t read {failed.join(", ")} just now, so these figures may be short. Reload the page to try again.
        </p>
      )}

      <div className="mt-3 space-y-3">
        {live.map((r) => {
          const gap = gapOf(r);
          const widest = Math.max(r.ours, r.theirs);
          const weHaveMore = r.ours > r.theirs;
          return (
            <div key={r.accountId || r.name} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900">{r.name}</h3>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-amber-800">
                  {formatCurrency(gap)} Apart
                </span>
              </div>
              <div className="space-y-2.5">
                <Side
                  label="Your Tickets"
                  amount={r.ours}
                  under={`${r.oursPapers} ${r.oursPapers === 1 ? "bill" : "bills"} bought on account and not squared up yet`}
                  widest={widest}
                  tone="ours"
                />
                <Side
                  label={`${r.name} Says`}
                  amount={r.theirs}
                  under="What their own papers still have open"
                  widest={widest}
                  tone="theirs"
                />
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {weHaveMore
                  ? `${formatCurrency(gap)} of your tickets is not on their open papers — either they have not billed it yet, or a paper of theirs already covers it and is not matched up.`
                  : `They say ${formatCurrency(gap)} more than your own bills do — a purchase of theirs is not in your books yet.`}
              </p>
              {r.accountId && (
                <Link
                  href={`/bills#supplier-invoices-${r.accountId}`}
                  className="mt-1 flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
                >
                  {`Open ${r.name} On Bills`}
                </Link>
              )}
            </div>
          );
        })}
      </div>

      {couldNotTotal.length > 0 && (
        <p className="mt-3 text-sm text-amber-800" role="alert">
          {couldNotTotal.map((a) => a.name).join(", ")} {couldNotTotal.length === 1 ? "could not be totalled" : "could not be totalled"} just
          now, so {couldNotTotal.length === 1 ? "it is" : "they are"} not compared here. Reload the page to try again.
        </p>
      )}
    </Card>
  );
}
