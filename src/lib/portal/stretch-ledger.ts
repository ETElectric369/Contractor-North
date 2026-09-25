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
 * Every figure is carried in integer cents (and hours in integer hundredths) and only turned into
 * dollars on the way out, so "reconciles" is an equality, not a tolerance.
 */
import { todayStrInTz } from "@/lib/tz";
import { SUPPLIES_AND_TAX_LABEL, customerLineWords, isSuppliesAndTaxLine } from "@/lib/invoice-math";

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
  invoiceNumber: string | null;
  /** "purchase": the day it was bought. "bill": it has no day of its own, so it carries its bill's. */
  datedBy: "purchase" | "bill";
};
/** Where a dated row sits against its stretch's own dates: inside them (null), before the first
 *  stretch began (a deposit, early work), or after the stretch ended and before the next began. */
export type Outside = "before" | "after" | null;
export type LedgerDay = { date: string; inRange: boolean; outside: Outside; hours: number; total: number; labor: LaborRow[]; items: ItemRow[] };
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
  paidTotal: number;
  /** Cumulative work − cumulative paid through the end of this stretch. No floor. */
  balanceAfter: number;
};
export type JobLedger = {
  stretches: LedgerStretch[];
  workTotal: number;
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
    let datedBy: "purchase" | "bill" = "bill";
    if (src === "costs") {
      for (const s of ln.sources ?? []) {
        const d = orgDay(s?.date ?? null, tz) ?? orgDay(s?.at ?? null, tz);
        if (d && (!date || d > date)) date = d;
      }
      if (date) datedBy = "purchase";
    }
    const kind: ItemKind = src === "costs" ? "material" : src === "draw_credit" ? "credit" : "charge";
    // A receipt's remainder row names the supplier: the customer reads the same words the bill prints.
    // So does a lump, an order and a return (customerLineWords).
    const supplies = isSuppliesAndTaxLine({ description: ln.description, import_source: src });
    work.push({
      date: date ?? invDay(inv),
      item: supplies
        ? { description: SUPPLIES_AND_TAX_LABEL, quantity: 1, unit: null, unitPriceCents: L, cents: L, kind, invoiceNumber: num, datedBy }
        : { description: customerLineWords({ description: ln.description, import_source: src }), quantity: qty, unit: ln.unit ?? null, unitPriceCents: priceCents, cents: L, kind, invoiceNumber: num, datedBy },
    });
  }

  // The tax, and anything between the lines and the bill's total, dated by the bill.
  for (const inv of invoices) {
    const num = inv.invoice_number ?? null;
    const tax = toCents(inv.tax);
    if (tax !== 0) {
      work.push({ date: invDay(inv), item: { description: "Sales Tax", quantity: 1, unit: null, unitPriceCents: tax, cents: tax, kind: "tax", invoiceNumber: num, datedBy: "bill" } });
    }
    const gap = toCents(inv.total) - (lineSum.get(inv.id) ?? 0) - tax;
    if (gap !== 0) {
      work.push({
        date: invDay(inv),
        item: { description: `Adjustment On ${num ?? "The Bill"}`, quantity: 1, unit: null, unitPriceCents: gap, cents: gap, kind: "adjustment", invoiceNumber: num, datedBy: "bill" },
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
  const stretches: LedgerStretch[] = groups.map((g, gi) => {
    const a = acc[gi];
    let workCents = 0;
    let unitsAll = 0;
    const days: LedgerDay[] = [...a.days.keys()].sort().map((date) => {
      const placed = a.days.get(date)!;
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
      return { date, inRange: o === null, outside: o, hours: dayUnits / 100, total: dollars(dayCents), labor, items };
    });
    const payRows = [...a.pays].sort((x, y) => x.date.localeCompare(y.date) || x.seq - y.seq);
    const paidCents = payRows.reduce((s, p) => s + p.cents, 0);
    cumWork += workCents;
    cumPaid += paidCents;
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
      paidTotal: dollars(paidCents),
      balanceAfter: dollars(cumWork - cumPaid),
    };
  });

  const billedCents = invoices.reduce((s, i) => s + toCents(i.total), 0);
  const billedBalanceCents = invoices.reduce((s, i) => s + toCents(i.total) - toCents(i.amount_paid), 0);
  return {
    stretches,
    workTotal: dollars(cumWork),
    paidTotal: dollars(cumPaid),
    balance: dollars(cumWork - cumPaid),
    billedTotal: dollars(billedCents),
    billedBalance: dollars(billedBalanceCents),
    reconciles: cumWork === billedCents && cumWork - cumPaid === billedBalanceCents,
  };
}

/** "Labor - Erik Taylor" → "Erik Taylor"; anything else is shown as written. */
function lumpName(description: string): string {
  const m = /^\s*labou?r\s*[-–—:]\s*(.+)$/i.exec(description ?? "");
  return (m ? m[1] : description ?? "").trim() || "Crew";
}
