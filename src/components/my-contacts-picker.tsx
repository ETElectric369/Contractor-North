"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { BookUser, Loader2, Search } from "lucide-react";
import { searchMyContacts, type MyContact } from "@/app/(app)/settings/carddav-actions";

/**
 * NORTH'S OWN CONTACT PICKER — the sheet Erik kept reaching for and every platform kept
 * half-delivering. Backed by his synced iCloud book (0235), so it answers in milliseconds where
 * Safari chewed for a minute, and it is the SAME sheet on the Mac, the phone, and the installed
 * app — no browser chrome, no platform moods, no "it worked that one time."
 */
export function MyContactsPicker({
  onPick,
  onClose,
}: {
  onPick: (c: MyContact) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MyContact[]>([]);
  const [pending, start] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      start(async () => {
        const res = await searchMyContacts(q);
        if (seq.current === mine && res.ok) setRows(res.contacts);
      });
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[80dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 p-3">
          <BookUser className="h-4 w-4 shrink-0 text-brand" />
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search your contacts…"
              aria-label="Search your contacts"
              className="h-9 w-full rounded-lg border border-slate-200 pl-8 pr-2 text-sm"
            />
          </div>
          <button type="button" onClick={onClose} className="shrink-0 px-1 text-sm font-medium text-slate-500 hover:text-slate-800">
            Cancel
          </button>
        </div>
        <ul className="min-h-40 flex-1 overflow-y-auto">
          {rows.map((c, i) => (
            <li key={`${c.name}-${c.phone}-${i}`}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">{c.name}</span>
                  {c.company && <span className="block truncate text-xs text-slate-400">{c.company}</span>}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">{c.phone ?? ""}</span>
              </button>
            </li>
          ))}
          {!rows.length && !pending && (
            <li className="px-4 py-6 text-center text-sm text-slate-400">
              {q ? "Nobody matches that." : "No contacts synced yet — run a sync from Settings → iCloud Contacts."}
            </li>
          )}
          {pending && !rows.length && (
            <li className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
