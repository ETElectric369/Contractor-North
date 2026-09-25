/**
 * THE JOB'S STRETCHES, AS BILLED: each day's people, hours and dollars, the materials, the payments,
 * and the running balance after each stretch. Pure: fed rows, returns figures, no I/O.
 *
 * Erik, 2026-09-24, on J-011 (INV-078, one long-running draft paid in cash and Venmo as the work went):
 * the customer should see the stretches of work against the payments, "everything the invoice
 * shows", live. The critique of the first plan found three ways the obvious version is wrong, and
 * each has a rule here:
 *
 *  1. THE BALANCE IS A RUNNING ONE, NOT A LEDGER. paymentLedger (invoice-math) floors each row at
 *     zero against the whole invoice. A stretch's balance is cumulative work minus cumulative paid
 *     through that stretch, with NO floor: a customer who paid ahead is shown ahead.
 *  2. THE DAYS ADD UP TO THE BILLED LINE, TO THE CENT. A labor line bills a QUANTITY (quarter-hour
 *     rounded, or hand-set) at a rate; its entries' clock hours do not sum to it (J-011's Aug 5 entry
 *     is 3.509 h inside a 50.50 h line). Pricing each entry at its own clock time gives $8,319.52 for
 *     an $8,318.62 invoice. So the line's quantity is spread over its entries in hundredths of an
 *     hour, each entry keeping its own clock time to the hundredth and the line's rounding going to
 *     the entries whose clock time was cut the most (largest remainder), and then the line's DOLLARS
 *     are spread over those hours the same way. Every day then prices at the line's own rate and the
 *     days sum to the line. A line whose hours are not its entries' hours give or take the quarter
 *     hour (a hand-set line, INV-048's 26 h) is not pretended into days: it is one row, "billed as a
 *     lump", on the day of its last entry.
 *  3. A DAY IS THE ORG'S DAY. Erik's Sep 18 shift started at 5 PM Pacific, which is Sep 19 in UTC.
 *     Every instant is turned into a date in the org timezone; `date` columns (a bill's date) are
 *     already dates and are never shifted.
 *
 * WHERE A ROW LANDS. A dated row goes to the stretch whose dates hold it. A payment after a stretch
 * ended and before the next began was paid "at the end of it" and joins the stretch before; work in
 * such a gap does the same and is flagged out of range, so nothing is dropped and nothing is hidden.
 * Anything before the first stretch joins the first (a deposit). A line with no date of its own (a
 * typed charge, a draw credit, the tax) is dated by its bill: the day it was sent, or made if it
 * has not been. With no stretches at all the job is one stretch, "All Work".
 *
 * NEVER A SUPPLIER'S NAME. The materials import writes one remainder row per receipt, worded
 * "Supplies & tax - <supplier>". The customer's copy of the bill prints them as one "Supplies & Tax"
 * line with no vendor (mergeSuppliesAndTax, INV-074); here each keeps its own day and its own cents
 * (so the stretches still reconcile) under the same vendor-free words. A draft's lines were never
 * on /i, so this is the first place a customer would have read them. Every other line reads through
 * customerLineWords too (audit v994 PL1): a receipt billed as one amount, an order, a return
 * ("Materials - CED (bill #...)", "Returned: other items - CED") is "Materials" /
 * "Returned: Materials" / "Returned: Other Items" here, as on the bill. shapePortalJob has
 * already applied it with the org's supplier names; this pass is for any caller that has not.
 *
 * LABOR AND MATERIALS, APART (Erik, 2026-09-24: "no simple breakdown separating time and material
 * right at the top, its all mixed in"). Every row carries its group (line-kind: the stored
 * import_source, or its bill being a deposit, and for a typed line the same words-and-unit rule the
 * /i Cost Breakdown reads), and every day, stretch and the job carry a `split`: Labor with its
 * hours, Materials, then any other group that has a line (Change Orders, Credits, Sales Tax,
 * Other...). The split's amounts add up to that level's work total to the cent, because they are
 * summed from the same cents.
 *
 * A DEPOSIT AND ITS CREDIT LAND TOGETHER (audit v994 MR5). A deposit bill is billed before the work
 * and comes back off a later bill as a "Less previous billings" credit. Dated by their own bills,
 * the charge sat in the first stretch and the credit in a later one, so every stretch between
 * them read the deposit as work owed (J-002: $10,000 too high after the first stretch, $10,000
 * short after the next). So each piece of a draw credit is dated the day of the lump bill it takes
 * off (placeDrawCredits: a deposit, or a fixed or percent payment request, oldest first): the
 * charge and the credit cancel in the same stretch, and the payment reads as what it is, money
 * paid ahead. Its row says "taken off the deposit" or "taken off an earlier bill".
 *
 * Every figure is carried in integer cents (and hours in integer hundredths) and only turned into
 * dollars on the way out, so "reconciles" is an equality, not a tolerance.
 */
import { todayStrInTz } from "@/lib/tz";
import { SUPPLIES_AND_TAX_LABEL, customerLineWords, isSuppliesAndTaxLine, lumpDrawAmount } from "@/lib/invoice-math";
import { LINE_GROUP_LABEL, LINE_GROUP_ORDER, isHoursUnit, lineGroup, type LineGroup } from "./line-kind";

export type LedgerStretchIn = { id: string; label: string; starts_on: string; ends_on: string; sort?: number | null };
export type LedgerInvoiceIn = {
  id: string;
  invoice_number: string | null;
  status: string;
  subtotal?: number | string | null;
  tax: number | string | null;
  total: number | string | null;
  amount_paid: number | string | null;
  created_at: string;
  sent_at?: string | null;
  /** deposit | progress | final | standard. A deposit bill's lines are the Deposit group, and a
   *  draw credit is dated by the earliest deposit bill (MR5). */
  invoice_kind?: string | null;
};
export type LedgerEntryIn = { person: string | null; clock_in: string; clock_out: string | null; lunch_minutes: number | null };
export type LedgerSourceIn = { date: string | null; at: string | null };
export type LedgerLineIn = {
  invoice_id: string;
  sort_order: number;
  description: string;
  quantity: number | string | null;
  unit: string | null;
  unit_price: number | string | null;
  line_total: number | string | null;
  import_source: string | null;
  entries?: LedgerEntryIn[] | null;
  sources?: LedgerSourceIn[] | null;
};
export type LedgerPaymentIn = { invoice_id: string; amount: number | string | null; paid_at: string; method: string | null };

export type LaborRow = {
  person: string;
  hours: number;
  rate: number;
  amount: number;
  invoiceNumber: string | null;
  /** The line's hours are not its entries' hours: shown whole, never spread into days. */
  lump: boolean;
};
export type ItemKind = "material" | "charge" | "credit" | "tax" | "adjustment";
export type ItemRow = {
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  amount: number;
  kind: ItemKind;
  /** Labor, Materials, or another group (line-kind): where the row is listed and summed. */
  group: LineGroup;
  invoiceNumber: string | null;
  /** "purchase": the day it was bought. "bill": it has no day of its own, so it carries its bill's.
   *  "deposit": a credit taken off the deposit, dated with the deposit bill it takes off (MR5).
   *  "draw": a credit taken off an earlier fixed or percent payment request, dated with that bill. */
  datedBy: "purchase" | "bill" | "deposit" | "draw";
};
/** One group's figure at one level (a day, a stretch, the job). */
export type SplitLine = { group: LineGroup; label: string; amount: number };
/**
 * Labor and Materials apart, then every other group that has a line, in LINE_GROUP_ORDER. At a
 * stretch and the job, Labor and Materials are listed even at $0.00, so the two lines Erik asked
 * for are there, but ONLY when every dollar at that level is known to be what it says: when some
 * of it is Other, From The Estimate, Contract Payments or Change Orders (money that may hold labor
 * or materials the rule cannot see; a discount does not), a $0.00 would tell the customer there was no labor or no
 * materials when there was (J-053's $450 service call read "Labor $0.00 · Materials $0.00"), so
 * only the groups that have a line are listed, as a day always does. The amounts add up to that
 * level's work total exactly. laborHours: the hours the labor bills (a typed line billed in hours
 * counts its quantity); 0, so no hours are printed, when some of the labor was billed in anything
 * but hours ("Labor - Erik", 3 ea), because the hours would then undercount the dollars beside them.
 */
export type LedgerSplit = { laborHours: number; lines: SplitLine[] };
/** Where a dated row sits against its stretch's own dates: inside them (null), before the first
 *  stretch began (a deposit, early work), or after the stretch ended and before the next began. */
export type Outside = "before" | "after" | null;
export type LedgerDay = { date: string; inRange: boolean; outside: Outside; hours: number; total: number; labor: LaborRow[]; items: ItemRow[]; split: LedgerSplit };
export type LedgerPaymentRow = {
  date: string;
  inRange: boolean;
  outside: Outside;
  amount: number;
  method: string | null;
  /** "credit": the bill's paid figure holds money no payment row explains (a customer credit applied). */
  kind: "payment" | "credit";
  invoiceNumber: string | null;
};
export type LedgerStretch = {
  id: string | null;
  label: string;
  startsOn: string | null;
  endsOn: string | null;
  days: LedgerDay[];
  payments: LedgerPaymentRow[];
  hours: number;
  workTotal: number;
  /** workTotal split into Labor, Materials and any other group, to the cent. */
  split: LedgerSplit;
  paidTotal: number;
  /** Cumulative work − cumulative paid through the end of this stretch. No floor. */
  balanceAfter: number;
};
export type JobLedger = {
  stretches: LedgerStretch[];
  workTotal: number;
  /** workTotal split into Labor, Materials and any other group, to the cent: the money card's lines. */
  split: LedgerSplit;
  paidTotal: number;
  balance: number;
  /** Σ of the bills' own totals, and Σ(total − amount_paid): what `workTotal` and `balance` must equal. */
  billedTotal: number;
  billedBalance: number;
  reconciles: boolean;
};

export type LedgerInput = {
  stretches: LedgerStretchIn[];
  invoices: LedgerInvoiceIn[];
  lines: LedgerLineIn[];
  payments: LedgerPaymentIn[];
  /** IANA timezone of the org, already validated. */
  tz: string;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Dollars (number or numeric string) → integer cents. Non-numbers are 0. */
export function toCents(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const dollars = (c: number) => c / 100;

/** An instant → its date in the org timezone. A bare date is already a date. */
export function orgDay(v: string | null | undefined, tz: string): string | null {
  if (!v) return null;
  const s = String(v);
  if (YMD.test(s)) return s;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? todayStrInTz(tz, d) : null;
}

/** Worked milliseconds of an entry (clock out − clock in − lunch), never below zero; 0 while running. */
function workedMs(e: LedgerEntryIn): number {
  if (!e.clock_out) return 0;
  const ms = Date.parse(e.clock_out) - Date.parse(e.clock_in) - Math.max(0, Number(e.lunch_minutes) || 0) * 60_000;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Hundredths of an hour are 36,000 ms. */
const MS_PER_UNIT = 36_000;
/** The importer rounds a person's hours to the quarter (12.5 hundredths either way). Beyond that,
 *  the line's hours were set by hand and are not its entries' hours. */
const ROUNDING_SLACK_UNITS = 13;

/**
 * Spread `target` hundredths over entries worked `ms` each: every entry keeps its own clock time to
 * the hundredth (floored), and the difference goes, a hundredth at a time, to the entries whose
 * clock time the floor cut the most (taken back from those it cut the least when the line is
 * shorter). Round-robin if the difference is more than one hundredth per entry. Deterministic:
 * ties go to the earlier entry.
 */
export function spreadHours(ms: number[], target: number): number[] {
  const base = ms.map((m) => Math.floor(m / MS_PER_UNIT));
  const rem = ms.map((m) => m - Math.floor(m / MS_PER_UNIT) * MS_PER_UNIT);
  let d = target - base.reduce((s, x) => s + x, 0);
  if (d === 0 || base.length === 0) return base;
  const out = [...base];
  if (d > 0) {
    const order = rem.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.i);
    for (let k = 0; d > 0; k = (k + 1) % order.length, d--) out[order[k]] += 1;
  } else {
    const order = rem.map((r, i) => ({ r, i })).sort((a, b) => a.r - b.r || b.i - a.i).map((x) => x.i);
    let need = Math.min(-d, out.reduce((s, x) => s + x, 0));
    while (need > 0) {
      for (const i of order) {
        if (need === 0) break;
        if (out[i] > 0) {
          out[i] -= 1;
          need -= 1;
        }
      }
    }
  }
  return out;
}

/** Largest-remainder split of `total` (integer) in proportion to integer `weights`. Sums exactly to
 *  `total`; a zero weight gets zero unless every weight is zero (then the first gets it all). */
export function splitByWeight(total: number, weights: number[]): number[] {
  const W = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (weights.length === 0) return [];
  if (W <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const sign = total < 0 ? -1 : 1;
  const T = Math.abs(total);
  const floor = weights.map((w) => Math.floor((T * Math.max(0, w)) / W));
  const rem = weights.map((w, i) => T * Math.max(0, w) - floor[i] * W);
  let left = T - floor.reduce((s, x) => s + x, 0);
  const order = rem.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) floor[order[k]] += 1;
  return floor.map((x) => sign * x);
}

type Placed = { date: string; labor?: { person: string; units: number; rateCents: number; cents: number; invoiceNumber: string | null; lump: boolean }; item?: Omit<ItemRow, "quantity" | "unitPrice" | "amount"> & { quantity: number; unitPriceCents: number; cents: number } };

/** Running cents per group, labor hundredths, and how many labor lines were billed in something but hours. */
type SplitAcc = { cents: Map<LineGroup, number>; units: number; unhoured: number };
const newSplit = (): SplitAcc => ({ cents: new Map(), units: 0, unhoured: 0 });
function addPlaced(acc: SplitAcc, p: Placed): void {
  if (p.labor) {
    acc.cents.set("labor", (acc.cents.get("labor") ?? 0) + p.labor.cents);
    acc.units += p.labor.units;
  } else if (p.item) {
    const g = p.item.group;
    acc.cents.set(g, (acc.cents.get(g) ?? 0) + p.item.cents);
    // A typed labor line bills its quantity in hours only when its unit says hours.
    if (g === "labor") {
      if (isHoursUnit(p.item.unit)) acc.units += Math.round(p.item.quantity * 100);
      else acc.unhoured += 1;
    }
  }
}
function mergeSplit(into: SplitAcc, from: SplitAcc): void {
  for (const [g, c] of from.cents) into.cents.set(g, (into.cents.get(g) ?? 0) + c);
  into.units += from.units;
  into.unhoured += from.unhoured;
}
/** Groups whose lines may hold labor or materials the rule cannot see. */
const UNSPLIT: ReadonlySet<LineGroup> = new Set(["change_orders", "estimate", "contract", "other"]);
function outSplit(acc: SplitAcc, always: boolean): LedgerSplit {
  const lines: SplitLine[] = [];
  // A discount (a negative Other) hides no labor or materials; money the rule cannot split does.
  const zeroesAreTrue = always && ![...acc.cents].some(([g, c]) => UNSPLIT.has(g) && c > 0);
  for (const g of LINE_GROUP_ORDER) {
    const has = acc.cents.has(g);
    if (!has && !(zeroesAreTrue && (g === "labor" || g === "materials"))) continue;
    lines.push({ group: g, label: LINE_GROUP_LABEL[g], amount: dollars(acc.cents.get(g) ?? 0) });
  }
  return { laborHours: acc.unhoured > 0 ? 0 : acc.units / 100, lines };
}
type PlacedPayment = { date: string; cents: number; method: string | null; kind: "payment" | "credit"; invoiceNumber: string | null; seq: number };

export function buildJobLedger(input: LedgerInput): JobLedger {
  const tz = input.tz;
  const invoices = [...(input.invoices ?? [])];
  const invById = new Map(invoices.map((i) => [i.id, i] as const));
  const invDay = (inv: LedgerInvoiceIn | undefined): string =>
    orgDay(inv?.sent_at ?? null, tz) ?? orgDay(inv?.created_at ?? null, tz) ?? todayStrInTz(tz);

  const work: Placed[] = [];
  const lineSum = new Map<string, number>();

  const lines = [...(input.lines ?? [])].sort(
    (a, b) => a.invoice_id.localeCompare(b.invoice_id) || (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );

  const creditPieces = placeDrawCredits(invoices, lines, invDay);
  for (const ln of lines) {
    const inv = invById.get(ln.invoice_id);
    if (!inv) continue; // a line of a bill this customer is not shown
    const num = inv.invoice_number ?? null;
    const L = toCents(ln.line_total);
    lineSum.set(ln.invoice_id, (lineSum.get(ln.invoice_id) ?? 0) + L);
    const src = ln.import_source ?? null;
    const priceCents = toCents(ln.unit_price);
    const qty = Number(ln.quantity) || 0;

    if (src === "labor") {
      const entries = [...(ln.entries ?? [])]
        .filter((e) => e && e.clock_in)
        .sort((a, b) => Date.parse(a.clock_in) - Date.parse(b.clock_in));
      const ms = entries.map(workedMs);
      const T = Math.round(qty * 100);
      const workedUnits = ms.reduce((s, m) => s + m, 0) / MS_PER_UNIT;
      const dollarsMatch = Math.abs(100 * L - T * priceCents) < 100;
      const lastDay = entries.length ? orgDay(entries[entries.length - 1].clock_in, tz) : null;
      const spreadable = entries.length > 0 && T > 0 && ms.some((m) => m > 0) && Math.abs(T - workedUnits) <= ROUNDING_SLACK_UNITS && dollarsMatch;
      if (!spreadable) {
        work.push({
          date: lastDay ?? invDay(inv),
          labor: { person: lumpName(ln.description), units: T, rateCents: priceCents, cents: L, invoiceNumber: num, lump: true },
        });
        continue;
      }
      const units = spreadHours(ms, T);
      const cents = splitByWeight(L, units);
      entries.forEach((e, i) => {
        if (units[i] === 0 && cents[i] === 0) return;
        work.push({
          date: orgDay(e.clock_in, tz) ?? invDay(inv),
          labor: { person: (e.person ?? "").trim() || "Crew", units: units[i], rateCents: priceCents, cents: cents[i], invoiceNumber: num, lump: false },
        });
      });
      continue;
    }

    let date: string | null = null;
    let datedBy: ItemRow["datedBy"] = "bill";
    if (src === "costs") {
      for (const s of ln.sources ?? []) {
        const d = orgDay(s?.date ?? null, tz) ?? orgDay(s?.at ?? null, tz);
        if (d && (!date || d > date)) date = d;
      }
      if (date) datedBy = "purchase";
    }
    const kind: ItemKind = src === "costs" ? "material" : src === "draw_credit" ? "credit" : "charge";
    const group = lineGroup({ import_source: src, unit: ln.unit, description: ln.description }, inv.invoice_kind ?? null);
    const pieces = creditPieces.get(ln);
    if (pieces) {
      // A credit is listed once per bill it takes off, each piece on that bill's day (MR5).
      const words = customerLineWords({ description: ln.description, import_source: src });
      const whole = pieces.length === 1;
      for (const pc of pieces) {
        work.push({
          date: pc.date ?? invDay(inv),
          item: {
            description: words,
            quantity: whole ? qty : 1,
            unit: whole ? ln.unit ?? null : null,
            unitPriceCents: whole ? priceCents : pc.cents,
            cents: pc.cents,
            kind,
            group,
            invoiceNumber: num,
            datedBy: pc.datedBy,
          },
        });
      }
      continue;
    }
    // A receipt's remainder row names the supplier: the customer reads the same words the bill prints.
    // So does a lump, an order and a return (customerLineWords).
    const supplies = isSuppliesAndTaxLine({ description: ln.description, import_source: src });
    work.push({
      date: date ?? invDay(inv),
      item: supplies
        ? { description: SUPPLIES_AND_TAX_LABEL, quantity: 1, unit: null, unitPriceCents: L, cents: L, kind, group, invoiceNumber: num, datedBy }
        : { description: customerLineWords({ description: ln.description, import_source: src }), quantity: qty, unit: ln.unit ?? null, unitPriceCents: priceCents, cents: L, kind, group, invoiceNumber: num, datedBy },
    });
  }

  // The tax, and anything between the lines and the bill's total, dated by the bill.
  for (const inv of invoices) {
    const num = inv.invoice_number ?? null;
    const tax = toCents(inv.tax);
    if (tax !== 0) {
      work.push({ date: invDay(inv), item: { description: "Sales Tax", quantity: 1, unit: null, unitPriceCents: tax, cents: tax, kind: "tax", group: "tax", invoiceNumber: num, datedBy: "bill" } });
    }
    const gap = toCents(inv.total) - (lineSum.get(inv.id) ?? 0) - tax;
    if (gap !== 0) {
      work.push({
        date: invDay(inv),
        item: { description: `Adjustment On ${num ?? "The Bill"}`, quantity: 1, unit: null, unitPriceCents: gap, cents: gap, kind: "adjustment", group: "other", invoiceNumber: num, datedBy: "bill" },
      });
    }
  }

  const pays: PlacedPayment[] = [];
  const paidSum = new Map<string, number>();
  (input.payments ?? []).forEach((p, seq) => {
    const inv = invById.get(p.invoice_id);
    if (!inv) return;
    const c = toCents(p.amount);
    paidSum.set(p.invoice_id, (paidSum.get(p.invoice_id) ?? 0) + c);
    pays.push({ date: orgDay(p.paid_at, tz) ?? invDay(inv), cents: c, method: p.method ?? null, kind: "payment", invoiceNumber: inv.invoice_number ?? null, seq });
  });
  for (const inv of invoices) {
    const gap = toCents(inv.amount_paid) - (paidSum.get(inv.id) ?? 0);
    if (gap !== 0) pays.push({ date: invDay(inv), cents: gap, method: null, kind: "credit", invoiceNumber: inv.invoice_number ?? null, seq: 1e9 });
  }

  // The stretches, in order. None named: the job is one stretch.
  const named = [...(input.stretches ?? [])]
    .filter((s) => s && YMD.test(s.starts_on) && YMD.test(s.ends_on))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on) || (a.sort ?? 0) - (b.sort ?? 0));
  const allDates = [...work.map((w) => w.date), ...pays.map((p) => p.date)].sort();
  const groups: { id: string | null; label: string; startsOn: string | null; endsOn: string | null }[] = named.length
    ? named.map((s) => ({ id: s.id, label: s.label, startsOn: s.starts_on, endsOn: s.ends_on }))
    : [{ id: null, label: "All Work", startsOn: allDates[0] ?? null, endsOn: allDates[allDates.length - 1] ?? null }];

  const place = (d: string): number => {
    if (!named.length) return 0;
    const holding = named.findIndex((s) => s.starts_on <= d && d <= s.ends_on);
    if (holding >= 0) return holding;
    let before = -1;
    named.forEach((s, i) => {
      if (s.starts_on <= d) before = i;
    });
    return before >= 0 ? before : 0;
  };
  const outside = (g: (typeof groups)[number], d: string): Outside =>
    !g.startsOn || !g.endsOn ? null : d < g.startsOn ? "before" : d > g.endsOn ? "after" : null;

  type Acc = { days: Map<string, Placed[]>; pays: PlacedPayment[] };
  const acc: Acc[] = groups.map(() => ({ days: new Map(), pays: [] }));
  for (const w of work) {
    const a = acc[place(w.date)];
    const list = a.days.get(w.date) ?? [];
    list.push(w);
    a.days.set(w.date, list);
  }
  for (const p of pays) acc[place(p.date)].pays.push(p);

  let cumWork = 0;
  let cumPaid = 0;
  const jobSplit = newSplit();
  const stretches: LedgerStretch[] = groups.map((g, gi) => {
    const a = acc[gi];
    let workCents = 0;
    let unitsAll = 0;
    const stretchSplit = newSplit();
    const days: LedgerDay[] = [...a.days.keys()].sort().map((date) => {
      const placed = a.days.get(date)!;
      const daySplit = newSplit();
      for (const p of placed) addPlaced(daySplit, p);
      mergeSplit(stretchSplit, daySplit);
      // One row per person per rate per bill on a day (two entries the same day read as one).
      const laborMap = new Map<string, { person: string; units: number; rateCents: number; cents: number; invoiceNumber: string | null; lump: boolean }>();
      const items: ItemRow[] = [];
      let dayCents = 0;
      let dayUnits = 0;
      for (const p of placed) {
        if (p.labor) {
          const l = p.labor;
          const key = `${l.person}|${l.rateCents}|${l.invoiceNumber ?? ""}|${l.lump ? 1 : 0}`;
          const cur = laborMap.get(key);
          if (cur) {
            cur.units += l.units;
            cur.cents += l.cents;
          } else laborMap.set(key, { ...l });
          dayCents += l.cents;
          dayUnits += l.units;
        } else if (p.item) {
          const it = p.item;
          items.push({
            description: it.description,
            quantity: it.quantity,
            unit: it.unit,
            unitPrice: dollars(it.unitPriceCents),
            amount: dollars(it.cents),
            kind: it.kind,
            group: it.group,
            invoiceNumber: it.invoiceNumber,
            datedBy: it.datedBy,
          });
          dayCents += it.cents;
        }
      }
      workCents += dayCents;
      unitsAll += dayUnits;
      const labor: LaborRow[] = [...laborMap.values()]
        .sort((x, y) => Number(x.lump) - Number(y.lump) || x.person.localeCompare(y.person))
        .map((l) => ({ person: l.person, hours: l.units / 100, rate: dollars(l.rateCents), amount: dollars(l.cents), invoiceNumber: l.invoiceNumber, lump: l.lump }));
      const o = outside(g, date);
      return { date, inRange: o === null, outside: o, hours: dayUnits / 100, total: dollars(dayCents), labor, items, split: outSplit(daySplit, false) };
    });
    const payRows = [...a.pays].sort((x, y) => x.date.localeCompare(y.date) || x.seq - y.seq);
    const paidCents = payRows.reduce((s, p) => s + p.cents, 0);
    cumWork += workCents;
    cumPaid += paidCents;
    mergeSplit(jobSplit, stretchSplit);
    return {
      id: g.id,
      label: g.label,
      startsOn: g.startsOn,
      endsOn: g.endsOn,
      days,
      payments: payRows.map((p) => {
        const o = outside(g, p.date);
        return { date: p.date, inRange: o === null, outside: o, amount: dollars(p.cents), method: p.method, kind: p.kind, invoiceNumber: p.invoiceNumber };
      }),
      hours: unitsAll / 100,
      workTotal: dollars(workCents),
      split: outSplit(stretchSplit, true),
      paidTotal: dollars(paidCents),
      balanceAfter: dollars(cumWork - cumPaid),
    };
  });

  const billedCents = invoices.reduce((s, i) => s + toCents(i.total), 0);
  const billedBalanceCents = invoices.reduce((s, i) => s + toCents(i.total) - toCents(i.amount_paid), 0);
  return {
    stretches,
    workTotal: dollars(cumWork),
    split: outSplit(jobSplit, true),
    paidTotal: dollars(cumPaid),
    balance: dollars(cumWork - cumPaid),
    billedTotal: dollars(billedCents),
    billedBalance: dollars(billedBalanceCents),
    reconciles: cumWork === billedCents && cumWork - cumPaid === billedBalanceCents,
  };
}

type CreditPiece = { cents: number; date: string | null; datedBy: ItemRow["datedBy"] };

/**
 * WHICH BILL EACH PIECE OF A DRAW CREDIT TAKES OFF (audit v994 MR5, and the review of its fix).
 *
 * A "Less previous billings" credit nets the lump money billed before it (fixedBillingsToNet): a
 * deposit, and also a fixed-$ or %-of-estimate payment request, a milestone. Dated by its own bill,
 * the credit sat in a later stretch than the charges it cancels, so every stretch between read them
 * as work owed. Dated whole with the deposit, a credit that also nets a later $5,000 request made
 * the first stretch's work negative and said "Paid Ahead $15,000" when $10,000 had been paid. So
 * the lump bills are queued oldest first (lumpDrawAmount, the rule the netting itself uses), the
 * credits take from them oldest first, and each piece is dated on the day of the bill it takes off:
 * every charge and its credit cancel in the same stretch, whichever order the bills were sent in
 * (J-002's deposit went out after its progress bill). Whatever a credit nets beyond the lump money
 * the customer is shown stays on its own bill's day. Pieces are integer cents and sum to the line.
 */
function placeDrawCredits(
  invoices: LedgerInvoiceIn[],
  lines: LedgerLineIn[],
  invDay: (inv: LedgerInvoiceIn | undefined) => string,
): Map<LedgerLineIn, CreditPiece[]> {
  const byInv = new Map<string, LedgerLineIn[]>();
  for (const ln of lines) byInv.set(ln.invoice_id, [...(byInv.get(ln.invoice_id) ?? []), ln]);
  const invById = new Map(invoices.map((i) => [i.id, i] as const));
  const order = (a: LedgerInvoiceIn, b: LedgerInvoiceIn) =>
    invDay(a).localeCompare(invDay(b)) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);

  const lumps = invoices
    .map((inv) => ({ inv, left: toCents(lumpDrawAmount({ status: inv.status, invoice_kind: inv.invoice_kind, items: byInv.get(inv.id) ?? [] })) }))
    .filter((x) => x.left > 0)
    .sort((a, b) => order(a.inv, b.inv));

  const credits = lines
    .filter((ln) => ln.import_source === "draw_credit" && invById.has(ln.invoice_id))
    .sort((a, b) => order(invById.get(a.invoice_id)!, invById.get(b.invoice_id)!) || (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const out = new Map<LedgerLineIn, CreditPiece[]>();
  for (const ln of credits) {
    const L = toCents(ln.line_total);
    let owed = Math.max(0, -L);
    const pieces: CreditPiece[] = [];
    for (const lump of lumps) {
      if (owed === 0) break;
      if (lump.left === 0) continue;
      const take = Math.min(lump.left, owed);
      lump.left -= take;
      owed -= take;
      const date = invDay(lump.inv);
      const datedBy: CreditPiece["datedBy"] = lump.inv.invoice_kind === "deposit" ? "deposit" : "draw";
      const last = pieces[pieces.length - 1];
      if (last && last.date === date && last.datedBy === datedBy) last.cents -= take;
      else pieces.push({ cents: -take, date, datedBy });
    }
    const rest = L - pieces.reduce((s, p) => s + p.cents, 0);
    if (rest !== 0 || pieces.length === 0) pieces.push({ cents: rest, date: null, datedBy: "bill" });
    out.set(ln, pieces);
  }
  return out;
}

/** "Labor - Erik Taylor" → "Erik Taylor"; anything else is shown as written. */
function lumpName(description: string): string {
  const m = /^\s*labou?r\s*[-–—:]\s*(.+)$/i.exec(description ?? "");
  return (m ? m[1] : description ?? "").trim() || "Crew";
}
