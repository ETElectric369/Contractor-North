"use client";

import { companyLabel } from "@/lib/vendor-words";
import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { billedOnLabel, nothingToBillWhy, openOwnNote, pileCount, type JobCostGroups } from "@/lib/job-cost-groups";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge, statusTone } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency, formatDate, formatDuration } from "@/lib/utils";
import { BillRowDoors } from "@/components/bill-row-doors";
import { JobScopePicker, useJobScopes } from "@/components/job-scope-picker";
import { scopeSaid } from "@/lib/bill-scope";
import { BillPaperDoors } from "@/components/bill-paper-doors";
import type { BillPaper } from "@/lib/job-photos";
import { AlreadyBilledButton, NotBilledAfterAllButton } from "@/components/already-billed-sheet";
import { executeAction } from "@/lib/actions/execute";
import { canCorrect, correctionFaces, correctionsUnder } from "@/lib/bill-correction";
import type { CorrectableBill } from "@/components/correct-bill-modal";

/**
 * ALREADY BILLED ON THE COSTS TAB (0357). `open`: the Not Billed Yet rows the door can mark (a row
 * with no entry has no door: no line on a sent bill could hold it). `hands`: the Billed rows
 * a person marked, with the line and ids Not Billed After All takes back off. Staff only (the page
 * decides). `open` only where the piles exist (a job that bills its actual costs); `hands` wherever a
 * mark is, the plain list included (a fixed-price job New Invoice bills from its actuals, J-010).
 */
export type JobAlreadyBilled = {
  open: Record<string, { kind: "bill" | "po" | "stock"; ids: string[]; what: string }>;
  hands: Record<string, { lineId: string; ids: string[]; invoiceNumber: string | null; what: string }>;
};

/** Hours a person marked as billed, per line (lib/already-billed hoursByHand): they are billed, so
 *  they sit in the Billed fold under their invoice, with the way back. */
export type JobBilledHours = { lineId: string; invoiceId: string | null; invoiceNumber: string | null; ids: string[]; hours: number; what: string }[];

type Pile = "open" | "billed" | "nothing" | "plain";

interface Bill {
  id: string;
  supplier: string;
  bill_number: string | null;
  amount: number;
  status: string;
  bill_date: string | null;
  /** The PO this bill pays — when set, the bill SUPERSEDES that PO in every cost sum. */
  po_id?: string | null;
  /** ONE NUMBER PER BILL (0383): how much of it is paid. BillRowDoors reads what is open. */
  amount_paid?: number | null;
  /** WHICH PART OF THE JOB this cost is (item C1; column 0105). Shown on the row and set in the Edit
   *  Bill box, so a cost that is under no part of the job says so instead of quietly reading
   *  "Uncategorized" on the budget sheet and nowhere else. */
  scope_category?: string | null;
  /** THE BILL THIS ONE CORRECTS (0381): drawn under it when both are in one pile, and both say so. */
  corrects_bill_id?: string | null;
  /** Its lines, as the page reads them: what Correct This Bill offers a credit to take back. */
  bill_line_items?: { description: string | null; amount: number | string; billable?: boolean | null; category?: string | null }[] | null;
}

export interface JobPo {
  id: string;
  po_number: string;
  vendor: string;
  status: string;
  total: number;
}

/** The POs a bill may claim to pay: real orders only (not a draft that was never sent,
 *  not a cancelled one) — those aren't costs, so superseding them would mean nothing. */
function billablePos(pos: JobPo[]): JobPo[] {
  return (pos ?? []).filter((p) => p.status !== "draft" && p.status !== "cancelled");
}

/** Label for the PO picker: "PO-00012 · CED · $2,400.00". */
function poLabel(p: JobPo): string {
  return `${p.po_number} · ${p.vendor || "No vendor"} · ${formatCurrency(p.total)}`;
}

/**
 * THE JOB'S SUPPLIER BILLS. With `groups` (a job that bills its actuals, the claims read in hand)
 * the list is sorted OPEN FIRST (Erik, 2026-09-25: "in costs i need to know what is open more than
 * i need to know all the totals"): Not Billed Yet, with the door that bills it (`openAside`), then
 * Billed folded by invoice and closed until tapped, then anything that never goes on an invoice,
 * with why. The sorting is lib/job-cost-groups over UnbilledWork.costRows, never a rule here.
 * Without `groups` it is the one list it always was, and says why when the claims read failed.
 *
 * NO ADD BUTTON HERE (W1-23: one way to add a cost). A cost goes in at the top of the tab: Snap The
 * Bill, or its ⋯ (Upload, Type It In: the one typed sheet, which also takes the job's purchase order).
 */
export function JobBills({
  jobId,
  bills,
  pos = [],
  groups,
  openAside,
  groupsNote,
  alreadyBilled,
  billedHours = [],
  handsNote,
  papers = null,
  correctionsReady = false,
}: {
  jobId: string;
  bills: Bill[];
  pos?: JobPo[];
  groups?: JobCostGroups | null;
  /** Under the Not Billed Yet heading: the Overview card's door and what else it bills. */
  openAside?: ReactNode;
  /** Said above the plain list when the piles could not be read. */
  groupsNote?: string | null;
  /** Already Billed's doors (0357), when the page offers them. */
  alreadyBilled?: JobAlreadyBilled | null;
  /** Hours a person marked as billed (0357): in the Billed fold under their invoice. */
  billedHours?: JobBilledHours;
  /** Said under Billed when the marks couldn't be read: their Undo can't be shown, never silently. */
  handsNote?: string | null;
  /** Each bill's own paper (lib/job-photos billPapers): the receipt it was read from, opened from
   *  its row instead of from the Photos grid. A bill with none draws no door. */
  papers?: Record<string, BillPaper[]> | null;
  /** The page read bills.corrects_bill_id (0381 is on the database): Correct This Bill is drawn. */
  correctionsReady?: boolean;
}) {
  const [editBill, setEditBill] = useState<Bill | null>(null);
  // DOES THIS JOB HAVE PARTS AT ALL (item C1)? On a job whose estimate is broken into Framing and
  // Decking, a cost under no part is a real gap and the row says so. On a job with no scoped estimate
  // there is no gap and no door to fix one, so the row says nothing rather than nagging about a
  // question nobody can answer.
  const { scopes: jobScopes } = useJobScopes(jobId);
  const jobHasParts = (jobScopes?.length ?? 0) > 0;

  const total = bills.reduce((s, b) => s + Number(b.amount), 0);
  const poNumberById = new Map(pos.map((p) => [p.id, p.po_number]));

  const billById = new Map(bills.map((b) => [b.id, b] as const));
  const poById = new Map(pos.map((p) => [p.id, p] as const));

  // THE PAIR READS AS ONE PURCHASE (0381). Faces over every bill on the job: a correction says what
  // it corrects, and the original says what corrects it and the purchase's figure. The two can sit in
  // different piles (the original Billed on an invoice, its correction Not Billed Yet), which is
  // right - one is on an invoice and the other is not - and each still names the other.
  const faces = correctionFaces(bills.map((b) => ({ id: b.id, corrects_bill_id: b.corrects_bill_id ?? null, amount: b.amount, bill_number: b.bill_number })));
  const correctionsOf = new Map<string, Bill[]>();
  for (const b of bills) if (b.corrects_bill_id) correctionsOf.set(b.corrects_bill_id, [...(correctionsOf.get(b.corrects_bill_id) ?? []), b]);
  const correctable = (b: Bill): CorrectableBill | null => {
    if (!canCorrect(b, correctionsReady)) return null;
    const under = correctionsOf.get(b.id) ?? [];
    return {
      id: b.id,
      supplier: b.supplier,
      amount: Number(b.amount) || 0,
      bill_number: b.bill_number,
      bill_date: b.bill_date,
      lines: [b, ...under].flatMap((x) =>
        (x.bill_line_items ?? []).map((l) => ({ description: l.description, amount: Number(l.amount) || 0, billable: l.billable ?? null, category: l.category ?? null })),
      ),
      corrections: under.map((u) => ({ billNumber: u.bill_number, amount: Number(u.amount) || 0 })),
    };
  };
  const followsOf = (id: string) => {
    const f = faces.get(id);
    return f?.kind === "corrects" ? (f.originalNumber ?? "the bill it corrects") : null;
  };

  /**
   * ALREADY BILLED'S DOORS ON A ROW (0357): on an open row, Already Billed (it charged on a sent
   * bill by hand); on a billed row a person marked, what it says and Not Billed After All. Nothing
   * on any other row, and nothing at all when the page offers no doors.
   */
  const abDoors = (id: string, pile: Pile) => {
    const open = pile === "open" ? alreadyBilled?.open[id] : undefined;
    const hand = pile === "billed" || pile === "plain" ? alreadyBilled?.hands[id] : undefined;
    if (open) return <AlreadyBilledButton jobId={jobId} target={open} />;
    if (hand)
      return (
        <>
          <span className="text-xs font-medium text-slate-600">Billed By Hand On {hand.invoiceNumber ?? "That Invoice"}</span>
          <NotBilledAfterAllButton jobId={jobId} lineId={hand.lineId} ids={hand.ids} what={hand.what} />
        </>
      );
    return null;
  };

  /** A bill in a pile: what it is, then the /bills row's own doors (BillRowDoors: Settled / On
   *  Account with the deed on its face, Edit, Delete that asks first), each 44px, wrapping under it
   *  on a phone. THE BILL OPENS (ea2b7172): a bill's detail (its lines, the receipt-billing card) lives
   *  only inside /bills's own fold (#bill-<id>), and this row had no way there, so the supplier line
   *  and an Open The Bill door both land on it, the way a PO row lands on its page. */
  const billRow = (b: Bill, why: string | undefined, pile: Pile, underIt = false) => (
    <li key={b.id} className={underIt ? "border-l-4 border-slate-200 bg-slate-50/40 py-2.5 pl-6 pr-4 text-sm" : "px-4 py-2.5 text-sm"}>
      <Link href={`/bills#bill-${b.id}`} className="flex min-h-11 items-center gap-3 rounded-md hover:bg-slate-50">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-900">{b.supplier}</div>
          <div className="text-xs text-slate-400">
            {b.bill_number ? `#${b.bill_number} · ` : ""}{b.bill_date ? formatDate(b.bill_date) : ""}
            {b.po_id && poNumberById.has(b.po_id)
              ? ` · pays ${poNumberById.get(b.po_id)}`
              : ""}
            {/* NOTHING SILENT (item C1): the part of the job this cost counts under, and on a job
                that HAS parts, that none is set — rather than that showing up only as Uncategorized
                on the budget sheet. Edit sets it. */}
            {(b.scope_category || jobHasParts) && ` · ${scopeSaid(b.scope_category)}`}
          </div>
          {faces.get(b.id) && <div className="text-xs font-medium text-slate-600">{faces.get(b.id)!.words}</div>}
          {why && <div className="text-xs text-slate-500">{why}</div>}
        </div>
        <span className="font-medium text-slate-800">{formatCurrency(b.amount)}</span>
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <BillPaperDoors papers={papers?.[b.id]} />
        <BillRowDoors bill={b} jobId={jobId} onEdit={() => setEditBill(b)} correct={correctable(b)} follows={followsOf(b.id)} />
        <Link href={`/bills#bill-${b.id}`} className="flex min-h-11 items-center px-2 text-sm font-medium text-brand hover:underline">
          Open The Bill
        </Link>
        {abDoors(b.id, pile)}
      </div>
    </li>
  );

  /** A live purchase order in a pile: its own page holds its controls. */
  const poRow = (p: JobPo, why: string | undefined, pile: Pile) => {
    const doors = abDoors(p.id, pile);
    return (
      <li key={p.id}>
        <Link href={`/purchasing/${p.id}`} className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-900">{p.vendor || "No vendor yet"}</div>
            <div className="text-xs text-slate-400">{p.po_number} · purchase order</div>
            {why && <div className="text-xs text-slate-500">{why}</div>}
          </div>
          <span className="font-medium text-slate-800">{formatCurrency(p.total)}</span>
        </Link>
        {doors && <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5">{doors}</div>}
      </li>
    );
  };

  /** A take from stock in a pile (Shop Stock, Phase 3): what came off the shelf and what it cost.
   *  Its controls (Undo, Carry Back) live with the takes on the Materials tab, so it goes there. */
  const stockRow = (id: string, why: string | undefined, pile: Pile) => {
    const t = groups?.stock[id];
    if (!t) return null;
    const doors = abDoors(id, pile);
    return (
      <li key={id}>
        <Link href={`/jobs/${jobId}?tab=materials`} className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-900">{t.label}</div>
            <div className="text-xs text-slate-400">Taken {formatDate(t.takenAt)}</div>
            {why && <div className="text-xs text-slate-500">{why}</div>}
            {/* Part of the take came off a roll with no cost on it: its line bills only the rest. */}
            {t.note && <div className="text-xs text-amber-700">{t.note}</div>}
          </div>
          <span className="font-medium text-slate-800">{formatCurrency(t.cost)}</span>
        </Link>
        {doors && <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5">{doors}</div>}
      </li>
    );
  };

  /** "Billed By Hand On INV-059: 6h 30m · Not Billed After All": hours a person marked. */
  const hoursRow = (h: JobBilledHours[number]) => (
    <div key={h.lineId} className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>
        Billed By Hand On {h.invoiceNumber ?? "That Invoice"}: {formatDuration(h.hours)}
      </span>
      <NotBilledAfterAllButton jobId={jobId} lineId={h.lineId} ids={h.ids} what={h.what} />
    </div>
  );
  const foldIds = new Set((groups?.billed ?? []).map((g) => g.invoice.id));
  const hoursIn = (invoiceId: string) => billedHours.filter((h) => h.invoiceId === invoiceId);
  // Marked hours on an invoice that holds none of the job's bills: their own line under Billed.
  const hoursLoose = billedHours.filter((h) => !h.invoiceId || !foldIds.has(h.invoiceId));

  const rowsOf = (ids: string[], whyOf?: (id: string) => string | undefined, pile: Pile = "plain") => {
    // A correction directly under its original when both are in this list; every other row keeps
    // its place (orders and takes from stock never carry the column).
    const ordered = correctionsUnder(ids.map((id) => ({ id, corrects_bill_id: billById.get(id)?.corrects_bill_id ?? null }))).map((r) => r.id);
    const here = new Set(ordered);
    return (
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {ordered.map((id) => {
          const b = billById.get(id);
          if (b) return billRow(b, whyOf?.(id), pile, !!b.corrects_bill_id && here.has(b.corrects_bill_id));
          const p = poById.get(id);
          if (p) return poRow(p, whyOf?.(id), pile);
          return stockRow(id, whyOf?.(id), pile);
        })}
      </ul>
    );
  };

  return (
    <div>
      {groups ? (
        <div className="mb-3 text-sm font-semibold text-slate-900">
          Not Billed Yet{" "}
          <span className="font-normal text-slate-500">
            · {pileCount(groups.open)} · {formatCurrency(groups.open.total)}
          </span>
        </div>
      ) : (
        <div className="mb-3 text-sm text-slate-500">
          {bills.length} bill{bills.length === 1 ? "" : "s"} · {formatCurrency(total)}
        </div>
      )}
      {!groups && groupsNote && <p className="mb-3 text-sm text-slate-500">{groupsNote}</p>}

      {groups ? (
        <>
          {openAside}
          {groups.open.ids.length > 0 ? (
            <div className={openAside ? "mt-3" : undefined}>{rowsOf(groups.open.ids, (id) => openOwnNote(groups.openOwn[id]), "open")}</div>
          ) : (
            <p className="py-3 text-sm text-slate-500">
              {bills.length === 0 && !Object.keys(groups.stock).length
                ? "No supplier bills yet."
                : groups.nothing.length
                  ? "None. Every bill on this job is on an invoice, or never goes on one (below)."
                  : "None. Every bill on this job is on an invoice."}
            </p>
          )}

          {(groups.billed.length > 0 || billedHours.length > 0 || !!handsNote) && (
            <div className="mt-5">
              <div className="mb-2 text-sm font-semibold text-slate-900">Billed</div>
              {handsNote && <p className="mb-2 text-sm text-slate-500">{handsNote}</p>}
              {hoursLoose.length > 0 && <div className="mb-2 space-y-2">{hoursLoose.map(hoursRow)}</div>}
              <div className="space-y-2">
                {groups.billed.map((g) => (
                  // Closed until tapped: what is already on an invoice is the part he does not
                  // need to read to find what is missing. A draft says so, so "billed" never
                  // reads as sent.
                  <details key={g.invoice.id} className="group rounded-lg border border-slate-200">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
                      <span className="min-w-0 flex-1 text-slate-800">
                        On {billedOnLabel(g)} <span className="text-slate-500">· {pileCount(g)}</span>
                      </span>
                      {g.draft && <Badge tone={statusTone("draft")}>Draft</Badge>}
                      <span className="font-medium text-slate-800">{formatCurrency(g.total)}</span>
                    </summary>
                    <div className="border-t border-slate-100 px-3 pb-2 pt-3">
                      {rowsOf(g.ids, undefined, "billed")}
                      {hoursIn(g.invoice.id).length > 0 && <div className="mt-2 space-y-2">{hoursIn(g.invoice.id).map(hoursRow)}</div>}
                      <Link
                        href={`/billing/${g.invoice.id}`}
                        className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
                      >
                        Open {g.invoice.invoice_number ?? "The Invoice"}
                      </Link>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}

          {groups.nothing.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 text-sm font-semibold text-slate-900">Nothing To Bill</div>
              {rowsOf(
                groups.nothing.map((n) => n.id),
                (id) => nothingToBillWhy(groups.nothing.find((n) => n.id === id)!.why),
                "nothing",
              )}
            </div>
          )}
        </>
      ) : bills.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No supplier bills yet.</p>
      ) : (
        rowsOf(bills.map((b) => b.id))
      )}
      {/* The plain list (no piles): hours a person marked still say so, with the way back. */}
      {!groups && billedHours.length > 0 && <div className="mt-3 space-y-2">{billedHours.map(hoursRow)}</div>}
      {!groups && handsNote && <p className="mt-3 text-sm text-slate-500">{handsNote}</p>}

      {editBill && (
        <JobBillEditModal
          key={editBill.id}
          bill={editBill}
          jobId={jobId}
          pos={pos}
          onClose={() => setEditBill(null)}
          follows={followsOf(editBill.id)}
        />
      )}
    </div>
  );
}

/** Edit a supplier bill. Routes through the unified Action Registry
 *  (executeAction → "bill.update") — the same capability the AI agent calls. */
function JobBillEditModal({
  bill,
  jobId,
  pos = [],
  onClose,
  follows = null,
}: {
  bill: Bill;
  /** The job this tab is on — what the Part Of The Job control reads its options from (item C1). */
  jobId: string;
  pos?: JobPo[];
  onClose: () => void;
  /** This bill is a correction (0381): how it was bought follows that bill, so it is not offered. */
  follows?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [supplier, setSupplier] = useState(bill.supplier);
  const [billNumber, setBillNumber] = useState(bill.bill_number ?? "");
  const [amount, setAmount] = useState(Number(bill.amount));
  const [status, setStatus] = useState(bill.status);
  const [billDate, setBillDate] = useState(bill.bill_date ?? "");
  const [poId, setPoId] = useState(bill.po_id ?? "");
  // WHICH PART OF THE JOB (item C1): the door that sets or changes it on a cost that already exists.
  const [scope, setScope] = useState(bill.scope_category ?? "");
  const [error, setError] = useState<string | null>(null);
  // A save that WENT THROUGH and still has something to say (a roll in stock re-costed, a part of
  // the job the estimate no longer has). It holds the modal open instead of riding a toast, for the
  // same reason the timecard editor does it that way: 2.8 seconds on a phone at a jobsite is not
  // reading time. A re-price on a receipt an invoice bills is refused now, and sent to Correct This
  // Bill (0381).
  const [billedNote, setBilledNote] = useState<string | null>(null);
  // Offer the real orders, PLUS whichever PO this bill already claims even if it was since
  // cancelled — otherwise the picker would render blank and saving would silently drop the
  // link, putting the double-charge back.
  const linked = pos.find((p) => p.id === bill.po_id);
  const poOptions = billablePos(pos);
  if (linked && !poOptions.some((p) => p.id === linked.id)) poOptions.unshift(linked);

  function save() {
    if (!supplier.trim()) return setError("Supplier is required.");
    setError(null);
    start(async () => {
      const res = await executeAction("bill.update", {
        id: bill.id,
        supplier,
        bill_number: billNumber,
        amount,
        status,
        bill_date: billDate || null,
        po_id: poId || null,
        // "" takes it back off; a part this job's estimate hasn't got is refused and names the ones
        // it has (lib/bill-scope). Sending it is how it changes.
        scope_category: scope || null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      if (res.warning) {
        setBilledNote(res.warning);
        router.refresh();
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit Bill"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} disabled={!supplier.trim()} saveLabel="Save Changes" />}
    >
      <div className="space-y-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {billedNote && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <div className="font-semibold">Saved. One thing to know:</div>
            <div className="mt-1">{billedNote}</div>
            <Button variant="outline" size="sm" onClick={onClose} className="mt-2">
              Got It
            </Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label htmlFor="be-supplier">{companyLabel("bill", true)}</Label>
            <Input id="be-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} autoFocus />
          </div>
          <div>
            <Label htmlFor="be-num">Bill #</Label>
            <Input id="be-num" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="be-amt">Amount</Label>
            <NumberInput id="be-amt" value={amount} onValueChange={setAmount} />
          </div>
          <div>
            <Label htmlFor="be-date">Bill date</Label>
            <Input id="be-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </div>
          {follows && (
            <p className="col-span-2 text-sm text-slate-600">
              A correction of {follows}: how it was bought and its part of the job follow that bill. Change them on {follows} and this one follows.
            </p>
          )}
          <div className={follows ? "hidden" : undefined}>
            <Label htmlFor="be-status">Status</Label>
            <Select id="be-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="unpaid">On Account</option>
              <option value="paid">Paid</option>
            </Select>
          </div>
          {/* The same control the Add Cost sheets draw; nothing when this job's estimate has no parts. */}
          {!follows && <JobScopePicker jobId={jobId} value={scope} onChange={setScope} id="be-scope" className="col-span-2" />}
          {poOptions.length > 0 && (
            <div className="col-span-2">
              <Label htmlFor="be-po">Pays purchase order</Label>
              <Select id="be-po" value={poId} onChange={(e) => setPoId(e.target.value)}>
                <option value="">Not a PO — a separate cost</option>
                {poOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {poLabel(p)}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                Linked, this invoice replaces the PO in the job&apos;s material cost — the delivery
                is charged once, at the amount the supplier actually billed.
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
