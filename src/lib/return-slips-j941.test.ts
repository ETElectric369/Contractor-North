import { describe, it, expect } from "vitest";
import { billLineCost } from "@/lib/bill-itemisation";
import { isReturnBill, returnLinesAgainstPurchases } from "@/lib/supplier-returns";
import { pairCreditAcrossBills, type MemoLine, type PurchaseLine, type ReturnBill } from "@/lib/credit-memo-close";

/**
 * THE OWNER'S PAPERS AS ONE TEST (cn-v1186). Five delivery tickets from one supplier on one job and
 * four return slips; the draft invoice came out low because (1) two slips named a part in different
 * abbreviations from the ticket and matched nothing, and (2) a part bought on two lines (three kept and
 * billed, five crossed out as returned) had the slip's five credited against the three that billed.
 * Stand-ins: supplier "Northline Supply", job J-941. The part descriptions are catalogue text.
 */

type Line = PurchaseLine;
let n = 0;
const line = (description: string, quantity: number, amount: number, over: Partial<Line> = {}): Line => ({
  id: `l${String(++n).padStart(3, "0")}`,
  description,
  quantity,
  unit_price: Math.round((amount / quantity) * 10000) / 10000,
  amount,
  category: "Electrical",
  billable: true,
  billed_amount: null,
  is_stock: false,
  returned: false,
  returned_credit_bill_id: null,
  sort_order: n,
  ...over,
});
/** Crossed out as returned on the ticket (0417): not billable, returned, no credit has closed it. */
const gone = (description: string, quantity: number, amount: number) => line(description, quantity, amount, { billable: false, returned: true });

type Ticket = { id: string; bill_date: string; created_at: string; amount: number; lines: Line[] };
const ticket = (id: string, day: number, lines: Line[]): Ticket => ({
  id,
  bill_date: `2026-11-${String(day).padStart(2, "0")}`,
  created_at: `2026-11-${String(day).padStart(2, "0")}T15:00:00Z`,
  amount: Math.round(lines.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100,
  lines,
});

const tickets = (): Ticket[] => {
  n = 0;
  return [
    ticket("ticket-a", 3, [
      line("SIEM Q120 SP 20A 120/240V CB", 3, 28.47),
      gone("SIEM Q120 SP 20A 120/240V CB", 5, 47.45),
      gone("SIEM Q230 2P 30A 120/240V CB", 2, 41.54),
      gone("SIEM Q115 SP 15A 120/240V CB", 5, 47.45),
      gone("RACO 53890 2G WP Box w/5 1 in Hubs", 1, 29.03),
      gone("BLINE 18186RTSCNK NM3R SC Enclosure", 1, 173.84),
    ]),
    ticket("ticket-b", 4, [gone("SIEM Q22050CT QUAD 20/50", 1, 61.47), gone("SIEM Q23050CT2 QUAD 2P 120/240V CB", 1, 70.07), gone("SIEM QSA2020SPD 1P 120V BKR&SPD", 1, 185.92)]),
    ticket("ticket-c", 5, [gone("SIEM PNW3048L1200C 30/48CT 200A N3R LD-CTR", 1, 422.51)]),
    ticket("ticket-d", 6, [gone("SIEM MBK125A 125A Riser Main CB Kit", 1, 129.52), gone("SIEM ECSBPK02 Standby Pwr Interlock Kit", 1, 64.87)]),
    ticket("ticket-e", 7, [line("SIEM ECSBPK10 Manual Interlock Kit", 1, 139.6)]),
  ];
};

/** A slip's part lines (negative), and a 9% tax line on its parts. */
type Slip = { id: string; created_at: string; amount: number; lines: Line[] };
const slip = (id: string, day: number, parts: [string, number, number][]): Slip => {
  const lines = parts.map(([d, q, a]) => line(d, -q, -a));
  const partsTotal = parts.reduce((s, [, , a]) => s + a, 0);
  const tax = Math.round(partsTotal * 0.09 * 100) / 100;
  lines.push(line("Sales Tax", 1, -tax, { category: "Tax" }));
  return { id, created_at: `2026-11-${day}T15:00:00Z`, amount: -Math.round((partsTotal + tax) * 100) / 100, lines };
};
const slips = (): Slip[] => [
  slip("slip-1", 10, [
    ["SIEM Q120 SP 20A 120/240V CB (credit)", 5, 47.45],
    ["SIEM Q23050CT2 QUAD 2P 120/240V CB (credit)", 1, 70.07],
    ["SIEM Q22050CT QUAD 20/50 (credit)", 1, 61.47],
  ]),
  slip("slip-2", 11, [
    ["SIEM PNW3048L1200C 30/48CT 200A N3R LD-CTR", 1, 422.51],
    ["BLINE 18186RTSCNK NM3R SC ENCL", 1, 173.84],
    ["SIEM ECSBPK10 MANUAL INTERLOCK KIT", 1, 139.6],
  ]),
  slip("slip-3", 12, [
    ["SIEM QSA2020SPD 1P 120V BKR&SPD", 1, 185.92],
    ["SIEM MBK125A 125A RISER MAIN CB KT", 1, 129.52],
    ["SIEM Q115 SP 15A 120/240V CB", 5, 47.45],
    ["SIEM Q230 2P 30A 120/240V CB", 2, 41.54],
  ]),
  slip("slip-4", 13, [["RACO 53890 2G WP BOX W/5 1-IN-HUBS (return)", 1, 29.03]]),
];

const isPart = (l: Line) => l.category !== "Tax" && billLineCost(l) < 0;
/** What a slip's part line credits at cost after the matcher: the cap it was given, else the whole line. */
const credited = (l: Line) => (l.billed_amount == null ? -billLineCost(l) : Number(l.billed_amount));

describe("J-941, Northline Supply: four return slips against five tickets", () => {
  it("(a) before any filing, only the Manual Interlock Kit credits anything, in full; the three Q120 that billed are untouched", () => {
    const ts = tickets();
    const ss = slips();
    const bills = [...ts, ...ss];
    const held = returnLinesAgainstPurchases(bills, (b) => b.lines);
    const crediting = ss.flatMap((s) => (held.get(s) ?? s.lines).filter((l) => isPart(l as Line) && credited(l as Line) > 0).map((l) => [l.description, credited(l as Line)]));
    expect(crediting).toEqual([["SIEM ECSBPK10 MANUAL INTERLOCK KIT", 139.6]]);
    expect(bills.filter((b) => isReturnBill(b.amount)).length).toBe(4);
  });

  it("(b) each slip pairs EVERY part line: ten close a line already crossed out, one closes the interlock kit whole, none stays", () => {
    const ts = tickets();
    const ss = slips();
    const returnBills: ReturnBill[] = ts.map((t) => ({ id: t.id, bill_date: t.bill_date, invoiced: false, lines: t.lines }));
    const kinds = ss.flatMap((s) => pairCreditAcrossBills(s.lines, returnBills).filter((p) => p.kind !== "tax"));
    expect(kinds.filter((p) => p.kind === "closeReturned")).toHaveLength(10);
    expect(kinds.filter((p) => p.kind === "closeWhole").map((p) => ("line" in p ? p.line.description : null))).toEqual(["SIEM ECSBPK10 Manual Interlock Kit"]);
    expect(kinds.filter((p) => p.kind === "stays")).toEqual([]);
    expect(kinds).toHaveLength(11);
  });

  it("(c) with slip 1 filed, a later slip returning three of the Q120 that billed credits those three in full", () => {
    const ts = tickets();
    const [s1] = slips();
    const returnBills: ReturnBill[] = ts.map((t) => ({ id: t.id, bill_date: t.bill_date, invoiced: false, lines: t.lines }));
    // File slip 1 as its door does: each closed line names the credit, and the credit's own lines bill nothing.
    for (const p of pairCreditAcrossBills(s1.lines, returnBills, { creditId: s1.id })) {
      if (p.kind === "closeReturned") p.line.returned_credit_bill_id = s1.id;
    }
    expect(ts[0].lines[1].returned_credit_bill_id).toBe("slip-1");
    const filed: Slip = { ...s1, lines: s1.lines.map((l) => ({ ...l, billable: false })) };
    const later: Slip = { id: "slip-5", created_at: "2026-11-14T15:00:00Z", amount: -28.47, lines: [line("SIEM Q120 SP 20A 120/240V CB", -3, -28.47)] };
    const held = returnLinesAgainstPurchases([...ts, filed, later], (b) => b.lines);
    const back = (held.get(later) ?? later.lines).filter((l) => isPart(l as Line)).map((l) => credited(l as Line));
    expect(back).toEqual([28.47]);
  });
});
