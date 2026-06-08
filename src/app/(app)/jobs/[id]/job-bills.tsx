"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { createBill, setBillStatus, deleteBill } from "../actions";

interface Bill {
  id: string;
  supplier: string;
  bill_number: string | null;
  amount: number;
  status: string;
  bill_date: string | null;
}

export function JobBills({ jobId, bills }: { jobId: string; bills: Bill[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [supplier, setSupplier] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [amount, setAmount] = useState(0);
  const [status, setStatus] = useState("unpaid");
  const [billDate, setBillDate] = useState("");

  const total = bills.reduce((s, b) => s + Number(b.amount), 0);

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
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setSupplier("");
      setBillNumber("");
      setAmount(0);
      setBillDate("");
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
          <Plus className="h-3.5 w-3.5" /> Add bill
        </Button>
      </div>

      {adding && (
        <div className="mb-3 space-y-3 rounded-lg border border-slate-200 p-3">
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
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={pending || !supplier.trim()}>
              {pending ? "Saving…" : "Save bill"}
            </Button>
          </div>
        </div>
      )}

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
                </div>
              </div>
              <span className="font-medium text-slate-800">{formatCurrency(b.amount)}</span>
              <button
                onClick={() =>
                  start(async () => {
                    await setBillStatus(b.id, b.status === "paid" ? "unpaid" : "paid", jobId);
                    router.refresh();
                  })
                }
                title="Toggle paid/unpaid"
              >
                <Badge tone={b.status === "paid" ? "green" : "amber"}>{b.status}</Badge>
              </button>
              <button
                onClick={() =>
                  start(async () => {
                    await deleteBill(b.id, jobId);
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
    </div>
  );
}
