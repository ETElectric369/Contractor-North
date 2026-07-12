"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Sparkles, Loader2, Save, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { QuoteCircuit } from "@/lib/types";
import { generateCircuitSchedule, saveCircuitSchedule } from "../actions";

const blank = (): QuoteCircuit => ({ ckt: "", description: "", wire: "", breaker: "", load: "" });

/** Circuit schedule editor — the panel layout that prints as a second page on the estimate. */
export function CircuitScheduleCard({ quoteId, initial }: { quoteId: string; initial: QuoteCircuit[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<QuoteCircuit[]>(initial.length ? initial : []);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, startGen] = useTransition();
  const [saving, startSave] = useTransition();

  const set = (i: number, patch: Partial<QuoteCircuit>) => {
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
    setDirty(true);
  };
  const addRow = () => { setRows((r) => [...r, { ...blank(), ckt: String(r.length + 1) }]); setDirty(true); };
  const delRow = (i: number) => { setRows((r) => r.filter((_, j) => j !== i)); setDirty(true); };

  function generate() {
    setError(null);
    startGen(async () => {
      const res = await generateCircuitSchedule(quoteId);
      if (!res.ok) return setError(res.error);
      setRows(res.circuits);
      setDirty(false);
      router.refresh(); // pull the stored copy through to the print page
    });
  }
  function save() {
    setError(null);
    startSave(async () => {
      const res = await saveCircuitSchedule(quoteId, rows);
      if (!res.ok) return setError(res.error ?? "Couldn't save.");
      setDirty(false);
      router.refresh();
    });
  }

  return (
    <Card className="mt-6">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-brand" />
          <span className="text-sm font-semibold text-slate-900">Circuit schedule</span>
          <span className="text-xs text-slate-400">· prints as a second page</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={generate} disabled={generating || saving}>
            {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> Reading…</> : <><Sparkles className="h-4 w-4" /> {rows.length ? "Regenerate" : "Generate from line items"}</>}
          </Button>
          {dirty && (
            <Button size="sm" onClick={save} disabled={saving || generating}>
              {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><Save className="h-4 w-4" /> Save</>}
            </Button>
          )}
        </div>
      </div>

      {error && <div className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-slate-400">
          No circuit schedule yet — Generate one from the breakers &amp; wire in the line items, or add rows by hand.
        </p>
      ) : (
        <div className="overflow-x-auto px-2 py-2">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="w-14 px-2 py-1.5 font-semibold">Ckt</th>
                <th className="px-2 py-1.5 font-semibold">Description</th>
                <th className="w-24 px-2 py-1.5 font-semibold">Wire</th>
                <th className="w-24 px-2 py-1.5 font-semibold">Breaker</th>
                <th className="w-40 px-2 py-1.5 font-semibold">Load / notes</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-1 py-1"><Input value={r.ckt ?? ""} onChange={(e) => set(i, { ckt: e.target.value })} className="text-center" /></td>
                  <td className="px-1 py-1"><Input value={r.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                  <td className="px-1 py-1"><Input value={r.wire ?? ""} onChange={(e) => set(i, { wire: e.target.value })} placeholder="12/2" /></td>
                  <td className="px-1 py-1"><Input value={r.breaker ?? ""} onChange={(e) => set(i, { breaker: e.target.value })} placeholder="20A" /></td>
                  <td className="px-1 py-1"><Input value={r.load ?? ""} onChange={(e) => set(i, { load: e.target.value })} /></td>
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => delRow(i)} className="text-slate-400 hover:text-red-600" aria-label="Remove circuit"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-slate-100 px-5 py-3">
        <Button size="sm" variant="outline" onClick={addRow} disabled={generating}>
          <Plus className="h-4 w-4" /> Add circuit
        </Button>
      </div>
    </Card>
  );
}
