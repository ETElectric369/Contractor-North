"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { addPettyCash, updatePettyCash, deletePettyCash } from "./actions";

export interface PettyTx {
  id: string;
  tx_date: string;
  kind: string;
  amount: number;
  category: string | null;
  description: string | null;
}

export function PettyCashManager({ items, balance }: { items: PettyTx[]; balance: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<"expense" | "replenish">("expense");
  const [amount, setAmount] = useState(0);
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  function add() {
    setError(null);
    if (!amount || amount <= 0) return setError("Enter an amount.");
    start(async () => {
      const res = await addPettyCash({ tx_date: date, kind, amount, category, description });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setAmount(0); setCategory(""); setDescription("");
      router.refresh();
    });
  }

  const spent = items.filter((i) => i.kind === "expense").reduce((s, i) => s + Number(i.amount), 0);
  const added = items.filter((i) => i.kind === "replenish").reduce((s, i) => s + Number(i.amount), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4 sm:max-w-lg">
        <Card><CardContent className="py-4"><div className="text-2xl font-bold text-slate-900">{formatCurrency(balance)}</div><div className="text-xs text-slate-500">Cash on hand</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="text-2xl font-bold text-red-600">{formatCurrency(spent)}</div><div className="text-xs text-slate-500">Spent</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="text-2xl font-bold text-green-600">{formatCurrency(added)}</div><div className="text-xs text-slate-500">Added</div></CardContent></Card>
      </div>

      <Card className="p-4">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div>
            <Label htmlFor="pc-kind">Type</Label>
            <Select id="pc-kind" value={kind} onChange={(e) => setKind(e.target.value as any)}>
              <option value="expense">Expense (−)</option>
              <option value="replenish">Add cash (+)</option>
            </Select>
          </div>
          <div><Label htmlFor="pc-amt">Amount</Label><NumberInput id="pc-amt" value={amount} onValueChange={setAmount} /></div>
          <div><Label htmlFor="pc-cat">Category</Label><Input id="pc-cat" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Fuel, parts…" /></div>
          <div className="col-span-2 sm:col-span-1"><Label htmlFor="pc-desc">Description</Label><Input id="pc-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div><Label htmlFor="pc-date">Date</Label><Input id="pc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={add} disabled={pending || !amount}><Plus className="h-3.5 w-3.5" /> Add</Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <ul className="divide-y divide-slate-100">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              {i.kind === "replenish" ? <ArrowUpCircle className="h-4 w-4 text-green-500" /> : <ArrowDownCircle className="h-4 w-4 text-red-500" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900">{i.description || i.category || (i.kind === "replenish" ? "Cash added" : "Expense")}</div>
                <div className="text-xs text-slate-400">{formatDate(i.tx_date)}{i.category ? ` · ${i.category}` : ""}</div>
              </div>
              <span className={`font-medium ${i.kind === "replenish" ? "text-green-600" : "text-red-600"}`}>
                {i.kind === "replenish" ? "+" : "−"}{formatCurrency(i.amount)}
              </span>
              <EditPettyCashButton tx={i} />
              <button onClick={() => { if (!confirm("Delete this entry?")) return; start(async () => { const res = await deletePettyCash(i.id); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Entry deleted", "success"); router.refresh(); }); }} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
          {items.length === 0 && <li className="px-4 py-10 text-center text-sm text-slate-400">No transactions yet. Add cash to your box, then log expenses as you spend.</li>}
        </ul>
      </Card>
    </div>
  );
}

function EditPettyCashButton({ tx }: { tx: PettyTx }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"expense" | "replenish">(tx.kind === "replenish" ? "replenish" : "expense");
  const [amount, setAmount] = useState(Number(tx.amount));
  const [category, setCategory] = useState(tx.category ?? "");
  const [description, setDescription] = useState(tx.description ?? "");
  const [date, setDate] = useState(tx.tx_date.slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  function openModal() {
    setKind(tx.kind === "replenish" ? "replenish" : "expense");
    setAmount(Number(tx.amount));
    setCategory(tx.category ?? "");
    setDescription(tx.description ?? "");
    setDate(tx.tx_date.slice(0, 10));
    setError(null);
    setOpen(true);
  }

  function save() {
    setError(null);
    if (!amount || amount <= 0) return setError("Enter an amount.");
    start(async () => {
      const res = await updatePettyCash(tx.id, { tx_date: date, kind, amount, category, description });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button onClick={openModal} className="text-slate-300 hover:text-brand" title="Edit"><Pencil className="h-4 w-4" /></button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit entry"
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} disabled={!amount} />}
      >
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="epc-kind">Type</Label>
            <Select id="epc-kind" value={kind} onChange={(e) => setKind(e.target.value as any)}>
              <option value="expense">Expense (−)</option>
              <option value="replenish">Add cash (+)</option>
            </Select>
          </div>
          <div><Label htmlFor="epc-amt">Amount</Label><NumberInput id="epc-amt" value={amount} onValueChange={setAmount} /></div>
          <div><Label htmlFor="epc-cat">Category</Label><Input id="epc-cat" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Fuel, parts…" /></div>
          <div><Label htmlFor="epc-date">Date</Label><Input id="epc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="col-span-2"><Label htmlFor="epc-desc">Description</Label><Input id="epc-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
      </Modal>
    </>
  );
}
