"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Sparkles, Plus, ArrowRight, Mic, GraduationCap, ChevronDown } from "lucide-react";
import { visibleDock } from "@/lib/dock";
import { dockLabel, dockTileLabel } from "@/lib/dock-words";
import { fillText, translator, type Lang } from "@/lib/i18n";
import { useLang } from "@/components/lang-provider";
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
// IN BOTH LANGUAGES (cn-v1139): the Spanish words a person types sit beside the English on every
// row, whatever language the screen is in — the dock's own Spanish (Agenda, Nómina, Reloj…) and
// the words the office's map does not wear (calendario, sueldos, checar). Accents are optional
// on both sides: the matcher folds them (foldSearch), so "nomina" finds Nómina.
const NAV_ALIASES: Record<string, string[]> = {
  "/planner": ["mi día", "hoy"],
  // ONE INVOICES PAGE (W1-29): who owes (Accounts Receivable's words) and what came in (Payments')
  // both land here now; /billing/ar and /payments are redirects with no row of their own.
  "/billing": [
    "money", "billing", "invoice",
    "ar", "owed", "receivables", "accounts receivable", "who owes", "aging",
    "payments", "paid", "received", "deposit", "collections",
    "dinero", "facturas", "factura", "facturación", "cobros", "pagos", "deben",
  ],
  "/bills": ["ap", "accounts payable", "vendor", "expense", "cuentas", "cuenta", "gastos", "proveedor", "recibos"],
  // RECONCILE (cn-v1037) shipped findable only by its own exact name. Its rows are what a person
  // actually types: a supplier's statement against our tickets, one supplier spelled five ways, the
  // same ticket on two jobs (lib/reconcile-kinds carries the headings these words come from).
  "/reconcile": [
    "reconcile", "statement", "statements", "supplier statement", "spelling", "spellings", "duplicate", "duplicates", "same ticket",
    "conciliar", "conciliación", "estado de cuenta", "duplicados",
  ],
  "/payroll": ["wages", "pay", "salary", "paycheck", "hours pay", "nómina", "sueldos", "salarios", "pago"],
  "/tax-report": ["taxes", "1099", "irs", "tax", "reporte de impuestos", "impuestos", "impuesto"],
  "/analytics": ["reports", "reporting", "kpi", "dashboard", "numbers", "profit", "análisis", "reportes", "informes", "ganancias", "números"],
  "/analytics/accountant": ["contador", "contabilidad"],
  "/recurring": ["recurrentes", "recurrente", "repetir"],
  "/price-list": ["pricing", "rates", "catalog", "price book", "materials list", "line items", "lista de precios", "precios", "catálogo", "tarifas"],
  "/leads": ["prospects", "inquiries", "pipeline", "ventas", "prospectos", "prospecto", "consultas", "solicitudes"],
  // EVERY WORD THIS PAGE HAS EVER WORN STILL FINDS IT. cn-v1034 (2026-09-30) renamed the dock row
  // from Inspections to Walk-Throughs and added no aliases here, so "inspection" stopped matching
  // the LABEL and found NOTHING — while the route, the stored type and Nort's own description all
  // still said it. 33f527a0 (2026-10-01) wrote these aliases; the row is Inspections again
  // (2026-10-03, the owner's word), and the Walk-Through spellings stay for the people who learned
  // them in between. Each spelling is written out because a search matches the label or an alias,
  // never a word's other shapes: "walk-through" and "walkthrough" and "walk through" are three strings.
  "/inspections": [
    "inspection", "inspections", "walk-through", "walk-throughs", "walkthrough", "walk through", "site visit", "visit",
    "inspecciones", "inspección", "visita",
  ],
  "/quotes": ["estimate", "proposal", "bid", "quote", "quotes", "presupuestos", "presupuesto", "cotización", "cotizaciones", "propuesta"],
  "/crm": ["customers", "clients", "people", "contact", "contacts", "clientes", "cliente", "contactos"],
  // The Reminders page was "Tasks" until 0358, and people still type the old word.
  "/tasks": ["tasks", "to-do", "todo", "recordatorios", "tareas", "pendientes"],
  "/organize": ["organizar", "papeles"],
  "/timeclock": ["clock in", "punch", "clock", "timeclock", "reloj", "marcar entrada", "checar"], // the one word, since the label reads Time Clock (cn-v1128)
  "/timecards": ["hours", "timesheet", "tarjetas de tiempo", "tarjetas", "horas"],
  "/schedule": ["calendar", "dispatch", "appointments", "agenda", "calendario", "citas", "programar"],
  // "All", the Jobs sub-nav's first row (b94497dd): the unfiltered page, which is what a person
  // means by "jobs" or "work". The ?status= rows stay out of the palette (see the collision note).
  "/jobs": ["jobs", "projects", "work", "all jobs", "trabajos", "trabajo", "proyectos", "todos"],
  "/inventory": ["stock", "shop stock", "shelf", "inventory", "warehouse", "parts", "inventario", "bodega", "existencias", "almacén", "refacciones"],
  "/compliance": ["osha", "liability", "regulations", "cumplimiento", "licencias", "permisos", "certificaciones"],
  "/insurance": ["workers comp", "coverage", "liability", "seguros", "seguro", "pólizas", "cobertura"],
  "/safety": ["osha", "incident", "hazard", "seguridad", "incidente", "accidente"],
  "/audits": ["auditorías", "auditoría"],
  "/team": ["oficina", "equipo", "cuadrilla", "personal"],
  "/employee-docs": ["documentos del personal", "documentos", "licencia de conducir"],
  "/forms": ["formularios", "formulario", "formas"],
  "/resources": ["recursos", "inspectores", "permisos"],
  "/handbook": ["manual", "reglas", "políticas"],
  "/activity": ["actividad"],
  "/audit": ["auditoría de actividad", "registro", "historial"],
  "/tools": ["calculator", "calculators", "nec", "wire size", "herramientas", "calculadoras", "calculadora"],
  "/settings": ["ajustes", "configuración"],
  // Plans live with the estimator now (Erik 2026-07-14) — typing plan/blueprint/take-off
  // lands on New Estimate, where the Upload Plans take-off actually is.
  "/quotes/new": ["plan", "plans", "blueprint", "drawing", "take-off", "takeoff", "upload plans", "nuevo presupuesto", "planos", "plano"],
};
// Words that belong to a SWITCH, not to the page they land on (the switch board, 0352): they
// leave the palette with their feature, so "po" can't find Bills while Purchase Orders is off.
// (Words that ride on a page, like "/leads" or "/inventory" above, go with the page's dock row.)
const SWITCH_ALIASES: { href: string; feature: FeatureKey; words: string[] }[] = [
  { href: "/bills", feature: "purchase_orders", words: ["purchase order", "po", "orden de compra", "órdenes de compra", "órdenes"] },
  { href: "/price-list", feature: "kits", words: ["kit", "kits"] },
  { href: "/recurring", feature: "recurring_billing", words: ["subscription", "repeat invoice", "auto invoice", "suscripción", "factura repetida"] },
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
// THE WORDS IN THE PERSON'S LANGUAGE (cn-v1138): a row's label and its section's name come through
// lib/dock-words (the dock's data stays English); the aliases carry both languages beside them, so
// "clock in" still finds Reloj and "reloj" finds Time Clock. `kind` is an id the icon and the chip
// read, never shown raw.
type DockLeaf = { id: string; label: string; href?: string; children?: DockLeaf[]; staffOnly?: boolean };
function navLeaves(nodes: DockLeaf[], sub: string, features: FeatureMap | null | undefined, lang: Lang, sectionStaff?: boolean): Item[] {
  return nodes.flatMap((n) =>
    n.children?.length
      ? navLeaves(n.children, dockLabel(n, lang), features, lang, sectionStaff || n.staffOnly)
      : n.href && !n.href.includes("?")
        ? [{ kind: "Go to", label: dockLabel(n, lang), sub, href: n.href, staffOnly: sectionStaff || n.staffOnly, aliases: aliasesFor(n.href, features) }]
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
const pettyCashRow = (t: (key: string) => string): Item => ({
  kind: "Go to",
  label: t("sh_pettyCash"),
  sub: t("sh_dock_invoices"),
  href: "/petty-cash",
  staffOnly: true,
  aliases: ["petty cash", "cash box", "cash", "atm", "caja chica", "efectivo", "cajero"],
});

/** The palette's "go to" list for this person: exported so the switch rule is pinned in a test.
 *  `lapsed` (the layout's red bar) offers the lapsed dock's open doors and nothing else (the
 *  export door's row carries a ?tab=, so it stays out of the palette like every ?query row).
 *  `lang` (cn-v1138): the words in the person's language; the default is English, as before. */
export function commandNavItems(isStaff: boolean, features?: FeatureMap | null, hasPettyCash = false, lapsed = false, lang: Lang = "en"): Item[] {
  const t = translator(lang);
  if (lapsed) return visibleDock({ isStaff, features, lapsed: true }).flatMap((s) => navLeaves(s.children, dockTileLabel(s, lang), features, lang, s.staffOnly));
  const items: Item[] = [
    ...visibleDock({ isStaff, features }).flatMap((s) => navLeaves(s.children, dockTileLabel(s, lang), features, lang, s.staffOnly)),
    // Today is My Day alone on the dock (W1-03), so its two old pills are found here by name:
    // Reminders for everyone, Organize for the office (every save on it is requireStaff).
    { kind: "Go to", label: t("sh_reminders"), sub: t("sh_dock_today"), href: "/tasks", aliases: NAV_ALIASES["/tasks"] },
    { kind: "Go to", label: t("sh_organize"), sub: t("sh_dock_today"), href: "/organize", staffOnly: true, aliases: NAV_ALIASES["/organize"] },
    // The Time Clock is a Money row of its own since cn-v1128 (dock.ts m-clock), so the dock feeds
    // the palette and its words (NAV_ALIASES["/timeclock"]) ride on that leaf; a tech has his Clock tile.
    // New Estimate isn't a dock leaf, but it's where plan take-offs live now (Upload Plans) —
    // give plan/blueprint/take-off searches somewhere real to land. It goes with Estimates, under
    // the Sales tile's own word (sh_dock_sales, cn-v1139).
    ...(featureOn(features, "estimates")
      ? [{ kind: "Go to", label: t("sh_newEstimate"), sub: t("sh_dock_sales"), href: "/quotes/new", staffOnly: true, aliases: NAV_ALIASES["/quotes/new"] }]
      : []),
    ...(hasPettyCash ? [pettyCashRow(t)] : []),
  ];
  return isStaff ? items : items.filter((i) => !i.staffOnly);
}

/** What a search compares (cn-v1139): lowercase, with the accents folded off both the typed text and
 *  the words it is held against (NFD, then the combining marks dropped), so "nomina" finds Nómina and
 *  "dia" finds Mi Día, and a person who typed the accent is matched just the same. */
export const foldSearch = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

/** The pages that answer what was typed. Match the label, the parent section, OR any synonym — so
 *  "owed"/"AR" finds Invoices and "wages" finds Payroll. Label hits rank above alias-only hits.
 *  Exported so a page's words are pinned in a test (staff typing "clock in" find the Timeclock). */
export function matchNavItems(navItems: Item[], q: string): Item[] {
  const term = foldSearch(q.trim());
  if (!term) return [];
  const scored = navItems
    .map((i) => {
      const label = foldSearch(i.label).includes(term);
      const sub = i.sub ? foldSearch(i.sub).includes(term) : false;
      // An alias matches when it contains the typed text, or when the typed text holds the alias as
      // a whole WORD (its plural too: "bids", "pos"), or holds a multi-word alias ("who owes"):
      // "ar" and "ap" typed alone still open Invoices and Bills, but a customer name holding "ar"
      // or "stock" (Larkspur, Stockton) no longer ranks a page first and takes Enter (cn-v1128,
      // the deep review's search-01 and the skeptic's nit on 4+ letter aliases).
      const words = term.split(/\s+/);
      const alias =
        i.aliases?.some((raw) => {
          const a = foldSearch(raw);
          return a.includes(term) || words.includes(a) || words.includes(a + "s") || (a.includes(" ") && term.includes(a));
        }) ?? false;
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
  lang = "en",
}: {
  isStaff: boolean;
  features?: FeatureMap | null;
  setup?: Answers | null;
  onboarded: boolean;
  lessonsOpen?: boolean;
  toggleLessons?: () => void;
  /** The person's language (cn-v1138): Talk To Nort and the help rows in it (cn-v1139; the lessons' own titles stay English). */
  lang?: Lang;
}): Item[] {
  if (!featureOn(features, "nort")) return [];
  const t = translator(lang);
  const rows: Item[] = [{ kind: "Nort", label: t("sh_talkToNort"), sub: t("sh_sayItOutLoud"), href: "#talk-to-nort", run: talkToNort }];
  for (const r of helpRows({ isStaff, onboarded, setup, nortOn: true, features, t })) {
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

/** The chip's words for a row's kind (the palette's own kinds and /api/search's types), in the
 *  person's language; a kind the catalog does not know is shown as it came. */
const KIND_KEYS: Record<string, string> = {
  "Go to": "sh_kind_goto",
  Nort: "sh_kind_nort",
  Help: "sh_kind_help",
  Assistant: "sh_kind_assistant",
  Create: "sh_kind_create",
  Job: "sh_kind_job",
  Customer: "sh_kind_customer",
  Quote: "sh_kind_quote",
  Invoice: "sh_kind_invoice",
  Appointment: "sh_kind_appointment",
};
export function kindWords(kind: string, t: (key: string) => string): string {
  const key = KIND_KEYS[kind];
  return key ? t(key) : kind;
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
  lapsed = false,
}: {
  isStaff?: boolean;
  features?: FeatureMap;
  /** The company's setup answers (the layout's), for Finish Setting Up · N Left. */
  setup?: Answers;
  /** profiles.onboarded_at: Start Here shows until this person has been walked through. */
  onboarded?: boolean;
  /** The company has petty-cash rows (the layout's staff-only check): offer the Petty Cash row. */
  hasPettyCash?: boolean;
  /** The company has lapsed and this person is on an open door (the layout's red bar): the "go to"
   *  rows are the lapsed dock's three doors alone (lib/dock LAPSED_DOCK). */
  lapsed?: boolean;
}) {
  const router = useRouter();
  // The person's language (cn-v1138): the rows, the placeholder and the chips read in it.
  const lang = useLang();
  const t = translator(lang);
  const navItems = useMemo(() => commandNavItems(!!isStaff, features, hasPettyCash, lapsed, lang), [isStaff, features, hasPettyCash, lapsed, lang]);
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
    () => idleRows({ isStaff: !!isStaff, features, setup, onboarded, lessonsOpen, toggleLessons: () => setLessonsOpen((v) => !v), lang }),
    [isStaff, features, setup, onboarded, lessonsOpen, lang],
  );

  const staticMatches = useMemo(() => {
    if (!q.trim()) return [...idle, ...navItems.slice(0, 7)];
    return matchNavItems(navItems, q);
  }, [q, navItems, idle]);

  const askItem: Item | null = useMemo(
    () => (q.trim() && nortOn ? { kind: "Assistant", label: fillText(t("sh_askNort"), { q: q.trim() }), href: `/assistant?q=${encodeURIComponent(q.trim())}` } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is lang's, and lang is listed
    [q, nortOn, lang],
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
            placeholder={nortOn ? t("sh_searchPlaceholderNort") : t("sh_searchPlaceholder")}
            className="flex-1 bg-transparent py-3.5 text-sm outline-none placeholder:text-slate-400"
          />
          {loading && <span className="shrink-0 text-[11px] text-slate-400">…</span>}
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-1">
          {flat.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              {nortOn ? t("sh_noMatchesNort") : t("sh_noMatches")}
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
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{kindWords(it.kind, t)}</span>
            </button>
          ))}
        </div>

        {/* THE KEYBOARD LINE ONLY WHERE THERE IS A KEYBOARD (W1-12). On a phone it named keys
            nobody has; a width breakpoint can't tell an iPad from a laptop, the pointer can
            (Tailwind's pointer-fine: a mouse or a trackpad). The chip names this computer's key. */}
        <div className="hidden pointer-fine:flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          <span>{t("sh_keysLine")}</span>
          <span className="rounded border border-slate-200 px-1.5 py-0.5">{modKeyLabel(isApplePlatform())}</span>
        </div>
      </div>
    </div>
  );
}
