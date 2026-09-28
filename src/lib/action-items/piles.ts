import { formatCurrency } from "@/lib/utils";
import type { ActionItem, PileInfo, PileName } from "./types";
import { sortActionItems } from "./types";

/**
 * SAME-KIND PILES ROLL UP (Wave 1, W1-14).
 *
 * Seven estimates started and never sent were seven rows and +7 on the badge, and they pushed the
 * one lead that needed a call off the bottom of the card. Now two or more open rows of one pile are
 * ONE row, "Estimates Not Sent · 7", counting 1 on the badge (the badge invariant: a rollup, never
 * the length of an unbounded set). A lone row stays a plain row: never "· 1".
 *
 * A pile row is an ActionItem with the synthetic id `pile:<name>`. It only opens: no verb is ever
 * sent against it (the list unfolds it, and each child keeps its own button and ⋯). It takes the
 * highest urgency and the earliest `when` of its children, so the sort puts it where its most
 * pressing child would have sat.
 *
 * ITS COUNT IS A REAL COUNT (the badge law: a capped read never prints a short count):
 *   · `total`: the read's exact count, for a feeder that filters only in SQL (a lead, a visit, a
 *     paper, a contract, a stock short). It can be more than the rows read; then See All opens the
 *     list page instead of unfolding.
 *   · `capped`: the read hit its cap and the feeder also drops rows in code (an estimate draft, a
 *     finished visit, a walk-through, a receipt): the pile says "N+" (at least the N here) and See
 *     All opens the list page.
 *   · neither: the rows here are all there are.
 * Money subtitles ("$2,340 across 4") are staff only, and never on a capped pile (a short sum).
 *
 * Never piled: supplier_paper and time_stray (already one rolled-up line each) and supplier_pay (each
 * deadline is its own line), and a "Couldn't Check" line (it is about a read, not a thing).
 */

type PileDef = {
  label: string;
  /** With Leads switched off: the same people, called what the company calls them. */
  labelLeadsOff?: string;
  verb: string;
  verbLeadsOff?: string;
  listHref: string | null;
  listLabel: string | null;
};

/** Each pile's words, its verb and its list page. Title Case: they sit on buttons and links. */
export const PILE_DEFS: Record<PileName, PileDef> = {
  estimates_not_sent: { label: "Estimates Not Sent", verb: "Send It", listHref: "/quotes?status=draft", listLabel: "See All On Estimates" },
  no_answer_yet: { label: "No Answer Yet", verb: "Still Waiting", listHref: "/quotes?status=sent", listLabel: "See All On Estimates" },
  won_needs_a_day: { label: "Won, Needs A Day", verb: "Pick A Day", listHref: "/quotes?status=accepted", listLabel: "See All On Estimates" },
  late_invoices: { label: "Late Invoices", verb: "Get Paid", listHref: "/billing", listLabel: "See All On Invoices" },
  invoices_not_sent: { label: "Invoices Not Sent", verb: "Send It", listHref: "/billing", listLabel: "See All On Invoices" },
  // No list page holds these two piles' rows (/billing lists finished jobs with no invoice, never a
  // finished visit or a No Costs Yet; /schedule is a calendar with no list of past visits nobody
  // closed out): See All unfolds every row read here instead of opening a page that doesn't list them.
  done_not_billed: { label: "Done, Not Billed", verb: "Bill It", listHref: null, listLabel: null },
  leads_to_call: {
    label: "Leads To Call",
    labelLeadsOff: "Requests To Call Back",
    verb: "Called",
    verbLeadsOff: "Call Back",
    listHref: "/leads",
    listLabel: "See All On Leads",
  },
  visits_to_close_out: { label: "Visits To Close Out", verb: "Close Out", listHref: null, listLabel: null },
  walkthroughs_to_write_up: { label: "Walk-Throughs To Write Up", verb: "Write It Up", listHref: "/inspections", listLabel: "See All Walk-Throughs" },
  jobs_needing_a_day: { label: "Jobs Needing A Day", verb: "Pick A Day", listHref: "/schedule", listLabel: "See All On Schedule" },
  holds_back: { label: "Holds Back", verb: "Snooze", listHref: "/jobs?status=on_hold", listLabel: "See All On Jobs" },
  papers_to_sort: { label: "Papers To Sort", verb: "Sort It", listHref: "/bills#sort-these", listLabel: "See All On Bills" },
  notes_to_review: { label: "Notes To Review", verb: "File It", listHref: "/organize", listLabel: "See All In Organize" },
  receipts_not_on_a_bill: { label: "Receipts Not On A Bill", verb: "Record It", listHref: "/bills?tab=receipts#all-bills", listLabel: "See All On Bills" },
  stock_to_settle: { label: "Stock To Settle", verb: "Settle It", listHref: "/inventory", listLabel: "See All On Shop Stock" },
  materials_to_buy: { label: "Materials To Buy", verb: "Buy Materials", listHref: "/materials", listLabel: "See All Materials" },
  contracts_not_signed: { label: "Contracts Not Signed", verb: "See Contract", listHref: null, listLabel: null },
  lien_deadlines: { label: "Lien Deadlines", verb: "See Deadline", listHref: null, listLabel: null },
};

/** The notes pile's words when it also holds papers that aren't notes (they file in Organize too). */
export const ORGANIZE_PILE_MIXED = "To File In Organize";

/**
 * A PAPER THAT SORTS IN THE /bills TRAY (its Needs You card, once Sort These), by the filter /bills
 * uses: a receipt, anything dropped on /bills, anything read as a cost paper (a doc_type other than
 * not_a_cost), or a paper nothing has read yet (a file, no reading, no total: Snap Or Note saved it
 * and the reader hasn't answered). The rest (a note, a plan read as not a cost, a picture asking "What is this?") files in
 * Organize. /bills' own last term reads the reader's proposal, which Needs You doesn't read (it rides
 * the app shell's badge): "nothing has read it" is that term without it.
 */
export function isTrayPaper(o: {
  kind?: string | null;
  source?: string | null;
  doc_type?: string | null;
  file_url?: string | null;
  summary?: string | null;
  amount?: number | string | null;
}): boolean {
  if (o.kind === "receipt" || o.source === "bills_drop") return true;
  if (o.doc_type && o.doc_type !== "not_a_cost") return true;
  const unread = !o.doc_type && !String(o.summary ?? "").trim() && (o.amount === null || o.amount === undefined || o.amount === "");
  return o.kind !== "note" && !!o.file_url && unread;
}

/** A "Couldn't Check" line: about a read, never a thing, so it never joins a pile. */
export function isUnreadLine(item: Pick<ActionItem, "id">): boolean {
  return item.id.endsWith("-unread");
}

/** Which pile a row belongs to, or null (never piled). */
export function pileOf(item: Pick<ActionItem, "kind" | "id" | "paper" | "pile">): PileName | null {
  if (item.pile || isUnreadLine(item)) return null;
  switch (item.kind) {
    case "quote_draft":
      return "estimates_not_sent";
    case "quote_awaiting":
      return "no_answer_yet";
    case "quote_accepted":
      return "won_needs_a_day";
    case "invoice_overdue":
      return "late_invoices";
    case "invoice_draft":
      return "invoices_not_sent";
    case "visit_unbilled":
    case "job_unbilled_work":
      return "done_not_billed";
    case "inquiry":
      return "leads_to_call";
    case "appointment":
      return "visits_to_close_out";
    case "inspection_writeup":
      return "walkthroughs_to_write_up";
    case "job_to_schedule":
      return "jobs_needing_a_day";
    case "job_on_hold":
      return "holds_back";
    case "organize":
      // A bank download keeps its own card (bank viewers only): never piled.
      return item.paper === "tray" ? "papers_to_sort" : item.paper === "organize" ? "notes_to_review" : null;
    case "receipt_unbilled":
      return "receipts_not_on_a_bill";
    case "stock_short":
      return "stock_to_settle";
    case "materials_needed":
      return "materials_to_buy";
    case "contract_unsigned":
      return "contracts_not_signed";
    case "lien_deadline":
      return "lien_deadlines";
    default:
      // supplier_paper, time_stray (already rollups), supplier_pay (each deadline its own line).
      return null;
  }
}

/** What a feeder knows about its read: its exact count, or that it hit its cap. */
export type PileCount = { total?: number; capped?: boolean };

/** A read as a feeder has it: its rows, and its exact count when it asked for one. */
export type ReadFacts = { data?: readonly unknown[] | null; count?: number | null };

/** A feeder that filters only in SQL: its exact count, when the rows read aren't all of them. */
export function sqlCount(r: ReadFacts): PileCount {
  const n = (r.data ?? []).length;
  return typeof r.count === "number" && r.count > n ? { total: r.count } : {};
}

/**
 * A feeder that also drops rows in code: "capped" (the pile says "N+", at least the N here) when the
 * read didn't bring every candidate, by its exact count, or (a read with no count) by hitting `cap`.
 * Never the cap itself as a count: that would be a short count dressed as a real one.
 */
export function codeCount(r: ReadFacts, cap?: number): PileCount {
  const n = (r.data ?? []).length;
  if (typeof r.count === "number") return r.count > n ? { capped: true } : {};
  return cap && n >= cap ? { capped: true } : {};
}

/** "Estimates Not Sent · 7", "Receipts Not On A Bill · 200+". */
export function pileTitle(p: Pick<PileInfo, "label" | "count" | "capped">): string {
  return `${p.label} · ${p.count}${p.capped ? "+" : ""}`;
}

/** Can the pile unfold everything it counts, right here? Otherwise See All opens its list page. */
export function pileUnfoldsHere(p: Pick<PileInfo, "count" | "capped">, children: number): boolean {
  return !p.capped && p.count <= children;
}

const whenMs = (w: string | null | undefined, todayStr: string) => {
  const t = w ? Date.parse(w) : NaN;
  return Number.isFinite(t) ? t : Date.parse(`${todayStr}T00:00:00Z`);
};

/**
 * Roll the build's sorted rows into piles. `counts` are the feeders' read facts by pile. The result
 * is sorted again (a pile sits where its most pressing child sat).
 */
export function rollUpPiles(
  items: ActionItem[],
  opts: { todayStr: string; isStaff: boolean; leadsOn?: boolean; counts?: Partial<Record<PileName, PileCount>> },
): ActionItem[] {
  const leadsOn = opts.leadsOn !== false;
  const groups = new Map<PileName, ActionItem[]>();
  for (const it of items) {
    const p = it.done ? null : pileOf(it);
    if (p) groups.set(p, [...(groups.get(p) ?? []), it]);
  }
  const out: ActionItem[] = [];
  const placed = new Set<PileName>();
  for (const it of items) {
    const p = it.done ? null : pileOf(it);
    const children = p ? (groups.get(p) ?? []) : [];
    const fact = p ? (opts.counts?.[p] ?? {}) : {};
    const capped = !!fact.capped;
    const count = Math.max(children.length, fact.total ?? 0);
    // A lone row stays a plain row, unless more of its kind exist than were read.
    if (!p || (children.length < 2 && !capped && count <= children.length)) {
      out.push(it);
      continue;
    }
    if (placed.has(p)) continue; // a later child: already inside its pile
    placed.add(p);
    const def = PILE_DEFS[p];
    const allNotes = p === "notes_to_review" && children.every((c) => c.chip === "Note To Review");
    const label =
      p === "leads_to_call" && !leadsOn
        ? (def.labelLeadsOff ?? def.label)
        : p === "notes_to_review" && !allNotes
          ? ORGANIZE_PILE_MIXED
          : def.label;
    const pile: PileInfo = {
      name: p,
      label,
      count,
      capped,
      listHref: def.listHref,
      listLabel: def.listLabel,
      verb: p === "leads_to_call" && !leadsOn ? (def.verbLeadsOff ?? def.verb) : def.verb,
    };
    // The earliest `when` of its children (an undated one counting as today) and the highest urgency.
    const earliest = [...children].sort((a, b) => whenMs(a.when, opts.todayStr) - whenMs(b.when, opts.todayStr))[0];
    const urgency = Math.max(...children.map((c) => c.urgency)) as 0 | 1 | 2;
    const amounts = children.map((c) => c.amount).filter((a): a is number => typeof a === "number" && Number.isFinite(a));
    const money =
      opts.isStaff && !capped && count === children.length && amounts.length === children.length && amounts.length > 0
        ? `${formatCurrency(amounts.reduce((s, a) => s + a, 0))} across ${children.length}`
        : null;
    out.push({
      id: `pile:${p}`,
      kind: children[0].kind,
      stream: children[0].stream,
      title: pileTitle(pile),
      subtitle: money,
      who: null,
      when: earliest?.when ?? null,
      urgency,
      done: false,
      href: def.listHref ?? children[0].href,
      affordances: ["open"],
      pile,
      children,
    });
  }
  return sortActionItems(out, opts.todayStr);
}

/**
 * A PILE'S PIPS (text to visual): one small mark per child, up to 9 then "+", amber for a child
 * waiting more than a week. Ages from the server's today (the list's todayStr prop), never the
 * browser's clock: the hydration law.
 */
export const PIP_MAX = 9;
export const PIP_OLD_DAYS = 7;

export function pileAges(children: Pick<ActionItem, "since" | "when">[], todayStr: string): { pips: ("old" | "new")[]; more: boolean } {
  const today = Date.parse(`${todayStr}T12:00:00Z`);
  const pips = children.slice(0, PIP_MAX).map((c) => {
    const at = String(c.since ?? c.when ?? "");
    const day = /^\d{4}-\d{2}-\d{2}/.test(at) ? Date.parse(`${at.slice(0, 10)}T12:00:00Z`) : NaN;
    const age = Number.isFinite(day) ? Math.round((today - day) / 86_400_000) : 0;
    return age > PIP_OLD_DAYS ? ("old" as const) : ("new" as const);
  });
  return { pips, more: children.length > PIP_MAX };
}
