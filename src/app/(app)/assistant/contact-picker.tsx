"use client";

import { useEffect, useState, useTransition } from "react";
import { Search, X, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { searchContacts, type PickerContact } from "./actions";
import type { AgentPick } from "@/lib/assistant-protocol";

/** The on-screen contact picker the assistant pops via request_contact. Pre-filled with whatever
 *  name the user said; they search + TAP, and the choice goes back to the assistant as the next
 *  message. The "say the name, pick it on screen, keep building" handoff. */
export function ContactPicker({
  pick,
  onSelect,
  onCancel,
}: {
  pick: AgentPick;
  onSelect: (c: PickerContact) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(pick.search ?? "");
  const [results, setResults] = useState<PickerContact[]>([]);
  const [pending, start] = useTransition();

  useEffect(() => {
    const t = setTimeout(() => {
      start(async () => setResults(await searchContacts(query, pick.type)));
    }, 200);
    return () => clearTimeout(t);
  }, [query, pick.type]);

  return (
    <div className="fixed inset-0 z-[130] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">
            Pick a contact{pick.type ? ` · ${pick.type}` : ""}
          </h3>
          <button onClick={onCancel} aria-label="Cancel" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or company…"
            className="pl-9"
          />
        </div>
        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {results.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">{pending ? "Searching…" : "No matching contacts."}</p>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                onClick={() => onSelect(c)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-brand/5"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
                  <User className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">{c.name}</span>
                  <span className="block truncate text-xs text-slate-400">
                    {[c.company, c.city, c.type].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
