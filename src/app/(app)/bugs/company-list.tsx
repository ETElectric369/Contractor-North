"use client";

import { useState } from "react";
import { AlertTriangle, Building2 } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { toneClasses, type Tone } from "@/components/ui/badge";
import { formatDate, formatDateShort } from "@/lib/utils";
import { tzDayStartUtc } from "@/lib/tz";
import { planByTier } from "@/lib/plans";
import { useToast } from "@/components/toast";
import { setCompedUntil, type CompanyRow } from "./company-actions";

/**
 * EVERY COMPANY'S STANDING, ON BUG WATCH (cn-v1137). Modelled on error-list.tsx: a row per company
 * with the standing the server computed (accessState, never re-derived here), a date box and Comp
 * Until, End Comp when the comp is the column's, an optimistic change with a toast revert, and a
 * failed read said where the list would be — never an empty run over a refusal.
 */

/** The pill, from the ONE palette (ui/badge). */
export function standingPill(reason: CompanyRow["reason"]): { word: string; tone: Tone } {
  if (reason === "comped") return { word: "Comped", tone: "purple" };
  if (reason === "active") return { word: "Active", tone: "green" };
  if (reason === "trial") return { word: "Trial", tone: "blue" };
  if (reason === "grace") return { word: "Grace", tone: "amber" };
  if (reason === "unknown") return { word: "Unknown", tone: "slate" };
  return { word: "Lapsed", tone: "red" };
}

const dayWords = (n: number) => (n === 0 ? "Today" : n === 1 ? "1 Day" : `${n} Days`);

/** One line from the reason — the words, never the math. */
export function standingLine(row: Pick<CompanyRow, "reason" | "daysLeft" | "compedBy" | "trialEndsAt" | "compedUntil" | "tz">): string {
  switch (row.reason) {
    case "comped":
      return row.compedBy === "env" ? "Comped By Env" : `Comped Until ${formatDate(row.compedUntil, row.tz)}`;
    case "active":
      return "Active";
    case "trial":
      if (row.daysLeft === null || !row.trialEndsAt) return "Trial (No End Date)";
      return `Trial Ends ${formatDateShort(row.trialEndsAt, row.tz)} (${dayWords(row.daysLeft)})`;
    case "grace":
      return `Grace: ${row.daysLeft ?? 0} ${row.daysLeft === 1 ? "Day" : "Days"} Left`;
    case "trial_ended":
      return "Lapsed: Trial Ended";
    case "grace_spent":
      return "Lapsed: Card Not Updated";
    case "canceled":
      return "Lapsed: Canceled";
    default:
      return "Unknown";
  }
}

/** The plan's word: a tier's name, the trial's, or the stored word as it is. */
export function planWord(plan: string | null): string {
  if (!plan) return "No Plan";
  const tier = planByTier(plan);
  if (tier) return tier.name;
  if (plan === "trial") return "Trial";
  return plan;
}

/** The instant a comp picked as a calendar day ends: the last second of that day in the company's
 *  own zone, so "Comp Until Nov 30" reads Nov 30 on the row and lapses at the company's midnight. */
export function compedUntilIso(ymd: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = tzDayStartUtc(next, tz).getTime() - 1000;
  return Number.isNaN(end) ? null : new Date(end).toISOString();
}

const DOOR = "rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50";

/** One row: the name, the plan, the pill, the standing line, the date box and its doors. The row
 *  holds its own date; the list owns the rows. */
export function CompanyRowView({ row, onComp, onEndComp }: { row: CompanyRow; onComp: (untilIso: string) => void; onEndComp: () => void }) {
  const [date, setDate] = useState("");
  const pill = standingPill(row.reason);
  const iso = date ? compedUntilIso(date, row.tz) : null;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-800">{row.name}</span>
            <span className="text-xs text-slate-500">{planWord(row.plan)}</span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneClasses(pill.tone)}`}>{pill.word}</span>
          </div>
          <div className="mt-0.5 text-sm text-slate-700">{standingLine(row)}</div>
          {/* "Stripe Customer", not "Card On File": the customer is minted before any payment (S11). */}
          <div className="mt-0.5 text-xs text-slate-400">{`Since ${formatDate(row.createdAt, row.tz)}${row.stripeCustomer ? " · Stripe Customer" : ""}`}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Input type="date" aria-label="Comp Until Date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 w-40 text-xs" />
          <button type="button" disabled={!iso} onClick={() => iso && onComp(iso)} className={DOOR}>
            Comp Until
          </button>
          {row.compedBy === "column" && (
            <button type="button" onClick={onEndComp} className={`${DOOR} text-red-600 hover:bg-red-50`}>
              End Comp
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** `readError`: the companies read failed; the page says so instead of an empty list. */
export function CompanyList({ initial, readError = null }: { initial: CompanyRow[]; readError?: string | null }) {
  const [rows, setRows] = useState<CompanyRow[]>(initial);
  const toast = useToast();

  async function comp(id: string, untilIso: string | null) {
    const before = rows.find((r) => r.id === id);
    if (!before) return;
    // A day that has already passed is refused here too, before the row moves (the server's own rule).
    if (untilIso && Date.parse(untilIso) <= Date.now()) {
      toast("Pick a day after today.", "error");
      return;
    }
    // Optimistic, and never silent: a refused comp puts the row back and says why. The standing a
    // comp falls back to is the server's own `uncomped` answer — no billing math here.
    const after: CompanyRow = untilIso
      ? { ...before, compedUntil: untilIso, active: true, reason: "comped", daysLeft: null, compedBy: "column" }
      : { ...before, compedUntil: null, ...before.uncomped };
    setRows((p) => p.map((r) => (r.id === id ? after : r)));
    const res = await setCompedUntil(id, untilIso).catch(() => ({ ok: false, error: "Couldn't reach the server. Try again." }));
    if (!res.ok) {
      setRows((p) => p.map((r) => (r.id === id ? before : r)));
      toast(res.error ?? "Couldn't change that comp.", "error");
      return;
    }
    toast(untilIso ? `${before.name} is comped until ${formatDate(untilIso, before.tz)}.` : `${before.name}'s comp ended.`, "success");
  }

  return (
    <div>
      {readError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't read the companies" description={readError} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Building2} title="No companies yet" description="The first sign-up lands here." />
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {rows.map((r) => (
            <CompanyRowView key={r.id} row={r} onComp={(iso) => comp(r.id, iso)} onEndComp={() => comp(r.id, null)} />
          ))}
        </ul>
      )}
    </div>
  );
}
