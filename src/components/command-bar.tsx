"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Sparkles, Plus, ArrowRight, Mic, GraduationCap, ChevronDown } from "lucide-react";
import { visibleDock } from "@/lib/dock";
import { featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";
import { isApplePlatform, modKeyLabel } from "@/lib/mod-key";
import { helpRows, openSetup, talkToNort } from "@/lib/onboarding/help-rows";
import type { Answers } from "@/lib/playbook/types";

type Item = {
  kind: string;
  label: string;
  sub?: string;
  href: string;
  staffOnly?: boolean;
  aliases?: string[];
  /** A row that DOES something instead of going somewhere (Talk To Nort, the help rows). It runs
   *  first thing in the tap (go), before anything else, so iOS still counts it as the gesture. */
  run?: () => void;
  /** Show Me How: folding its lessons open keeps the sheet open. */
  keepOpen?: boolean;
  /** Show Me How's fold state, for its chevron and aria-expanded. */
  expanded?: boolean;
};

// Synonyms so search finds a page by what the owner CALLS it, not just its label. Keyed by the
// page's href (the stable id) so it survives label/section renames. Lowercase; matched as
// substrings, same as the label. Extend freely — this is the one place aliases live.
const NAV_ALIASES: Record<string, string[]> = {
  // ONE INVOICES PAGE (W1-29): who owes (Accounts Receivable's words) and what came in (Payments')
  // both land here now; /billing/ar and /payments are redirects with no row of their own.
  "/billing": [
    "money", "billing", "invoice",
    "ar", "owed", "receivables", "accounts receivable", "who owes", "aging",
    "payments", "paid", "received", "deposit", "collections",
  ],
  "/bills": ["ap", "accounts payable", "vendor", "expense"],
  "/payroll": ["wages", "pay", "salary", "paycheck", "hours pay"],
  "/tax-report": ["taxes", "1099", "irs", "tax"],
  "/analytics": ["reports", "reporting", "kpi", "dashboard", "numbers", "profit"],
  "/price-list": ["pricing", "rates", "catalog", "price book", "materials list", "line items"],
  "/leads": ["prospects", "inquiries", "pipeline"],
  "/quotes": ["estimate", "proposal", "bid"],
  "/crm": ["customers", "clients", "people", "contact", "contacts"],
  // The Reminders page was "Tasks" until 0358, and people still type the old word.
  "/tasks": ["tasks", "to-do", "todo"],
  "/timeclock": ["clock in", "punch", "clock"],
  "/timecards": ["hours", "timesheet"],
  "/schedule": ["calendar", "dispatch", "appointments"],
  // "All", the Jobs sub-nav's first row (b94497dd): the unfiltered page, which is what a person
  // means by "jobs" or "work". The ?status= rows stay out of the palette (see the collision note).
  "/jobs": ["jobs", "projects", "work", "all jobs"],
  "/inventory": ["stock", "shop stock", "shelf", "inventory", "warehouse", "parts"],
  "/compliance": ["osha", "liability", "regulations"],
  "/insurance": ["workers comp", "coverage", "liability"],
  "/safety": ["osha", "incident", "hazard"],
  "/tools": ["calculator", "calculators", "nec", "wire size"],
  // Plans live with the estimator now (Erik 2026-07-14) — typing plan/blueprint/take-off
  // lands on New Estimate, where the Upload Plans take-off actually is.
  "/quotes/new": ["plan", "plans", "blueprint", "drawing", "take-off", "takeoff", "upload plans"],
};
// Words that belong to a SWITCH, not to the page they land on (the switch board, 0352): they
// leave the palette with their feature, so "po" can't find Bills while Purchase Orders is off.
// (Words that ride on a page, like "/leads" or "/inventory" above, go with the page's dock row.)
const SWITCH_ALIASES: { href: string; feature: FeatureKey; words: string[] }[] = [
  { href: "/bills", feature: "purchase_orders", words: ["purchase order", "po"] },
  { href: "/price-list", feature: "kits", words: ["kit", "kits"] },
  { href: "/recurring", feature: "recurring_billing", words: ["subscription", "repeat invoice", "auto invoice"] },
];
function aliasesFor(href: string, features: FeatureMap | null | undefined): string[] | undefined {
  const extra = SWITCH_ALIASES.filter((a) => a.href === href && featureOn(features, a.feature)).flatMap((a) => a.words);
  const base = NAV_ALIASES[href];
  return extra.length ? [...(base ?? []), ...extra] : base;
}

// ONE source of truth: the command bar's "go to" list is derived from the SAME dock that
// drives the dock + sub-nav, so they can never drift again. Carry staffOnly (section OR item)
// so we can role-filter — a tech shouldn't be shown Payroll / Tax / Invoices (L11).
// Query-param children (the generated /jobs?status=… filters) stay OUT of the palette:
// stripped of their section context they collide — "est" surfaced "Estimate · Jobs" (a jobs
// filter) beside "Estimates · Sales" (/quotes). Status filtering is the dock/strip's job.
// THE SWITCH BOARD (0352) rides on the same list: it is built from visibleDock (role AND
// switches), so a page whose dock row is switched off is not offered here either.
type DockLeaf = { label: string; href?: string; children?: DockLeaf[]; staffOnly?: boolean };
function navLeaves(nodes: DockLeaf[], sub: string, features: FeatureMap | null | undefined, sectionStaff?: boolean): Item[] {
  return nodes.flatMap((n) =>
    n.children?.length
      ? navLeaves(n.children, n.label, features, sectionStaff || n.staffOnly)
      : n.href && !n.href.includes("?")
        ? [{ kind: "Go to", label: n.label, sub, href: n.href, staffOnly: sectionStaff || n.staffOnly, aliases: aliasesFor(n.href, features) }]
        : [],
  );
}
// The Jobs section's "All" row carries the plain /jobs href again (b94497dd), so the generated list
// answers "jobs"/"work"/"projects" by itself and the hand-written entry that stood in for it is gone
// — one leaf, not two. The GENERATED ?status= children still stay out (see the collision note above).
/**
 * PETTY CASH, FOUND BY NAME (W1-34): it left the Money menu, so a company that already has petty-cash
 * rows (the layout's staff-only existence check) finds the page here, by its own words. A company
 * with none sees no row: a new cash purchase is a cost like any other (Snap Or Note, Add By Hand).
 */
const PETTY_CASH_ROW: Item = {
  kind: "Go to",
  label: "Petty Cash",
  sub: "Money",
  href: "/petty-cash",
  staffOnly: true,
  aliases: ["petty cash", "cash box", "cash", "atm"],
};

/** The palette's "go to" list for this person: exported so the switch rule is pinned in a test. */
export function commandNavItems(isStaff: boolean, features?: FeatureMap | null, hasPettyCash = false): Item[] {
  const items: Item[] = [
    ...visibleDock({ isStaff, features }).flatMap((s) => navLeaves(s.children, s.label, features, s.staffOnly)),
    // Today is My Day alone on the dock (W1-03), so its two old pills are found here by name:
    // Reminders for everyone, Organize for the office (every save on it is requireStaff).
    { kind: "Go to", label: "Reminders", sub: "Today", href: "/tasks", aliases: NAV_ALIASES["/tasks"] },
    { kind: "Go to", label: "Organize", sub: "Today", href: "/organize", staffOnly: true },
    // The Clock tile is a tech's only (W1-08): staff clock in on My Day's Now card, and their
    // Timecards row only OWNS /timeclock (owns is never a row). So the office finds the Timeclock
    // (Switch Job, Split) here by name and by its words ("clock in", "punch"); a tech already has
    // it once, from his Clock tile, so this entry is staff-only and he never sees it twice.
    { kind: "Go to", label: "Timeclock", sub: "Money", href: "/timeclock", staffOnly: true, aliases: NAV_ALIASES["/timeclock"] },
    // New Estimate isn't a dock leaf, but it's where plan take-offs live now (Upload Plans) —
    // give plan/blueprint/take-off searches somewhere real to land. It goes with Estimates.
    ...(featureOn(features, "estimates")
      ? [{ kind: "Go to", label: "New Estimate", sub: "Sales", href: "/quotes/new", staffOnly: true, aliases: NAV_ALIASES["/quotes/new"] }]
      : []),
    ...(hasPettyCash ? [PETTY_CASH_ROW] : []),
  ];
  return isStaff ? items : items.filter((i) => !i.staffOnly);
}

/** The pages that answer what was typed. Match the label, the parent section, OR any synonym — so
 *  "owed"/"AR" finds Invoices and "wages" finds Payroll. Label hits rank above alias-only hits.
 *  Exported so a page's words are pinned in a test (staff typing "clock in" find the Timeclock). */
export function matchNavItems(navItems: Item[], q: string): Item[] {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const scored = navItems
    .map((i) => {
      const label = i.label.toLowerCase().includes(term);
      const sub = i.sub?.toLowerCase().includes(term) ?? false;
      const alias = i.aliases?.some((a) => a.includes(term) || term.includes(a)) ?? false;
      return { i, hit: label || sub || alias, rank: label ? 0 : sub ? 1 : 2 };
    })
    .filter((s) => s.hit)
    .sort((a, b) => a.rank - b.rank);
  return scored.slice(0, 6).map((s) => s.i);
}

/**
 * WHAT SEARCH OR ASK SHOWS BEFORE ANYTHING IS TYPED (W1-09), above the first pages:
 *   Talk To Nort   first, with Nort on (it starts the mic inside its own tap: talkToNort)
 *   the help rows  staff, with Nort on (lib/onboarding/help-rows): Start Here or Finish Setting Up,
 *                  Show Me How (its lessons fold open under it), Take The Setup Again. With Nort
 *                  off the same rows sit under Help in the avatar menu instead.
 * Exported so the rows, their order and their switch rules are pinned in a test.
 */
export function idleRows({
  isStaff,
  features,
  setup,
  onboarded,
  lessonsOpen = false,
  toggleLessons = () => {},
}: {
  isStaff: boolean;
  features?: FeatureMap | null;
  setup?: Answers | null;
  onboarded: boolean;
  lessonsOpen?: boolean;
  toggleLessons?: () => void;
}): Item[] {
  if (!featureOn(features, "nort")) return [];
  const rows: Item[] = [{ kind: "Nort", label: "Talk To Nort", sub: "Say it out loud", href: "#talk-to-nort", run: talkToNort }];
  for (const r of helpRows({ isStaff, onboarded, setup, nortOn: true, features })) {
    if (r.key === "lessons") {
      rows.push({ kind: "Help", label: r.label, sub: r.sub, href: "#show-me-how", run: toggleLessons, keepOpen: true, expanded: lessonsOpen });
      if (lessonsOpen) {
        for (const l of r.lessons) rows.push({ kind: "Help", label: l.label, sub: l.sub, href: `#${l.request}`, run: () => openSetup(l.request) });
      }
    } else {
      rows.push({ kind: "Help", label: r.label, sub: r.sub, href: `#${r.request}`, run: () => openSetup(r.request) });
    }
  }
  return rows;
}

function LeadIcon({ kind }: { kind: string }) {
  if (kind === "Nort") return <Mic className="h-4 w-4 text-brand" />;
  if (kind === "Help") return <GraduationCap className="h-4 w-4 text-slate-400" />;
  if (kind === "Assistant") return <Sparkles className="h-4 w-4 text-brand" />;
  if (kind === "Create") return <Plus className="h-4 w-4 text-slate-400" />;
  if (kind === "Go to") return <ArrowRight className="h-4 w-4 text-slate-400" />;
  return <Search className="h-4 w-4 text-slate-400" />;
}

/**
 * SEARCH OR ASK — the global command palette (⌘K / Ctrl-K, or the top bar's Search Or Ask).
 * Searches the org's jobs/customers/quotes/invoices, jumps to any page, or hands the query to
 * Nort. With nothing typed it leads with Talk To Nort and, for staff, the setup rows the old
 * graduation cap held (idleRows). Deep-links use Wave-1's ?tab= where useful.
 */
export function CommandBar({
  isStaff,
  features,
  setup,
  onboarded = true,
  hasPettyCash = false,
}: {
  isStaff?: boolean;
  features?: FeatureMap;
  /** The company's setup answers (the layout's), for Finish Setting Up · N Left. */
  setup?: Answers;
  /** profiles.onboarded_at: Start Here shows until this person has been walked through. */
  onboarded?: boolean;
  /** The company has petty-cash rows (the layout's staff-only check): offer the Petty Cash row. */
  hasPettyCash?: boolean;
}) {
  const router = useRouter();
  const navItems = useMemo(() => commandNavItems(!!isStaff, features, hasPettyCash), [isStaff, features, hasPettyCash]);
  // Nort off: no "Ask Nort" row, no Talk To Nort, no help rows (they're under Help in the avatar
  // menu), and no promise that Enter asks him (the drawer isn't mounted).
  const nortOn = featureOn(features, "nort");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  // Show Me How's lessons, folded under it until it's picked.
  const [lessonsOpen, setLessonsOpen] = useState(false);
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
      setLessonsOpen(false);
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

  const idle = useMemo(
    () => idleRows({ isStaff: !!isStaff, features, setup, onboarded, lessonsOpen, toggleLessons: () => setLessonsOpen((v) => !v) }),
    [isStaff, features, setup, onboarded, lessonsOpen],
  );

  const staticMatches = useMemo(() => {
    if (!q.trim()) return [...idle, ...navItems.slice(0, 7)];
    return matchNavItems(navItems, q);
  }, [q, navItems, idle]);

  const askItem: Item | null = useMemo(
    () => (q.trim() && nortOn ? { kind: "Assistant", label: `Ask Nort: “${q.trim()}”`, href: `/assistant?q=${encodeURIComponent(q.trim())}` } : null),
    [q, nortOn],
  );

  const flat: Item[] = useMemo(
    () => [...staticMatches, ...results, ...(askItem ? [askItem] : [])],
    [staticMatches, results, askItem],
  );

  useEffect(() => {
    setSel(0);
  }, [q]);

  function go(item: Item) {
    // A row that DOES something runs FIRST, synchronously, in the tap that picked it: Talk To Nort
    // starts the mic from inside this click (iOS refuses it any later), and a help row unlocks
    // audio here so Nort's first line plays. Nothing may come between the tap and run().
    if (item.run) {
      item.run();
      if (!item.keepOpen) setOpen(false);
      return;
    }
    setOpen(false);
    // The assistant is the slim drawer now — open it (with the typed question) instead of a page.
    if (item.kind === "Assistant") {
      const ask = new URL(item.href, window.location.origin).searchParams.get("q") ?? "";
      window.dispatchEvent(new CustomEvent("cn:assistant-open", { detail: { q: ask } }));
      return;
    }
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
            placeholder={nortOn ? "Search or ask Nort…" : "Search jobs, customers, quotes… or jump to a page"}
            className="flex-1 bg-transparent py-3.5 text-sm outline-none placeholder:text-slate-400"
          />
          {loading && <span className="shrink-0 text-[11px] text-slate-400">…</span>}
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-1">
          {flat.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              {nortOn ? "No matches. Press Enter to ask Nort." : "No matches."}
            </div>
          )}
          {flat.map((it, i) => (
            <button
              key={`${i}-${it.href}`}
              onMouseEnter={() => setSel(i)}
              // go() runs a doing row (Talk To Nort, a help row) before anything else in this tap.
              onClick={() => go(it)}
              aria-expanded={it.expanded}
              className={`flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${i === sel ? "bg-brand-light/50" : "hover:bg-slate-50"}`}
            >
              <span className="shrink-0">
                <LeadIcon kind={it.kind} />
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-800">{it.label}</span>
              {it.sub && <span className="hidden min-w-0 max-w-[45%] shrink truncate text-xs text-slate-400 sm:inline">{it.sub}</span>}
              {it.expanded !== undefined && (
                <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${it.expanded ? "rotate-180" : ""}`} />
              )}
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{it.kind}</span>
            </button>
          ))}
        </div>

        {/* THE KEYBOARD LINE ONLY WHERE THERE IS A KEYBOARD (W1-12). On a phone it named keys
            nobody has; a width breakpoint can't tell an iPad from a laptop, the pointer can
            (Tailwind's pointer-fine: a mouse or a trackpad). The chip names this computer's key. */}
        <div className="hidden pointer-fine:flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          <span>↑↓ to navigate · ↵ to open · esc to close</span>
          <span className="rounded border border-slate-200 px-1.5 py-0.5">{modKeyLabel(isApplePlatform())}</span>
        </div>
      </div>
    </div>
  );
}
