"use client";

import { useState, useTransition } from "react";
import { Check, Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DOC_NUMBER_TYPES } from "@/lib/org-settings";
import { saveNumbering } from "./actions";

/** Owner control for the per-org document number prefix + next number, per doc type.
 *  `counters` is the current per-org count per doc_type (null = migration 0088 not applied
 *  yet, so the next-number control is held back but prefixes can still be set). */
export function NumberingSettings({
  prefixes,
  counters,
}: {
  prefixes: Record<string, string>;
  counters: Record<string, number> | null;
}) {
  const live = counters !== null;
  const initialNext = (key: string) => (counters && counters[key] != null ? counters[key] + 1 : 1);

  const [rows, setRows] = useState(() =>
    DOC_NUMBER_TYPES.map((t) => ({
      key: t.key,
      label: t.label,
      prefix: prefixes[t.key] ?? t.fallback,
      next: initialNext(t.key),
      origNext: initialNext(t.key),
    })),
  );
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: string, patch: Partial<{ prefix: string; next: number }>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDone(false);
  }

  const pad = (n: number) => String(Math.max(1, Math.floor(n || 1))).padStart(5, "0");

  function save() {
    setError(null);
    setDone(false);
    const prefixMap: Record<string, string> = {};
    const nextMap: Record<string, number> = {};
    for (const r of rows) {
      const p = r.prefix.trim();
      if (!p) return setError(`${r.label} needs a prefix.`);
      prefixMap[r.key] = p;
      if (live && r.next !== r.origNext) nextMap[r.key] = r.next; // only send what actually changed
    }
    start(async () => {
      const res = await saveNumbering(prefixMap, nextMap);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setRows((rs) => rs.map((r) => ({ ...r, origNext: r.next })));
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="flex items-center gap-2 font-medium text-slate-900">
          <Hash className="h-4 w-4 text-slate-400" /> Document numbering
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          Set the prefix and next number for each document type. Numbers are unique per type and
          per organization; changes only affect documents created from here on.
        </p>
      </div>

      {!live && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          The next-number control activates once migration <span className="font-mono">0088</span> is
          applied in Supabase. You can set prefixes now — they take effect after that.
        </p>
      )}

      <div className="space-y-2">
        <div className="hidden gap-3 px-1 text-xs font-medium uppercase tracking-wide text-slate-400 sm:grid sm:grid-cols-[1fr_110px_110px_minmax(0,1fr)]">
          <span>Document</span>
          <span>Prefix</span>
          <span>Next #</span>
          <span>Preview</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.key}
            className="grid grid-cols-2 items-center gap-3 sm:grid-cols-[1fr_110px_110px_minmax(0,1fr)]"
          >
            <span className="text-sm font-medium text-slate-700">{r.label}</span>
            <Input
              value={r.prefix}
              maxLength={10}
              aria-label={`${r.label} prefix`}
              onChange={(e) => set(r.key, { prefix: e.target.value })}
            />
            <Input
              type="number"
              min={1}
              value={r.next}
              disabled={!live}
              aria-label={`${r.label} next number`}
              onChange={(e) => set(r.key, { next: Number(e.target.value) })}
            />
            <span className="truncate font-mono text-sm text-slate-500">
              {r.prefix.trim()}
              {pad(r.next)}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save numbering"}
        </Button>
        {done && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </Card>
  );
}
