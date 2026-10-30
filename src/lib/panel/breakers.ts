/**
 * THE BREAKERS CARD, IN PURE CODE (Panel plan, phase 3). Need (the job's kept, live, NEW circuits)
 * against Have (what came on the job's tickets), in the words the card shows. No database, no
 * React: the card, the replay against J-011's live bills and the tests all call this one function,
 * so the office and the crew read the SAME count and the same verdict.
 *
 * WHAT COUNTS AS HAVE: only what came on a ticket for this job (breakers_bought_for_job, 0334). The
 * materials list and the shop shelf are SHOWN beside it and never added in: J-011's list still
 * carries "20a twin breaker" x8 unticked, and those are the same eight Q2020s the ticket brought.
 * Counting both would say sixteen. So the list says "On The List, Not Bought Yet" and, when a ticket
 * already brought as many, says that too; a person ticks the list.
 *
 * AN UNREADABLE LINE counts as zero and is named ("Can't Read This Breaker"), in both views.
 */
import type { CircuitKind, JobCircuit, JobPanel, SpaceHalf } from "@/lib/types";
import {
  breakerCheck,
  breakerNeed,
  countWord,
  needSentence,
  quadCentreHalf,
  quadOuterSlots,
  quadSpaceFree,
  sizeWords,
  spaceMap,
  type BreakerCheck,
  type HaveItem,
  type Need,
  type Shortfall,
} from "./model";
import { brandOf, decodeBreaker, partFor, type BrandKey, type BreakerForm, type BreakerSlot } from "./breaker-catalog";

/** One line to read: a bill line (description, qty), a materials line (part number too), a shelf item.
 *  `credit`: a ticket's credit line nobody can read (a positive count on negative money: a return
 *  or a price fix?). It is never counted either way; it is named, and a person decides. */
export type BreakerLine = { description: string; part_number?: string | null; qty: number; credit?: boolean };

/** What breakers_bought_for_job (0334) hands back, as lines: what came, and beside it the credits
 *  nobody can read (credit_qty). One mapper, so the card, Nort and the replay read it the same way. */
export function boughtLines(rows: { description: string; qty: number | string | null; credit_qty?: number | string | null }[] | null | undefined): BreakerLine[] {
  const out: BreakerLine[] = [];
  for (const r of rows ?? []) {
    const qty = Number(r.qty ?? 0);
    const credit = Number(r.credit_qty ?? 0);
    if (Number.isFinite(qty) && qty !== 0) out.push({ description: r.description, qty });
    if (Number.isFinite(credit) && credit > 0) out.push({ description: r.description, qty: credit, credit: true });
  }
  return out;
}

export type HaveGroup = {
  /** Same form and pole groups = the same breaker, whichever way the line was written. */
  key: string;
  /** The part numbers the lines named ("Q2020"), if any. */
  codes: string[];
  brand: BrandKey | null;
  words: string;
  form: BreakerForm;
  slots: BreakerSlot[];
  qty: number;
  /** The lines as written, for the person to check against. */
  lines: string[];
};
export type Unreadable = { description: string; qty: number; reason: string; credit?: boolean };

/** Said beside a ticket's credit line: it isn't counted either way until a person looks. */
export const CREDIT_REASON = "A Ticket Credits It, But Doesn't Say If The Part Went Back Or Was Only Repriced. Check The Ticket.";

const sig = (form: BreakerForm, slots: BreakerSlot[]) =>
  `${form}:${[...slots].map((s) => `${s.poles}P${s.amps}${s.kind ?? ""}`).sort().join("+")}`;

/** Read and add up lines. A return (a negative quantity) takes off what it returns; a group that
 *  nets to nothing is dropped. */
export function groupBreakers(lines: BreakerLine[]): { groups: HaveGroup[]; unreadable: Unreadable[] } {
  const groups = new Map<string, HaveGroup>();
  const unread = new Map<string, Unreadable>();
  for (const l of lines) {
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const r = decodeBreaker(l.part_number, l.description);
    if (r.kind === "not_breaker") continue;
    const text = String(l.description ?? "").trim() || String(l.part_number ?? "").trim();
    if (l.credit) {
      // Neither came nor went back: named, never counted (0334's credit_qty).
      const k = `credit:${text}`;
      const u = unread.get(k) ?? { description: text, qty: 0, reason: CREDIT_REASON, credit: true };
      u.qty += Math.abs(qty);
      unread.set(k, u);
      continue;
    }
    if (r.kind === "unknown") {
      const u = unread.get(text) ?? { description: text, qty: 0, reason: r.reason };
      u.qty += qty;
      unread.set(text, u);
      continue;
    }
    const key = sig(r.form, r.slots);
    const g = groups.get(key) ?? { key, codes: [], brand: r.brand, words: r.words, form: r.form, slots: r.slots, qty: 0, lines: [] };
    g.qty += qty;
    if (r.code && !g.codes.includes(r.code)) g.codes.push(r.code);
    if (!g.brand && r.brand) g.brand = r.brand;
    if (!g.lines.includes(text)) g.lines.push(text);
    groups.set(key, g);
  }
  const order = (g: HaveGroup) => (g.form === "single" ? 0 : g.form === "double" ? 1 : g.form === "twin" ? 2 : 3);
  return {
    groups: [...groups.values()]
      .filter((g) => g.qty > 0)
      .sort((a, b) => order(a) - order(b) || a.slots[0].amps - b.slots[0].amps || a.key.localeCompare(b.key)),
    unreadable: [...unread.values()].filter((u) => u.qty > 0),
  };
}

/** A group's name on the card: its part number and what is inside ("Q2020 · Twin 1P 20A + 1P 20A"). */
export function groupLabel(g: Pick<HaveGroup, "codes" | "words">): string {
  return g.codes.length ? `${g.codes.join(" / ")} · ${g.words}` : g.words;
}

const qtyWords = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));

export function toHave(groups: HaveGroup[]): HaveItem[] {
  return groups.map((g) => ({ label: g.codes[0] ?? g.words, qty: Math.floor(g.qty), form: g.form, slots: g.slots }));
}

/** One way to close a shortfall: order the plain part in the panel's family, or say it in words. */
export type Order = {
  short: Shortfall;
  /** "Q220", or null when the family or the type doesn't give one plain part. */
  part: string | null;
  /** What Add To Materials writes as the line's words: "Q220 2P 20A Breaker". */
  description: string;
  qty: number;
  /** The shelf or the unticked list already has one: said beside the order, never instead of it. */
  alsoOn: string[];
};

export type ListLine = BreakerLine & { purchased: boolean };
export type ShelfLine = { name: string; on_hand: number };

export type BreakerCard = {
  need: Need;
  /** "Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A." */
  needWords: string;
  /** "The range and the two reused circuits are already in." in counts: */
  alreadyInWords: string | null;
  bought: HaveGroup[];
  /** Lines on this job's tickets that are breakers this app can't read: counted as zero. */
  unreadable: Unreadable[];
  /** The same, on the materials list (never counted anyway; said so a person can fix the words). */
  listUnreadable: Unreadable[];
  check: BreakerCheck;
  orders: Order[];
  /** Unticked list lines that read as breakers, with how many a ticket already brought. */
  onList: (HaveGroup & { onTicket: number })[];
  shelf: HaveGroup[];
  /** The family the parts to order are in: the panel's brand, else what the tickets brought. */
  brand: BrandKey | null;
  /** "unknown" when the panel's tandem spaces aren't set: then a quad swap is "if a space takes one". */
  quadSpace: boolean | "unknown";
};

function familyOf(panel: Pick<JobPanel, "brand"> | null, bought: HaveGroup[]): BrandKey | null {
  const said = brandOf(panel?.brand);
  if (said) return said;
  const seen = new Map<BrandKey, number>();
  for (const g of bought) if (g.brand) seen.set(g.brand, (seen.get(g.brand) ?? 0) + g.qty);
  const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

const covers = (g: HaveGroup, s: Shortfall) =>
  g.slots.some((x) => x.poles === s.poles && x.amps === s.amps && (x.kind ?? null) === (s.kind ?? null));

/**
 * Everything the Breakers card shows, from the job's circuits, its panel, and three lists of lines:
 * the tickets (bought), the materials list, and the shelf.
 */
export function breakerCard(input: {
  circuits: JobCircuit[];
  panel: JobPanel | null;
  bought: BreakerLine[];
  list?: ListLine[];
  shelf?: ShelfLine[];
}): BreakerCard {
  const need = breakerNeed(input.circuits);
  const bought = groupBreakers(input.bought);
  const listed = groupBreakers((input.list ?? []).filter((l) => !l.purchased));
  const shelf = groupBreakers((input.shelf ?? []).filter((s) => Number(s.on_hand) > 0).map((s) => ({ description: s.name, qty: Number(s.on_hand) })));

  let quadSpace: boolean | "unknown" = "unknown";
  const p = input.panel;
  if (p && (p.twin_spaces ?? []).length > 0) quadSpace = quadSpaceFree(p, spaceMap(p, input.circuits));
  const check = breakerCheck(need, toHave(bought.groups), { quadSpaceFree: quadSpace });

  const { existing, reused } = need.alreadyIn;
  const bits = [existing ? `${countWord(existing)} Existing` : null, reused ? `${countWord(reused)} Reused` : null].filter(Boolean);
  const alreadyInWords = bits.length ? `${bits.join(" And ")} ${existing + reused === 1 ? "Circuit Is" : "Circuits Are"} Already In.` : null;

  const brand = familyOf(p, bought.groups);
  const orders: Order[] = check.short.map((s) => {
    const part = partFor({ poles: s.poles, amps: s.amps, kind: s.kind }, brand);
    const alsoOn = [
      ...listed.groups.filter((g) => covers(g, s)).map((g) => `On The List, Not Bought Yet: ${qtyWords(g.qty)} x ${groupLabel(g)}`),
      ...shelf.groups.filter((g) => covers(g, s)).map((g) => `In Stock: ${qtyWords(g.qty)} x ${groupLabel(g)}`),
    ];
    return { short: s, part, description: `${part ? `${part} ` : ""}${sizeWords(s.poles, s.amps, s.kind)} Breaker`, qty: s.count, alsoOn };
  });

  const onList = listed.groups.map((g) => ({ ...g, onTicket: bought.groups.find((b) => b.key === g.key)?.qty ?? 0 }));
  return {
    need,
    needWords: needSentence(need),
    alreadyInWords,
    bought: bought.groups,
    unreadable: bought.unreadable,
    listUnreadable: listed.unreadable,
    check,
    orders,
    onList,
    shelf: shelf.groups,
    brand,
    quadSpace,
  };
}

/** The key a line's breaker groups under (the office matches its ticket sources to the card's groups
 *  with it), or null when the line isn't a readable breaker. */
export function lineKey(...texts: (string | null | undefined)[]): string | null {
  const r = decodeBreaker(...texts);
  return r.kind === "breaker" ? sig(r.form, r.slots) : null;
}

// ── THE ONE LINE (the panel-first wave) ─────────────────────────────────────────────────────────

/** How many breakers that came on this job's tickets aren't in a space yet, and the first group one
 *  of them is in (the one Place Them opens). */
export type Unplaced = { count: number; first: HaveGroup | null };

type Counted = Pick<JobCircuit, "state" | "removed_at" | "work" | "space" | "poles" | "amps" | "kind">;

const sizeKey = (poles: number, amps: number | null, kind: CircuitKind | null | undefined) =>
  `${poles}|${amps ?? ""}|${kind && kind !== "standard" ? kind : ""}`;

/**
 * THE BOUGHT BREAKERS NOT IN A SPACE YET. A breaker that came is in when the kept NEW circuits it
 * makes have spaces. Each one that came (in the card's order) first takes placed new circuits of its
 * sizes; one that can't, but whose sizes match a kept new circuit with no space yet, is waiting to
 * go in. One that matches neither is a spare, which the count already says; it is never counted
 * here, so the line can't ask for a breaker to be placed that has no circuit to be.
 */
export function unplacedBought(bought: HaveGroup[], circuits: Counted[]): Unplaced {
  const pool = (placed: boolean) => {
    const m = new Map<string, number>();
    for (const c of circuits) {
      if (c.state !== "kept" || c.removed_at || c.work !== "new" || c.amps == null) continue;
      if ((c.space != null) !== placed) continue;
      const k = sizeKey(c.poles, c.amps, c.kind);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const placed = pool(true);
  const waiting = pool(false);
  const take = (m: Map<string, number>, k: string) => {
    const n = m.get(k) ?? 0;
    if (n < 1) return false;
    m.set(k, n - 1);
    return true;
  };
  let count = 0;
  let first: HaveGroup | null = null;
  for (const g of bought) {
    for (let i = 0; i < Math.floor(g.qty); i++) {
      const left = g.slots.filter((s) => !take(placed, sizeKey(s.poles, s.amps, s.kind)));
      if (!left.length) continue;
      if (left.filter((s) => take(waiting, sizeKey(s.poles, s.amps, s.kind))).length) {
        count++;
        first ??= g;
      }
    }
  }
  return { count, first };
}

/** "a, b and c". */
const andWords = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What the Breakers card says, in at most two lines with one door each, the same for the crew and
 *  the office. Everything else (the tickets, the book, the swaps, the list and the shelf) is the
 *  office's, behind Details. */
export type BreakerSay = {
  /** No kept new circuit yet: what to do first. Nothing else is said then. */
  nothing: string | null;
  /** "Short one 2P 20A (Bath Floor Heat)", and what Add To Materials writes for it: the orders the
   *  materials list doesn't already carry. No orders = every one of them is on the list already. */
  short: { text: string; orders: Order[] } | null;
  /** "2 bought breakers not placed yet", and the group Place Them opens first. */
  unplaced: { text: string; count: number; group: HaveGroup } | null;
  /** "All breakers accounted for." when nothing is short, nothing waits, every new circuit is sized,
   *  AND every ticket line could be read. */
  ok: string | null;
  /** Everything it could read is accounted for, but a ticket line couldn't be read (or is a credit
   *  nobody can read), so it can't say "all": "Counted what I could read — one ticket line is
   *  unreadable." Never beside `ok`. */
  partial: string | null;
  /** Said beside the line, never silent: a new circuit with no amps, a ticket line nobody can read. */
  notes: string[];
};

export function breakerSay(card: BreakerCard, circuits: (Counted & Pick<JobCircuit, "source_row">)[]): BreakerSay {
  const notes: string[] = [];
  const { unsized } = card.need;
  if (unsized.length) {
    const one = unsized.length === 1;
    notes.push(
      `${unsized.length} new ${one ? "circuit has" : "circuits have"} no amps yet (${unsized.map((u) => u.name).join(", ")}), so ${one ? "it isn't" : "they aren't"} counted.`,
    );
  }
  for (const u of card.unreadable) {
    notes.push(
      u.credit
        ? `A credit on a ticket for ${u.description} (${qtyWords(u.qty)}) isn't counted either way.`
        : `Can't read ${u.description} (${qtyWords(u.qty)}) on a ticket, so it isn't counted.`,
    );
  }

  if (card.need.lines.length === 0 && unsized.length === 0) {
    const waiting = circuits.filter((x) => x.state === "suggested" && !x.removed_at && !x.source_row?.flag_for && x.work === "new").length;
    const keptOld = circuits.some((x) => x.state === "kept" && !x.removed_at);
    const nothing =
      waiting > 0
        ? `Nothing counted yet. Keep the new circuits to count what they need: ${waiting} ${waiting === 1 ? "suggestion is" : "suggestions are"} waiting above.`
        : keptOld
          ? "No new circuits on the list yet. Add the new work to count its breakers."
          : "Nothing counted yet. Add the new circuits to count what they need.";
    return { nothing, short: null, unplaced: null, ok: null, partial: null, notes };
  }

  const onList = (o: Order) => o.alsoOn.some((w) => w.startsWith("On The List"));
  let short: BreakerSay["short"] = null;
  if (card.check.short.length) {
    const items = card.check.short.map((s) => {
      const names = s.circuits.map((x) => x.name).filter(Boolean);
      return `${countWord(s.count).toLowerCase()} ${sizeWords(s.poles, s.amps, s.kind)}${names.length ? ` (${names.join(", ")})` : ""}`;
    });
    const listed = card.orders.filter(onList);
    const orders = card.orders.filter((o) => !onList(o));
    if (listed.length && orders.length) {
      notes.push(`${andWords(listed.map((o) => sizeWords(o.short.poles, o.short.amps, o.short.kind)))} ${listed.length === 1 ? "is" : "are"} on the materials list already, not bought yet.`);
    }
    short = { text: `Short ${andWords(items)}`, orders };
  }

  const u = unplacedBought(card.bought, circuits);
  const unplaced = u.count > 0 && u.first ? { text: `${u.count} bought ${u.count === 1 ? "breaker" : "breakers"} not placed yet`, count: u.count, group: u.first } : null;
  // "All" only when every line was read: an unreadable ticket line (or a credit nobody can read) may
  // be a breaker this job needs or has, so the most the line can say is what it could count.
  const clear = !short && !unplaced && unsized.length === 0;
  const unread = card.unreadable.length;
  const ok = clear && unread === 0 ? "All breakers accounted for." : null;
  const partial =
    clear && unread > 0
      ? `Counted what I could read — ${countWord(unread).toLowerCase()} ticket ${unread === 1 ? "line is" : "lines are"} unreadable.`
      : null;
  return { nothing: null, short, unplaced, ok, partial, notes };
}

// ── PLACE FROM WHAT WAS BOUGHT ──────────────────────────────────────────────────────────────────

/** One circuit a bought breaker makes when it goes in at a space. */
export type PlacedPart = { space: number; half: SpaceHalf | null; poles: number; amps: number; kind: CircuitKind | null; label: string };

/**
 * Where each pole group of a breaker sits when it goes in at `space` (its lower-numbered space): a
 * single or a 2P at the space itself; a twin's halves at A and B; a quad the way its four handles
 * hang on THIS panel (model quadCentreHalf / quadOuterSlots, the one rule): space 1 at the top, the
 * outside 1P at the top of the space (A) and at the bottom of the next one on that side (B), the
 * inside 2P kept at the space's B half, which covers that half and the next space's A — the middle
 * two handles (J-011's Q21530CT at 25: 25A, 27B, and 25B/27A); space 1 at the bottom, where the
 * next space hangs above, the outside 1P at 27A (top) and 25B (bottom) and the inside 2P at 25A
 * (25A/27B). A quad of two 2P: the first at the outer half, the second at the centre's.
 */
export function placementOf(g: Pick<HaveGroup, "form" | "slots">, space: number, numbering: JobPanel["numbering"] | null = "top_down"): PlacedPart[] {
  const s = g.slots;
  const part = (sp: number, half: SpaceHalf | null, x: BreakerSlot, label: string): PlacedPart => ({
    space: sp,
    half,
    poles: x.poles,
    amps: x.amps,
    kind: x.kind,
    label,
  });
  if (g.form === "twin" && s.length === 2) return [part(space, "A", s[0], "Top Half"), part(space, "B", s[1], "Bottom Half")];
  const centre = quadCentreHalf(numbering);
  if (g.form === "quad" && s.length === 3) {
    const outer = s.filter((x) => x.poles === 1);
    const inner = s.find((x) => x.poles === 2)!;
    const [top, bottom] = quadOuterSlots(space, numbering);
    return [part(top.space, top.half, outer[0], "Outside, Top"), part(bottom.space, bottom.half, outer[1], "Outside, Bottom"), part(space, centre, inner, "Inside 2-Pole")];
  }
  if (g.form === "quad" && s.length === 2) return [part(space, centre === "A" ? "B" : "A", s[0], "First 2-Pole"), part(space, centre, s[1], "Second 2-Pole")];
  return [part(space, null, s[0], s[0].poles > 1 ? `The ${s[0].poles}-Pole` : "The Breaker")];
}

/** The kept circuits with no space yet that one placed part could be, best first (new work, then
 *  list order). A person picks; "A New Circuit" is always there too. */
export function candidatesFor(p: Pick<PlacedPart, "poles" | "amps" | "kind">, circuits: JobCircuit[], panelId: string): JobCircuit[] {
  return circuits
    .filter(
      (c) =>
        c.state === "kept" &&
        !c.removed_at &&
        c.space == null &&
        (c.panel_id == null || c.panel_id === panelId) &&
        c.poles === p.poles &&
        c.amps === p.amps &&
        (c.kind === "standard" ? null : c.kind ?? null) === (p.kind ?? null),
    )
    .sort((a, b) => Number(b.work === "new") - Number(a.work === "new") || a.sort_order - b.sort_order);
}

/** The first pick for each part: a different unplaced circuit each, in list order, or a new one. */
export function firstPicks(parts: PlacedPart[], circuits: JobCircuit[], panelId: string): (string | null)[] {
  const taken = new Set<string>();
  return parts.map((p) => {
    const c = candidatesFor(p, circuits, panelId).find((x) => !taken.has(x.id));
    if (!c) return null;
    taken.add(c.id);
    return c.id;
  });
}
