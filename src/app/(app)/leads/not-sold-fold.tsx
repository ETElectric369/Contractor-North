import Link from "next/link";
import { Fold } from "@/components/why-fold";
import { fillText } from "@/lib/i18n";
import { ReopenLeadButton } from "./lead-doors";

/** The most Not Sold leads the fold lists; past it the fold says it was cut. */
export const NOT_SOLD_FOLD_CAP = 50;

export type NotSoldLine = {
  id: string;
  name: string;
  company_name: string | null;
  message: string | null;
  /** Not Sold by its estimate (cn-v1172): a read, never a stamp. No Reopen: the way back is the estimate. */
  byEstimate?: boolean;
};

/**
 * NOT SOLD, KEPT ON FILE (cn-v1170). Erik, 2026-11-19: "if they are Not Sold then the data stays with
 * them in that file for further sales reach out". Under the list, folded shut: each one opens its
 * file, and Reopen puts it back on the list. Drawn only when there is one, or when its read failed
 * (said inside it, never drawn as none).
 *
 * TWO KINDS, ONE COUNT (cn-v1172). After the leads marked Not Sold by hand come the leads whose
 * estimate ended without a sale, declined or expired (lib/leads/not-sold-by-estimate). Such a row says
 * "Estimate Not Sold" in plain slate where Reopen would be (one word for an ending, Not Sold), and has
 * no Reopen: the lead was never marked, so the way back is on its estimate (set it back to Sent, or
 * write a new one for the lead or its customer), and the row leaves by itself.
 *
 * `estimatesFailed` (cn-v1172 fixer): the estimates' part could not be read. The hand-marked rows are
 * still drawn, with one line saying the rest could not be read; `failed` is the hand-marked read's own
 * failure, and only that one draws the whole fold as failed.
 */
export function NotSoldFold({
  leads,
  cut,
  failed,
  estimatesFailed = false,
  t,
}: {
  leads: NotSoldLine[];
  /** More than NOT_SOLD_FOLD_CAP were on file. */
  cut: boolean;
  failed: boolean;
  /** The leads Not Sold by their estimate could not be read; the hand-marked ones were. */
  estimatesFailed?: boolean;
  t: (key: string) => string;
}) {
  if (!failed && !estimatesFailed && leads.length === 0) return null;
  return (
    <Fold
      className="mt-6 rounded-xl border border-slate-200 bg-white px-4 py-1"
      summaryClassName="text-sm font-semibold text-slate-700"
      // A count is said only when it is whole: with the estimates' part unread it would be short.
      summary={failed || estimatesFailed ? t("ld_btn_markLost") : fillText(t("ld_btn_notSoldFold"), { n: String(leads.length) })}
    >
      {failed ? (
        <p role="status" className="pb-3 text-xs text-amber-700">
          {t("ld_notSoldUnread")}
        </p>
      ) : (
        <>
          {leads.length > 0 && (
            <ul className="divide-y divide-slate-100 pb-2">
              {leads.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Link href={`/leads/${l.id}`} className="inline-flex min-h-11 items-center font-medium text-slate-900 hover:text-brand hover:underline">
                        {l.name}
                      </Link>
                      {l.company_name && <span className="text-xs text-slate-500">{l.company_name}</span>}
                    </div>
                    {l.message && <p className="truncate text-xs text-slate-500">{l.message}</p>}
                  </div>
                  {l.byEstimate ? (
                    <span className="text-xs font-medium text-slate-500" data-by-estimate="">
                      {t("ld_notSoldByEstimate")}
                    </span>
                  ) : (
                    <ReopenLeadButton id={l.id} />
                )}
              </li>
            ))}
          </ul>
          )}
          {estimatesFailed && (
            <p role="status" className="pb-3 text-xs text-amber-700" data-estimates-unread="">
              {t("ld_notSoldByEstimateUnread")}
            </p>
          )}
          {cut && <p className="pb-3 text-xs text-slate-500">{fillText(t("ld_notSoldCut"), { n: String(NOT_SOLD_FOLD_CAP) })}</p>}
        </>
      )}
    </Fold>
  );
}
