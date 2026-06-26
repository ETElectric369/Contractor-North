"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Sparkles, Plus, ArrowRight } from "lucide-react";
import { DOCK } from "@/lib/dock";

type Item = { kind: string; label: string; sub?: string; href: string };

// ONE source of truth: the command bar's "go to" list is derived from the SAME dock that
// drives the dock + sub-nav, so they can never drift again. Assistant is reached via the
// Talk button + the "ask the assistant" row (not a duplicate "go to"); creates live only in
// the global quick-add "+".
// Flatten the dock into searchable destinations — recursing into the nested "More" hubs
// (Schedule, Sales, Office…) so every page stays reachable from the command bar.
type DockLeaf = { label: string; href?: string; children?: DockLeaf[] };
function navLeaves(nodes: DockLeaf[], sub: string): Item[] {
  return nodes.flatMap((n) =>
    n.children?.length
      ? navLeaves(n.children, n.label)
      : n.href
        ? [{ kind: "Go to", label: n.label, sub, href: n.href }]
        : [],
  );
}
const NAV_ITEMS: Item[] = DOCK.flatMap((s) => navLeaves(s.children, s.label));

function LeadIcon({ kind }: { kind: string }) {
  if (kind === "Assistant") return <Sparkles className="h-4 w-4 text-brand" />;
  if (kind === "Create") return <Plus className="h-4 w-4 text-slate-400" />;
  if (kind === "Go to") return <ArrowRight className="h-4 w-4 text-slate-400" />;
  return <Search className="h-4 w-4 text-slate-400" />;
}

/**
 * Global command palette (⌘K / Ctrl-K, or the topbar search button). Searches
 * the org's jobs/customers/quotes/invoices, jumps to any page, or hands the
 * query to the Assistant. Deep-links use Wave-1's ?tab= where useful.
 */
export function CommandBar() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open via ⌘K / Ctrl-K, or the topbar "cn:command" event. Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    function onEvt() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("cn:command", onEvt as EventListener);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cn:command", onEvt as EventListener);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setResults([]);
      setSel(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced live entity search.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
        const data = await res.json();
        setResults(
          (data.results ?? []).map((r: any) => ({ kind: r.type, label: r.label, sub: r.sub, href: r.href })),
        );
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const staticMatches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return NAV_ITEMS.slice(0, 7);
    return NAV_ITEMS.filter((i) => i.label.toLowerCase().includes(term)).slice(0, 6);
  }, [q]);

  const askItem: Item | null = q.trim()
    ? { kind: "Assistant", label: `Ask the assistant: “${q.trim()}”`, href: `/assistant?q=${encodeURIComponent(q.trim())}` }
    : null;

  const flat: Item[] = useMemo(
    () => [...staticMatches, ...results, ...(askItem ? [askItem] : [])],
    [staticMatches, results, askItem],
  );

  useEffect(() => {
    setSel(0);
  }, [q]);

  function go(item: Item) {
    setOpen(false);
    router.push(item.href);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center p-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div
        className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-4">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const it = flat[sel];
                if (it) go(it);
              }
            }}
            placeholder="Search jobs, customers, quotes… or jump to a page"
            className="flex-1 bg-transparent py-3.5 text-sm outline-none placeholder:text-slate-400"
          />
          {loading && <span className="shrink-0 text-[11px] text-slate-400">…</span>}
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-1">
          {flat.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              No matches. Press Enter to ask the assistant.
            </div>
          )}
          {flat.map((it, i) => (
            <button
              key={`${i}-${it.href}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(it)}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${i === sel ? "bg-brand-light/50" : "hover:bg-slate-50"}`}
            >
              <span className="shrink-0">
                <LeadIcon kind={it.kind} />
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-800">{it.label}</span>
              {it.sub && <span className="hidden shrink-0 text-xs text-slate-400 sm:inline">{it.sub}</span>}
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{it.kind}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          <span>↑↓ to navigate · ↵ to open · esc to close</span>
          <span className="rounded border border-slate-200 px-1.5 py-0.5">⌘K</span>
        </div>
      </div>
    </div>
  );
}
