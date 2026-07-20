"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge, statusTone } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { createBill, setBillStatus, deleteBill } from "../actions";
import { executeAction } from "@/lib/actions/execute";

interface Bill {
  id: string;
  supplier: string;
  bill_number: string | null;
  amount: number;
  status: string;
  bill_date: string | null;
  /** The PO this bill pays — when set, the bill SUPERSEDES that PO in every cost sum. */
  po_id?: string | null;
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
  return `${p.po_number} · ${p.vendor} · ${formatCurrency(p.total)}`;
}

export function JobBills({ jobId, bills, pos = [] }: { jobId: string; bills: Bill[]; pos?: JobPo[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editBill, setEditBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [supplier, setSupplier] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [amount, setAmount] = useState(0);
  const [status, setStatus] = useState("unpaid");
  const [billDate, setBillDate] = useState("");
  const [poId, setPoId] = useState("");

  const total = bills.reduce((s, b) => s + Number(b.amount), 0);
  const poOptions = billablePos(pos);
  const poNumberById = new Map(pos.map((p) => [p.id, p.po_number]));

  function add() {
    setError(null);
    start(async () => {
      const res = await createBill({
        job_id: jobId,
        supplier,
        bill_number: billNumber,
        amount,
        status,
        bill_date: billDate || null,
        notes: "",
        po_id: poId || null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setSupplier("");
      setBillNumber("");
      setAmount(0);
      setBillDate("");
      setPoId("");
      setAdding(false);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">
          {bills.length} bill{bills.length === 1 ? "" : "s"} · {formatCurrency(total)}
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}>
          <Plus className="h-3.5 w-3.5" /> Add Bill
        </Button>
      </div>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add bill"
        footer={
          <ModalActions
            onCancel={() => setAdding(false)}
            onSave={add}
            saving={pending}
            disabled={!supplier.trim()}
            saveLabel="Save Changes"
          />
        }
      >
        <div className="space-y-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="b-supplier">Supplier *</Label>
              <Input id="b-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. CED" />
            </div>
            <div>
              <Label htmlFor="b-num">Bill #</Label>
              <Input id="b-num" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="b-amt">Amount</Label>
              <NumberInput id="b-amt" value={amount} onValueChange={setAmount} />
            </div>
            <div>
              <Label htmlFor="b-date">Bill date</Label>
              <Input id="b-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="b-status">Status</Label>
              <Select id="b-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="unpaid">Unpaid</option>
                <option value="paid">Paid</option>
              </Select>
            </div>
            {poOptions.length > 0 && (
              <div className="col-span-2">
                <Label htmlFor="b-po">Pays purchase order</Label>
                <Select id="b-po" value={poId} onChange={(e) => setPoId(e.target.value)}>
                  <option value="">Not a PO — a separate cost</option>
                  {poOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {poLabel(p)}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-slate-500">
                  Pick the order this supplier invoice pays and it replaces that PO in the job&apos;s
                  material cost — so the delivery is only charged once.
                </p>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {bills.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No supplier bills yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {bills.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900">{b.supplier}</div>
                <div className="text-xs text-slate-400">
                  {b.bill_number ? `#${b.bill_number} · ` : ""}{b.bill_date ? formatDate(b.bill_date) : ""}
                  {b.po_id && poNumberById.has(b.po_id)
                    ? ` · pays ${poNumberById.get(b.po_id)}`
                    : ""}
                </div>
              </div>
              <span className="font-medium text-slate-800">{formatCurrency(b.amount)}</span>
              <button
                onClick={() =>
                  start(async () => {
                    const next = b.status === "paid" ? "unpaid" : "paid";
                    const res = await setBillStatus(b.id, next, jobId);
                    if (!res?.ok) { toast(res?.error ?? "Couldn't update bill — try again.", "error"); return; }
                    toast(next === "paid" ? "Bill marked paid" : "Bill marked unpaid", "success");
                    router.refresh();
                  })
                }
                title="Toggle paid/unpaid"
              >
                <Badge tone={statusTone(b.status)}>{b.status}</Badge>
              </button>
              <button onClick={() => setEditBill(b)} className="text-slate-400 hover:text-brand" title="Edit">
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() =>
                  start(async () => {
                    const res = await deleteBill(b.id, jobId);
                    if (!res?.ok) { toast(res?.error ?? "Couldn't delete bill — try again.", "error"); return; }
                    toast("Bill deleted", "success");
                    router.refresh();
                  })
                }
                className="text-slate-400 hover:text-red-600"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {editBill && (
        <JobBillEditModal
          key={editBill.id}
          bill={editBill}
          pos={pos}
          onClose={() => setEditBill(null)}
        />
      )}
    </div>
  );
}

/** Edit a supplier bill. Routes through the unified Action Registry
 *  (executeAction → "bill.update") — the same capability the AI agent calls. */
function JobBillEditModal({
  bill,
  pos = [],
  onClose,
}: {
  bill: Bill;
  pos?: JobPo[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [supplier, setSupplier] = useState(bill.supplier);
  const [billNumber, setBillNumber] = useState(bill.bill_number ?? "");
  const [amount, setAmount] = useState(Number(bill.amount));
  const [status, setStatus] = useState(bill.status);
  const [billDate, setBillDate] = useState(bill.bill_date ?? "");
  const [poId, setPoId] = useState(bill.po_id ?? "");
  const [error, setError] = useState<string | null>(null);
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
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit bill"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} disabled={!supplier.trim()} saveLabel="Save Changes" />}
    >
      <div className="space-y-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label htmlFor="be-supplier">Supplier *</Label>
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
          <div>
            <Label htmlFor="be-status">Status</Label>
            <Select id="be-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="unpaid">Unpaid</option>
              <option value="paid">Paid</option>
            </Select>
          </div>
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
