import Link from "next/link";
import { Fold } from "@/components/why-fold";
import { fillText } from "@/lib/i18n";
import { ReopenLeadButton } from "./lead-doors";

/** The most Not Sold leads the fold lists; past it the fold says it was cut. */
export const NOT_SOLD_FOLD_CAP = 50;

export type NotSoldLine = { id: string; name: string; company_name: string | null; message: string | null };

/**
 * NOT SOLD, KEPT ON FILE (cn-v1170). Erik, 2026-11-19: "if they are Not Sold then the data stays with
 * them in that file for further sales reach out". Under the list, folded shut: each one opens its
 * file, and Reopen puts it back on the list. Drawn only when there is one, or when its read failed
 * (said inside it, never drawn as none).
 */
export function NotSoldFold({
  leads,
  cut,
  failed,
  t,
}: {
  leads: NotSoldLine[];
  /** More than NOT_SOLD_FOLD_CAP were on file. */
  cut: boolean;
  failed: boolean;
  t: (key: string) => string;
}) {
  if (!failed && leads.length === 0) return null;
  return (
    <Fold
      className="mt-6 rounded-xl border border-slate-200 bg-white px-4 py-1"
      summaryClassName="text-sm font-semibold text-slate-700"
      summary={failed ? t("ld_btn_markLost") : fillText(t("ld_btn_notSoldFold"), { n: String(leads.length) })}
    >
      {failed ? (
        <p role="status" className="pb-3 text-xs text-amber-700">
          {t("ld_notSoldUnread")}
        </p>
      ) : (
        <>
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
                <ReopenLeadButton id={l.id} />
              </li>
            ))}
          </ul>
          {cut && <p className="pb-3 text-xs text-slate-500">{fillText(t("ld_notSoldCut"), { n: String(NOT_SOLD_FOLD_CAP) })}</p>}
        </>
      )}
    </Fold>
  );
}
