"use client";

import { Button } from "@/components/ui/button";
import { SheetLink } from "@/components/row-more-sheet";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import type { CustomerMatch } from "@/lib/crm/duplicates";

/**
 * THE ONE ASK WHEN A PERSON IS ALREADY IN THE BOOK (cn-v1171). Every door that makes a customer asks
 * the one matcher first (lib/crm/duplicates findCustomerMatch, through crm/actions createCustomer),
 * and when it answers, nothing is made: this asks. The app suggests, the person decides: it never
 * attaches to the customer on file by itself, and it never makes a second one in silence.
 *
 *   `sentence` is the server's own ("Sam Tillery is already a customer (same phone).", in the
 *   reader's language), so the screen says exactly what the server found.
 *   The New Customer form gives no `onUse`: its first door is Open Their File, a link to the customer
 *   on file. A quick picker gives `onUse`: Use This Customer hands the customer on file to the same
 *   callback a newly made one goes to, so the estimate, invoice or job lands on them.
 *   Add Anyway sends the same typed person again with allow_duplicate=1; whoever draws this keeps the
 *   typed fields on screen while it shows.
 */
export function DuplicateCustomerAsk({
  match,
  sentence,
  onAddAnyway,
  onUse,
  pending = false,
  note = null,
}: {
  match: CustomerMatch;
  sentence: string;
  onAddAnyway: () => void;
  onUse?: (c: { id: string; name: string }) => void;
  pending?: boolean;
  /** One more line the screen owes the person about what Use This Customer does there, finished. */
  note?: string | null;
}) {
  const t = translator(useLang());
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2">
      <p className="text-sm text-slate-800">{sentence}</p>
      {note && <p className="text-xs text-slate-600">{note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {onUse ? (
          <Button type="button" size="sm" disabled={pending} onClick={() => onUse({ id: match.id, name: match.name })}>
            {t("cu_btn_useThisCustomer")}
          </Button>
        ) : (
          // Drawn inside an open Modal (New Customer): the sheet's own link, so the customer's page
          // replaces the Modal's history entry and Back is one tap (cn-v1171, skeptic #74).
          <SheetLink
            href={`/crm/${match.id}`}
            className="inline-flex min-h-11 items-center rounded-md bg-brand px-3 text-sm font-medium text-white hover:opacity-90"
          >
            {t("cu_btn_openTheirFile")}
          </SheetLink>
        )}
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onAddAnyway}>
          {t("cu_btn_addAnyway")}
        </Button>
      </div>
    </div>
  );
}
