import Link from "next/link";
import { Tags, ArrowUpRight } from "lucide-react";

/**
 * THE PRICE LIST, FROM SETTINGS — a door and an explanation, not a second editor.
 *
 * Erik: "make a price list setting page." The list itself already has a real home at /price-list
 * with search, import and per-item editing; a second editor here would be two places to change one
 * number, which is how a book and a quote start disagreeing.
 *
 * What genuinely belongs in Settings is the part that ISN'T the list: WHICH MARKUP GOVERNS IT. That
 * is the thing that cost two people a day. Andrew filed "Default markup under Settings is set to
 * 20%, but that default is not transferring over to the Price List and Kits pages" — he had set
 * Materials markup and left the price-list one at 0, an entirely reasonable reading of two adjacent
 * boxes both labelled "markup". Erik hit the same edge from the other side: items on an estimate
 * "looked like price list numbers not marked up."
 *
 * So this pane states the rule in the order it actually resolves, next to the live numbers, with
 * one tap through to the list. cn-v687 renamed the fields; this explains what they do to each other.
 */
export function PriceListCard({
  itemCount,
  unpricedCount,
  noMarkupCount,
  defaultMarkupPct,
  levels,
}: {
  itemCount: number;
  /** Rows with a buy price of 0 — they quote at nothing whatever the markup says. */
  unpricedCount: number;
  /** Rows whose own markup_pct is 0, i.e. the ones the org default has to carry. */
  noMarkupCount: number;
  defaultMarkupPct: number;
  levels: { name: string; markup_pct: number }[];
}) {
  const orgDefaultDoesTheWork = noMarkupCount > 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/price-list"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[rgb(var(--glass-ink))] px-4 text-sm font-medium text-white hover:opacity-90"
        >
          <Tags className="h-4 w-4" /> Open the price list
          <ArrowUpRight className="h-4 w-4 opacity-70" />
        </Link>
        <span className="text-sm text-slate-500">
          {itemCount.toLocaleString()} item{itemCount === 1 ? "" : "s"}
        </span>
      </div>

      {/* THE RULE, in resolution order. Reading it top-to-bottom answers "why did this quote at
          cost?" without anyone having to open three screens to find out. */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          What a price-list item sells for
        </div>
        <ol className="mt-2 space-y-1.5 text-sm text-slate-700">
          <li>
            <span className="font-medium">1.</span> The customer&rsquo;s pricing level, if they have one —{" "}
            {levels.length ? (
              levels.map((l, i) => (
                <span key={l.name}>
                  {i > 0 ? ", " : ""}
                  <span className="font-medium">{l.name} {Number(l.markup_pct)}%</span>
                </span>
              ))
            ) : (
              <span className="text-slate-400">you have none set up</span>
            )}
            .
          </li>
          <li>
            <span className="font-medium">2.</span> Otherwise the item&rsquo;s own markup, when it has one.
          </li>
          <li>
            <span className="font-medium">3.</span> Otherwise your default —{" "}
            <span className="font-medium">{defaultMarkupPct}%</span> on price-list items.
          </li>
        </ol>
        <p className="mt-2 text-xs text-slate-500">
          Set on this page under <span className="font-medium">Markup on price-list items</span>. The other
          box, <span className="font-medium">Markup on job materials</span>, is a different number for a
          different moment — receipts and costs you bill on a job.
        </p>
      </div>

      {/* THE TWO WAYS A BOOK QUOTES WRONG, counted rather than described. Erik's book is a raw CED
          parts import: 152 rows, markup 0 on every one — so his org default is doing all the work
          and a 0 there means every material quotes at his net cost. */}
      {(orgDefaultDoesTheWork || unpricedCount > 0) && (
        <div className="space-y-2">
          {orgDefaultDoesTheWork && (
            <p
              className={`rounded-lg px-3 py-2 text-sm ${
                defaultMarkupPct > 0 ? "bg-slate-50 text-slate-600" : "bg-amber-50 text-amber-900"
              }`}
            >
              <span className="font-medium">{noMarkupCount.toLocaleString()}</span> item
              {noMarkupCount === 1 ? " has" : "s have"} no markup of their own, so your{" "}
              <span className="font-medium">{defaultMarkupPct}%</span> default is what prices them.
              {defaultMarkupPct === 0 && " At 0% they quote at exactly what you paid."}
            </p>
          )}
          {unpricedCount > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span className="font-medium">{unpricedCount.toLocaleString()}</span> item
              {unpricedCount === 1 ? " has" : "s have"} no buy price. Those quote at $0 no matter what
              the markup is — a scope you price on site is meant to sit at $0, an import that lost its
              cost is not.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
