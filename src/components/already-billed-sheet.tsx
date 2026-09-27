"use client";

/**
 * ALREADY BILLED: THE SHEET AND ITS DOORS (Erik, 2026-09-26, Purple Sage: "i have a bill for purple
 * sage that was already charged and i have no way to associate it to the paid invoice becuase i did
 * it manually and that will happen for people i assure you").
 *
 *   Already Billed          a Not Billed Yet row (a receipt, an order, a take) or the open hours;
 *                           a supplier paper's card (filed first) and the bill's own row on /bills;
 *                           a shift on NO job (jobId null: the lines of invoices with no job)
 *   Not Billed After All    a row a person marked, in the Billed fold: only that comes back off
 *
 * The sheet asks "Which line already charged for this?", lists only the lines that can hold it
 * (lib/already-billed: sent bills, lines typed or changed by hand, never a credit or a lump), beside
 * what the cost was, and presses Mark Billed On INV-x. For hours it lists the open shifts and ticks
 * only the line's own person's, up to the day the bill was written. For a receipt that cost more than
 * the line (Purple Sage: $110 against $186.93) with Shop Stock on, it first asks "Did J-010 Use All Of
 * It?": No opens the receipt's own card so the rest goes on the shelf, then comes back to Mark.
 *
 * Nothing on the bill changes: the toast says so, with Undo. Every button is 44px and Title Case.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDateShort } from "@/lib/utils";
import {
  askUsedAll,
  hoursCompareWords,
  hoursOf,
  lineHours,
  lineLabel,
  precheckHours,
  tickTogether,
  type AbEntry,
  type AbLine,
  type AlreadyBilledKind,
} from "@/lib/already-billed";
import type { AlreadyBilledSheetData } from "@/lib/already-billed-read";
import { alreadyBilledSheet, markAlreadyBilled, noJobHoursSheet, unmarkAlreadyBilled, type AlreadyBilledWrite } from "@/app/(app)/jobs/already-billed-actions";
import { receiptForBilling } from "@/app/(app)/bills/receipt-for-billing-action";
import { ReceiptLines, type ReceiptForBilling } from "@/app/(app)/bills/receipt-billing-card";

/** `invoiceId` (hours on no job only): the invoice whose page the door stands on, offered first. */
export type AlreadyBilledDoorTarget = { kind: AlreadyBilledKind; ids: string[]; what: string; invoiceId?: string | null };

export type AlreadyBilledLoad = { state: "loading" } | { state: "error"; error: string; needsUpdate?: boolean } | { state: "ok"; data: AlreadyBilledSheetData };
type Load = AlreadyBilledLoad;
type Receipt = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; receipt: ReceiptForBilling };

/** "12.5 h of Brian Taylor's time", or "12.5 h of time" when more than one person's is ticked. */
export function hoursWhat(entries: readonly AbEntry[], ids: Iterable<string>): string {
  const set = new Set(ids);
  const picked = entries.filter((e) => set.has(e.id));
  const names = [...new Set(picked.map((e) => e.name))];
  const h = hoursOf(entries, set);
  return names.length === 1 ? `${h} h of ${names[0]}'s time` : `${h} h of time`;
}

/**
 * WHY THESE HOURS ARE TICKED TO START (precheckHours): the line's person up to the day the bill was
 * written, only as many as fit beside what the line already holds, or why nothing is.
 */
export function precheckWhy(
  data: Pick<AlreadyBilledSheetData, "entries" | "tz" | "noJob" | "preticked">,
  chosen: { invoice: { invoice_number: string | null; created_at: string }; line: AbLine },
): string {
  const held = Math.max(0, Number(chosen.line.heldHours) || 0);
  // Hours on no job: only what the door was pressed on is ticked; the line names no one to match.
  if (data.noJob) {
    const already = held > 0 ? ` The line already holds ${held} h of shifts.` : "";
    return (data.preticked ?? []).length
      ? `Ticked to start: the shift you pressed Already Billed on. Tick any others this line charged for.${already}`
      : `Nothing is ticked to start. Tick the hours this line charged for.${already}`;
  }
  const pre = precheckHours(data.entries, chosen.line, chosen.invoice.created_at, data.tz);
  if (!pre.person) return "Nothing is ticked to start: the line doesn't name one person. Tick the hours it charged for.";
  if (pre.covered)
    return lineHours(chosen.line) == null
      ? `Nothing is ticked to start: the line already holds ${held} h of shifts and isn't billed in hours, so what else it charged for is yours to tick.`
      : `Nothing is ticked to start: the line already holds ${held} h of shifts, all the hours it charges for. Tick any more it charged for.`;
  const base = `Ticked to start: that person's hours up to the day ${chosen.invoice.invoice_number ?? "the bill"} was written (${formatDateShort(chosen.invoice.created_at, data.tz)}), not the day it was sent`;
  return held > 0 ? `${base}, and only as many as fit beside the ${held} h the line already holds.` : `${base}.`;
}

/** The Already Billed door: opens the sheet for one cost. `jobId` null: hours on no job. */
export function AlreadyBilledButton({
  jobId,
  target,
  label = "Already Billed",
  onMarked,
  className,
}: {
  jobId: string | null;
  target: AlreadyBilledDoorTarget;
  label?: string;
  /** The caller shows the result itself (the paper card's done line); otherwise it is a toast. */
  onMarked?: (res: AlreadyBilledWrite) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} className={className}>
        {label}
      </Button>
      {open && <AlreadyBilledSheet jobId={jobId} target={target} onClose={() => setOpen(false)} onMarked={onMarked} />}
    </>
  );
}

/** NOT BILLED AFTER ALL: takes a person's mark back off its line (a split shift comes off whole). */
export function NotBilledAfterAllButton({
  jobId,
  lineId,
  ids,
  what,
  className,
}: {
  /** The job the row stands on; null for hours on no job (they sit on their invoice). */
  jobId: string | null;
  lineId: string;
  ids: string[];
  what: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const undoMark = useUndoMark();
  function press() {
    setBusy(true);
    unmarkAlreadyBilled({ jobId: jobId ?? "", lineId, ids, what }).then(
      (res) => {
        setBusy(false);
        if (!res.ok) return toast(res.error ?? "That didn't save. Nothing was changed.", "error");
        const u = res.undo;
        toast(res.message ?? "Back in Not Billed Yet.", "success", u ? { label: "Undo", onClick: () => undoMark(u) } : undefined);
        router.refresh();
      },
      () => {
        setBusy(false);
        toast("The connection dropped, so nothing was changed. Try again.", "error");
      },
    );
  }
  return (
    <Button type="button" variant="outline" disabled={busy} onClick={press} className={className}>
      {busy ? "Working…" : "Not Billed After All"}
    </Button>
  );
}

/** Undo of an unmark is the mark again, on the same line and ids. */
function useUndoMark() {
  const router = useRouter();
  const toast = useToast();
  return (u: NonNullable<AlreadyBilledWrite["undo"]>) =>
    markAlreadyBilled(u).then(
      (res) => {
        toast(res.ok ? (res.message ?? "Marked billed again.") : (res.error ?? "That didn't save."), res.ok ? "success" : "error");
        router.refresh();
      },
      () => toast("The connection dropped, so nothing was changed. Try again.", "error"),
    );
}

/** Undo of a mark is the unmark, on the same line and ids. */
function useUndoUnmark() {
  const router = useRouter();
  const toast = useToast();
  return (u: NonNullable<AlreadyBilledWrite["undo"]>) =>
    unmarkAlreadyBilled(u).then(
      (res) => {
        toast(res.ok ? (res.message ?? "Back in Not Billed Yet.") : (res.error ?? "That didn't save."), res.ok ? "success" : "error");
        router.refresh();
      },
      () => toast("The connection dropped, so nothing was changed. Try again.", "error"),
    );
}

export type AlreadyBilledSheetInitial = {
  load?: Load;
  lineId?: string | null;
  checked?: string[];
  step?: "pick" | "ask" | "shelf";
};

export function AlreadyBilledSheet({
  jobId,
  target,
  onClose,
  onMarked,
  initial,
}: {
  /** null: hours on no job (target.kind "time"; target.ids are the shifts the door was pressed on). */
  jobId: string | null;
  target: AlreadyBilledDoorTarget;
  onClose: () => void;
  onMarked?: (res: AlreadyBilledWrite) => void;
  /** The sheet as it stands on its first paint (the render tests; the app always starts loading). */
  initial?: AlreadyBilledSheetInitial;
}) {
  const router = useRouter();
  const toast = useToast();
  const undoUnmark = useUndoUnmark();
  const [load, setLoad] = useState<Load>(initial?.load ?? { state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [lineId, setLineId] = useState<string | null>(initial?.lineId ?? null);
  const [checked, setChecked] = useState<Set<string>>(new Set(initial?.checked ?? []));
  const [step, setStep] = useState<"pick" | "ask" | "shelf">(initial?.step ?? "pick");
  const [answered, setAnswered] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>({ state: "loading" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idsKey = target.ids.join(",");
  const onInvoice = target.invoiceId ?? null;

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    const ids = idsKey ? idsKey.split(",") : [];
    (jobId ? alreadyBilledSheet(jobId, { kind: target.kind, ids }) : noJobHoursSheet(ids, onInvoice)).then(
      (res) => {
        if (!live) return;
        if (!res.ok) return setLoad({ state: "error", error: res.error, needsUpdate: res.needsUpdate });
        setLoad({ state: "ok", data: res.data });
      },
      () => live && setLoad({ state: "error", error: "The connection dropped before the bills came back. Try again." }),
    );
    return () => {
      live = false;
    };
  }, [jobId, target.kind, idsKey, onInvoice, attempt]);

  const data = load.state === "ok" ? load.data : null;
  const rows = useMemo(() => (data ? data.invoices.flatMap(({ invoice }) => invoice.lines.map((line) => ({ invoice, line }))) : []), [data]);
  const chosen = rows.find((r) => r.line.id === lineId) ?? null;

  function pick(id: string | null, d: AlreadyBilledSheetData | null = data) {
    setLineId(id);
    setError(null);
    // Hours on no job: the ticks are his (what he pressed on, and what he ticks), whatever the line.
    if (!d || d.target.kind !== "time" || d.noJob) return;
    const row = d.invoices.flatMap(({ invoice }) => invoice.lines.map((line) => ({ invoice, line }))).find((r) => r.line.id === id);
    setChecked(new Set(row ? precheckHours(d.entries, row.line, row.invoice.created_at, d.tz).checked : []));
  }

  // The obvious line is picked for him (still his to change); nothing else is. On no job, the shift
  // the door was pressed on is ticked (a split shift whole).
  useEffect(() => {
    if (data?.noJob && checked.size === 0 && (data.preticked ?? []).length) setChecked(new Set(data.preticked));
    if (data && lineId == null) {
      const pre = data.invoices[0]?.preselect ?? null;
      if (pre) pick(pre, data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const num = chosen?.invoice.invoice_number ?? "The Bill";
  const markLabel = `Mark Billed On ${num}`;
  const isTime = data?.target.kind === "time";
  const ids = isTime ? [...checked] : (data?.target.ids ?? []);
  const what = !data ? target.what : isTime ? hoursWhat(data.entries, checked) : data.target.words || target.what;

  function readReceipt(billId: string) {
    setReceipt({ state: "loading" });
    receiptForBilling(billId).then(
      (res) => setReceipt(res.ok ? { state: "ok", receipt: res.receipt } : { state: "error", error: res.error }),
      () => setReceipt({ state: "error", error: "The connection dropped before the receipt came back. Try again." }),
    );
  }

  function press() {
    if (!data || !chosen) return;
    if (
      step === "pick" &&
      !answered &&
      data.target.kind === "bill" &&
      askUsedAll({ shopStock: data.shopStock, billHasLines: data.target.billHasLines, billCost: data.target.cost ?? 0, lineTotal: chosen.line.line_total })
    ) {
      setStep("ask");
      return;
    }
    mark();
  }

  function mark() {
    if (!chosen || !ids.length) return;
    setSaving(true);
    setError(null);
    markAlreadyBilled({ jobId: jobId ?? "", lineId: chosen.line.id, ids, what }).then(
      (res) => {
        setSaving(false);
        // IF MARKING FAILS, NOTHING ELSE MOVES: the sheet stays open with the reason.
        if (!res.ok) return setError(res.error ?? "That didn't save. Nothing was changed.");
        if (onMarked) onMarked(res);
        else {
          const u = res.undo;
          toast(res.message ?? "Marked billed.", "success", u ? { label: "Undo", onClick: () => undoUnmark(u) } : undefined);
        }
        router.refresh();
        onClose();
      },
      () => {
        setSaving(false);
        setError("The connection dropped before the answer came back. Reload the page to see whether it was marked.");
      },
    );
  }

  const costWords = (d: AlreadyBilledSheetData): string | null => {
    const t = d.target;
    if (t.kind === "time") return `${d.noJob ? "On no job and not billed" : "Not billed yet"}: ${hoursOf(d.entries, d.entries.map((e) => e.id))} h`;
    if (t.cost == null) return null;
    if (t.negative) return `This return: ${formatCurrency(Math.abs(t.cost))} back from the supplier`;
    const noun = t.kind === "bill" ? "This bill" : t.kind === "po" ? "This order" : "These pieces";
    return `${noun}: ${formatCurrency(t.cost)} at cost`;
  };

  const footer =
    step === "ask" ? null : step === "shelf" ? (
      <ModalActions onCancel={() => setStep("ask")} cancelLabel="Back" onSave={mark} saving={saving} saveLabel={markLabel} disabled={!chosen || saving} />
    ) : (
      <ModalActions onCancel={onClose} onSave={press} saving={saving} saveLabel={markLabel} disabled={!chosen || !ids.length || saving || load.state !== "ok"} />
    );

  return (
    <Modal open onClose={onClose} title="Already Billed" size="md" portal footer={footer}>
      <div className="space-y-3 text-sm">
        {load.state === "loading" && (
          <p className="text-slate-500" role="status">
            Reading the bills…
          </p>
        )}
        {load.state === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3" role="alert">
            <p className="text-red-700">{load.error}</p>
            {!load.needsUpdate && (
              <Button type="button" variant="outline" className="mt-2" onClick={() => setAttempt((a) => a + 1)}>
                Try Again
              </Button>
            )}
          </div>
        )}

        {data && step === "pick" && (
          <>
            {costWords(data) && <p className="font-medium text-slate-900">{costWords(data)}</p>}
            {data.target.words && <p className="-mt-2 text-xs text-slate-500">{data.target.words}</p>}
            {data.note && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800" role="status">
                {data.note}
              </p>
            )}
            {data.invoices.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
                {data.noJob
                  ? "No invoice with no job that went out has a line that could have charged for these hours. A line you typed, or one you changed, on a sent invoice with no job can hold them."
                  : `No bill that went out on ${data.jobNumber} has a line that could have charged for this. ${
                      data.target.negative
                        ? "Only a line typed by hand that takes money off can hold a return."
                        : "A line you typed, or one you changed, on a sent bill can hold it."
                    }`}
              </p>
            ) : (
              <fieldset className="space-y-1">
                <legend className="mb-1 font-medium text-slate-900">Which line already charged for this?</legend>
                {rows.map(({ invoice, line }) => (
                  <label
                    key={line.id}
                    className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${line.id === lineId ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-tint))]/10" : "border-slate-200"}`}
                  >
                    <input type="radio" name="already-billed-line" className="h-5 w-5 shrink-0" checked={line.id === lineId} onChange={() => pick(line.id)} />
                    <span className="min-w-0 flex-1 break-words">{lineLabel(invoice, line)}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {data.drafts.map((d) => (
              <p key={d} className="text-xs text-slate-500">
                {d}
              </p>
            ))}

            {isTime && chosen && (
              <div className="space-y-1">
                <p className="font-medium text-slate-900">Which hours did it charge for?</p>
                {data.entries.length === 0 ? (
                  <p className="text-slate-500">{data.noJob ? "No hours on no job are open to mark." : `No hours on ${data.jobNumber} are open to mark.`}</p>
                ) : (
                  data.entries.map((e) => (
                    <label key={e.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0"
                        checked={checked.has(e.id)}
                        // A split shift is ticked whole: its other pieces follow this one.
                        onChange={(ev) => {
                          const on = ev.target.checked;
                          setChecked((s) => tickTogether(data.entries, s, e.id, on));
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        {formatDateShort(e.clockIn, data.tz)} · {e.name} · {e.hours} h
                      </span>
                    </label>
                  ))
                )}
                <p className="text-slate-600">{hoursCompareWords(chosen.line, hoursOf(data.entries, checked))}</p>
                <p className="text-xs text-slate-500">{precheckWhy(data, chosen)}</p>
              </div>
            )}
            {chosen && <p className="text-xs text-slate-500">Nothing on {num} changes: its words, total and status stay as they are.</p>}
          </>
        )}

        {data && chosen && step === "ask" && (
          <div className="space-y-3">
            <p className="text-base font-semibold text-slate-900">Did {data.jobNumber} Use All Of It?</p>
            <p className="text-slate-600">
              {chosen.line.description.trim() || "The line"} on {num} is {formatCurrency(chosen.line.line_total)}, and this bill cost{" "}
              {formatCurrency(data.target.cost ?? 0)}. If some of it went on the shop shelf, put it there first: once {num} holds the bill, its
              lines lock.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={saving}
                onClick={() => {
                  setAnswered(true);
                  mark();
                }}
              >
                Yes, All Of It
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setAnswered(true);
                  setStep("shelf");
                  if (data.target.billId) readReceipt(data.target.billId);
                }}
              >
                No, Some Went On The Shelf
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep("pick")}>
                Back
              </Button>
            </div>
          </div>
        )}

        {data && step === "shelf" && (
          <div className="space-y-2">
            <p className="text-slate-600">Put what {data.jobNumber} didn&apos;t use on the shelf, then press {markLabel}.</p>
            {receipt.state === "loading" && <p className="text-slate-500">Opening the receipt…</p>}
            {receipt.state === "error" && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3" role="alert">
                <p className="text-red-700">{receipt.error}</p>
                <Button type="button" variant="outline" className="mt-2" onClick={() => data.target.billId && readReceipt(data.target.billId)}>
                  Try Again
                </Button>
              </div>
            )}
            {receipt.state === "ok" && (
              <ReceiptLines
                receipt={receipt.receipt}
                shopStock={data.shopStock}
                modalPortal
                onChanged={() => data.target.billId && readReceipt(data.target.billId)}
              />
            )}
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
