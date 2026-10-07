"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { executeAction } from "@/lib/actions/execute";
import { formatCurrency } from "@/lib/utils";
import { billLabel, paperGapWords, planBillCorrection, purchaseCents, toCents } from "@/lib/bill-correction";

/** The bill being corrected, as its row already holds it. */
export type CorrectableBill = {
  id: string;
  supplier: string;
  amount: number;
  bill_number: string | null;
  /** The number the row prints, when the page worked one out (typed, stored, or read off the paper). */
  shownNumber?: string | null;
  bill_date?: string | null;
  /** Its lines, and those of the corrections already under it: what a credit may take back. */
  lines: { description: string | null; amount: number; billable?: boolean | null; category?: string | null }[];
  /** Corrections already attached under it, so the paper's total is compared with the whole purchase. */
  corrections?: { billNumber: string | null; amount: number }[];
};

type Row = { description: string; amount: number };

/**
 * THE SUPPLIER'S OWN PAPER, WHEN THE BOX OPENS FROM IT (task 2, 2026-10-07: the supplier card's
 * "maybe the same purchase at another price"): its number and total are the paper's and are not
 * typed again, and the server ties the correction to the document (supplierInvoiceId).
 */
export type PaperForCorrection = { paperNumber: string; paperTotal: number; paperDate?: string | null; supplierInvoiceId: string };

/**
 * CORRECT THIS BILL (0381). The supplier's later paper for a purchase already on the books: its
 * number, what it says the purchase comes to, and what the difference is for. It goes in as its own
 * bill UNDER this one, with its own lines, and the next invoice on the job carries it.
 *
 *   - Paper Total says, as it is typed, how far the paper is from the bill ("+$95.99 more than the
 *     bill" / "−$51.58 less: a credit").
 *   - More than the bill: one What Is It For? line, its amount left empty to take the whole
 *     difference, and Add Another Line for a paper that itemizes it.
 *   - Less than the bill (a credit): each line is picked from the bill's own lines, so the credit
 *     carries the words the return path matches and follows that line's billing switch.
 *   - The plan is lib/bill-correction's, run here too so a refusal is said before anything is sent;
 *     the server runs the same plan again before it writes.
 */
export function CorrectBillModal({
  bill,
  paper,
  onClose,
  onAttached,
}: {
  bill: CorrectableBill;
  /** Opened from the supplier's own document: its number and total pre-filled and held. */
  paper?: PaperForCorrection | null;
  onClose: () => void;
  /** Said once the correction landed (the card it opened from shows the sentence in its place). */
  onAttached?: (sentence: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [paperNumber, setPaperNumber] = useState(paper?.paperNumber ?? "");
  const [paperTotal, setPaperTotal] = useState(paper?.paperTotal ?? 0);
  const [paperDate, setPaperDate] = useState(paper?.paperDate ?? bill.bill_date ?? "");
  const [rows, setRows] = useState<Row[]>([{ description: "", amount: 0 }]);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const original = useMemo(
    // The bill's own typed number, the one the server's (and the database's) sentences name.
    () => ({ amount: bill.amount, billNumber: bill.bill_number, lines: bill.lines, corrections: bill.corrections ?? [] }),
    [bill],
  );
  const had = purchaseCents(original) / 100;
  const typedTotal = paperTotal > 0;
  const gapCents = typedTotal ? toCents(paperTotal) - purchaseCents(original) : 0;
  const credit = gapCents < 0;
  const label = String(bill.shownNumber ?? "").trim() || billLabel(original.billNumber);
  // The lines a credit may take back: every line with words, said with what it cost and whether the
  // customer was billed for it (a credit follows that switch).
  const pickable = bill.lines.filter((l) => String(l.description ?? "").trim());
  // What a line with no amount will take: the difference less the lines that have one.
  const leftCents = gapCents - rows.reduce((s, r) => s + (r.amount ? toCents(credit ? -r.amount : r.amount) : 0), 0);

  // Opened from the paper, the number and total are its own: only what a person typed makes it dirty.
  const dirty = paper ? rows.some((r) => r.description.trim() || r.amount) : !!paperNumber.trim() || paperTotal > 0 || rows.some((r) => r.description.trim() || r.amount);
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function attach() {
    setError(null);
    // An empty amount takes what is left; a credit's amounts are typed as sizes and sent below zero.
    const lines = rows.map((r) => ({ description: r.description, amount: r.amount ? (credit ? -r.amount : r.amount) : null }));
    const plan = planBillCorrection({ original, paperTotal: typedTotal ? paperTotal : null, paperNumber, lines });
    if (!plan.ok) return setError(plan.error);
    start(async () => {
      const res = await executeAction("bill.correct", {
        bill_id: bill.id,
        paper_number: paperNumber.trim(),
        paper_total: paperTotal,
        bill_date: paperDate || null,
        lines,
        ...(paper ? { supplier_invoice_id: paper.supplierInvoiceId } : {}),
      });
      if (!res.ok) return setError(res.error ?? "The correction didn't attach. Try again.");
      const sentence = res.recorded ?? `${paperNumber.trim()} is attached under ${label}.`;
      setSaid(sentence);
      onAttached?.(sentence);
      router.refresh();
    });
  }

  if (said) {
    return (
      <Modal open onClose={onClose} title="Correct This Bill" footer={<ModalActions onCancel={onClose} onSave={onClose} saveLabel="Done" hideCancel />}>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-relaxed text-emerald-900" role="status">
          {said}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      dirty={dirty}
      title="Correct This Bill"
      footer={<ModalActions onCancel={onClose} onSave={attach} saving={pending} disabled={!paperNumber.trim() || !typedTotal} saveLabel="Attach Correction" />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          The supplier&apos;s later paper for this purchase. {bill.supplier} {label} is {formatCurrency(had)}
          {(bill.corrections ?? []).length ? " with what is already attached" : ""}. The difference goes in as its own bill under it, and the
          next invoice on the job carries it.
        </p>
        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="cb-number">Paper Number</Label>
            <Input id="cb-number" value={paperNumber} onChange={(e) => setPaperNumber(e.target.value)} autoFocus={!paper} readOnly={!!paper} />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="cb-date">Paper Date</Label>
            <Input id="cb-date" type="date" value={paperDate} onChange={(e) => setPaperDate(e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label htmlFor="cb-total">Paper Total</Label>
            {/* From the supplier's own document: read off it, not typed, so the row IS that paper. */}
            {paper ? (
              <Input id="cb-total" value={formatCurrency(paperTotal)} readOnly />
            ) : (
              <NumberInput id="cb-total" value={paperTotal} onValueChange={setPaperTotal} placeholder={had.toFixed(2)} />
            )}
            <p className={`mt-1 text-xs ${credit ? "text-sky-700" : "text-slate-500"}`}>
              {typedTotal ? paperGapWords(original, paperTotal) : "What the supplier's paper says the whole purchase comes to."}
              {paper ? " Read off the supplier's paper." : ""}
            </p>
          </div>
        </div>

        {typedTotal && gapCents !== 0 && (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_7rem] items-end gap-2">
                <div className="min-w-0">
                  <Label htmlFor={`cb-what-${i}`}>{credit ? "Which Line Comes Back?" : "What Is It For?"}</Label>
                  {credit ? (
                    <Select id={`cb-what-${i}`} className="h-11" value={r.description} onChange={(e) => setRow(i, { description: e.target.value })}>
                      <option value="">Pick A Line</option>
                      {pickable.map((l, k) => (
                        <option key={k} value={String(l.description ?? "").trim()}>
                          {String(l.description ?? "").trim()} · {formatCurrency(l.amount)}
                          {l.billable === false ? " · not billed to the customer" : ""}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input id={`cb-what-${i}`} value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} />
                  )}
                </div>
                <div>
                  <Label htmlFor={`cb-amt-${i}`}>{credit ? "Back" : "Amount"}</Label>
                  <NumberInput
                    id={`cb-amt-${i}`}
                    value={r.amount}
                    onValueChange={(n) => setRow(i, { amount: n })}
                    // EMPTY TAKES WHAT IS LEFT: the figure it would take is shown, never typed for him.
                    placeholder={!r.amount && leftCents !== 0 ? (Math.abs(leftCents) / 100).toFixed(2) : undefined}
                  />
                </div>
                {rows.length > 1 && (
                  <div className="col-span-2 -mt-1">
                    <Button type="button" variant="ghost" className="text-slate-500" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                      Remove This Line
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => setRows((rs) => [...rs, { description: "", amount: 0 }])}>
              Add Another Line
            </Button>
            <p className="text-xs text-slate-500">
              {credit
                ? "Each line is one the bill already has, so the credit gives back only what the customer was billed for it. An empty amount takes what is left."
                : "Itemize it the way the paper does. An empty amount takes what is left of the difference."}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
