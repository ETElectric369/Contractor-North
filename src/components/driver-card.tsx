"use client";

import Link from "next/link";
import {
  Briefcase, FileText, Receipt, User, Calendar, CheckSquare, List,
  MapPin, Navigation, ArrowRight, X, ExternalLink,
} from "lucide-react";
import type { AgentHudCard } from "@/lib/assistant-protocol";

const KIND_ICON = {
  job: Briefcase, estimate: FileText, invoice: Receipt,
  customer: User, schedule: Calendar, task: CheckSquare, list: List,
} as const;

/**
 * The DRIVER HUD CARD — the "windshield". Nort fills the N-Box with this glanceable card
 * when you ask it to pull up an entity: who + where, the scope, the big facts, what's next.
 * Driver-safe by construction — big type, one tap to Maps, one tap to the full screen when
 * you're parked, and never a wall of text. The same box swaps to any kind of card.
 */
export function DriverCard({ card, onDismiss }: { card: AgentHudCard; onDismiss: () => void }) {
  const Icon = KIND_ICON[card.kind] ?? Briefcase;
  const mapsUrl = card.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(card.address)}`
    : null;
  const facts = (card.facts ?? []).slice(0, 4);

  return (
    <div className="glass glass-gloss relative m-2 overflow-hidden rounded-2xl p-4">
      <div className="relative z-10 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgb(var(--glass-ink))] px-2.5 py-1 text-[11px] font-medium capitalize text-white">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          {card.eyebrow || card.kind}
        </span>
        <span className="flex-1" />
        <button onClick={onDismiss} aria-label="Clear the card" className="rounded p-1 text-slate-400 hover:bg-white/60">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative z-10 mt-2.5">
        {card.href ? (
          <Link href={card.href} className="group inline-flex items-start gap-1.5">
            <span className="text-2xl font-semibold leading-tight text-[color:rgb(var(--glass-ink))]">{card.title}</span>
            <ExternalLink className="mt-1.5 h-4 w-4 shrink-0 text-[color:rgb(var(--glass-ink))]/60 opacity-0 transition-opacity group-hover:opacity-100" />
          </Link>
        ) : (
          <span className="text-2xl font-semibold leading-tight text-[color:rgb(var(--glass-ink))]">{card.title}</span>
        )}
      </div>

      {card.address && mapsUrl ? (
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="relative z-10 mt-1.5 flex items-center gap-2 text-sm text-[color:rgb(var(--glass-ink))]"
        >
          <MapPin className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{card.address}</span>
          <Navigation className="h-4 w-4 shrink-0" />
        </a>
      ) : null}

      {card.scope ? <p className="relative z-10 mt-2.5 text-sm leading-relaxed text-slate-600">{card.scope}</p> : null}

      {facts.length ? (
        <div className="relative z-10 mt-3 grid grid-cols-2 gap-2">
          {facts.map((f, i) => (
            <div key={i} className="rounded-xl bg-[rgb(var(--glass-tint))]/10 p-3">
              <div className="text-[11px] text-slate-500">{f.label}</div>
              <div className="mt-0.5 truncate text-xl font-semibold text-slate-900">{f.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {card.rows?.length ? (
        <div className="relative z-10 mt-3 overflow-hidden rounded-xl border border-[rgb(var(--glass-ink))]/10">
          {card.rowsTitle ? (
            <div className="bg-[rgb(var(--glass-tint))]/10 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">{card.rowsTitle}</div>
          ) : null}
          <div className="divide-y divide-slate-100">
            {card.rows.map((r, i) => {
              const inner = (
                <div className="flex items-start gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-800">{r.label}</div>
                    {r.sub ? <div className="truncate text-xs text-slate-400">{r.sub}</div> : null}
                  </div>
                  {r.value ? <div className="shrink-0 text-sm font-semibold text-slate-900">{r.value}</div> : null}
                </div>
              );
              return r.href ? (
                <Link key={i} href={r.href} className="block hover:bg-white/60">{inner}</Link>
              ) : (
                <div key={i}>{inner}</div>
              );
            })}
            {card.total ? (
              <div className="flex items-center justify-between gap-3 bg-[rgb(var(--glass-tint))]/10 px-3 py-2">
                <div className="text-sm font-medium text-slate-700">{card.total.label}</div>
                <div className="text-base font-semibold text-[color:rgb(var(--glass-ink))]">{card.total.value}</div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {card.next ? (
        <div className="relative z-10 mt-3 flex items-center gap-2 text-sm text-slate-600">
          <ArrowRight className="h-4 w-4 shrink-0 text-[color:rgb(var(--glass-ink))]" />
          <span className="min-w-0 flex-1">{card.next}</span>
        </div>
      ) : null}
    </div>
  );
}
