"use client";

import { useTransition } from "react";
import { useToast } from "@/components/toast";
import { groupInvoiceLines, LINE_KIND_LABEL, PICKABLE_LINE_KINDS, storedLineKind, type PickableLineKind } from "@/lib/invoice-math";
import type { InvoiceItem } from "@/lib/types";
import { setInvoiceItemKind } from "../actions";

/** Where the customer's Cost Breakdown files this line today: the one reading every document makes. */
export function lineKindNow(item: Pick<InvoiceItem, "description" | "line_total" | "import_source" | "unit" | "line_kind">): PickableLineKind | "credit" {
  const g = groupInvoiceLines([item]);
  if (g.credits.lines.length) return "credit";
  if (g.labor.lines.length) return "labor";
  if (g.materials.lines.length) return "materials";
  return "other";
}

/**
 * THE KIND CHIP (Erik, INV-079: "Other instead of materials in invoice"; 0342).
 *
 * Three buttons on the line editor: Labor, Materials, Other. The lit one is where the customer's
 * Cost Breakdown files this line right now. When nobody has said (line_kind null) that is the
 * app's own reading (the import, then the words and unit) and the note says so; one tap says it for
 * good. The app suggests, a person decides. Saved on the tap, with a toast: no Save to forget.
 * Classification only: the words, amount and order of the line never move.
 */
export function LineKindChips({
  item,
  invoiceId,
  disabled,
  onDone,
}: {
  item: InvoiceItem;
  invoiceId: string;
  disabled?: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const src = item.import_source ?? null;
  // The draw's own credit and milestone lines are locked, like every other write to them.
  if (src === "draw_credit" || src === "milestone") return null;
  const said = storedLineKind(item.line_kind);
  const now = lineKindNow(item);

  const pick = (kind: PickableLineKind | null, undoing = false) =>
    start(async () => {
      const res = await setInvoiceItemKind(item.id, invoiceId, kind);
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't file that line — try again.", "error");
        return;
      }
      // THE UNDO TRAIL: one tap back to what it was (nothing to Save, so nothing else to undo).
      const was = said === "credit" ? undefined : said;
      toast(
        res.message ?? "Saved",
        "success",
        undoing || was === undefined ? undefined : { label: "Undo", onClick: () => pick(was, true) },
      );
      onDone();
    });

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="What this line is">
        <span className="text-xs font-medium text-slate-500">Kind</span>
        {PICKABLE_LINE_KINDS.map((k) => {
          const on = now === k;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => (said === k ? undefined : pick(k))}
              disabled={disabled || pending}
              className={`min-h-[44px] rounded-lg border px-3 text-sm font-medium disabled:opacity-50 ${
                on ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:border-brand hover:text-brand"
              }`}
            >
              {LINE_KIND_LABEL[k]}
            </button>
          );
        })}
        {said && (
          <button
            type="button"
            onClick={() => pick(null)}
            disabled={disabled || pending}
            className="min-h-[44px] rounded-lg px-2 text-xs font-medium text-slate-500 hover:text-brand disabled:opacity-50"
          >
            Read It From The Line
          </button>
        )}
      </div>
      <p className="text-xs text-slate-400">
        {said
          ? `Filed under ${LINE_KIND_LABEL[said]} on the customer's breakdown.`
          : now === "credit"
            ? "Read from the line: a credit. Tap one to file it yourself."
            : `Read from the line: ${LINE_KIND_LABEL[now]}. Tap one to file it yourself.`}
      </p>
    </div>
  );
}
