import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseCSV } from "./csv";
import { balanceChain, chainSaid, checkScanTotals, verifySaid, verifyStatement, type ChainLine, type ScanControls } from "./statement-verify";
import { looksLikeBankTable, readBankTable } from "./bank-download";
import { findHeaderRow, readHeaderRow, readOpenListTable } from "./supplier-open-list";
import { readOfx } from "./ofx-read";

/**
 * EVERY LINE PROVES THE ONE BEFORE IT (2026-10-02).
 *
 * Erik, after cn-v1050 put a totals check on the scanned-statement path only: "I imagine everything
 * will get verified with the reconcile anyway no matter what document is input correct, the way that
 * the PDF needs his own verification system — is there a second one for all of it as I'm imagining
 * there is?" There wasn't. This is it, and the check he described is the better of the two: it works on
 * every source, it catches two errors that CANCEL out of a totals check, and it names a LINE.
 *
 * EVERY FIGURE AND NAME BELOW IS INVENTED. No bank, supplier, customer or account on this page exists;
 * the amounts were made up and then walked by hand so the chains in them actually add up.
 */

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * ONE CORRECT MONTH, AS THE CHAIN SEES IT: oldest first, a balance after every line, and every balance
 * is the one above it plus that line's money. Opening balance $4,000.00.
 *
 *   Sep 2   -142.08  →  3857.92
 *   Sep 5   -1250.00 →  2607.92
 *   Sep 8   +3400.00 →  6007.92
 *   Sep 12  -812.33  →  5195.59
 *   Sep 19  +37.42   →  5233.01
 *   Sep 30  -12.00   →  5221.01
 */
const MONTH: ChainLine[] = [
  { row: 2, postedOn: "2026-09-02", cents: -14208, balanceAfterCents: 385792 },
  { row: 3, postedOn: "2026-09-05", cents: -125000, balanceAfterCents: 260792 },
  { row: 4, postedOn: "2026-09-08", cents: 340000, balanceAfterCents: 600792 },
  { row: 5, postedOn: "2026-09-12", cents: -81233, balanceAfterCents: 519559 },
  { row: 6, postedOn: "2026-09-19", cents: 3742, balanceAfterCents: 523301 },
  { row: 7, postedOn: "2026-09-30", cents: -1200, balanceAfterCents: 522101 },
];

/** The same month's own printed control figures, which a statement prints and a download does not. */
const CONTROLS: ScanControls = { beginning: 400000, ending: 522101, deposits: 343742, withdrawals: 221641, account: "deposit" };

describe("the chain: a correct file passes, and says how much it checked", () => {
  it("every link adds up, and the sentence says so in plain words", () => {
    const c = balanceChain(MONTH);
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.links).toBe(5);
    expect(c.lines).toBe(6);
    expect(c.withBalance).toBe(6);
    expect(c.reversed).toBe(false);
    expect(c.card).toBe(false);
    expect(c.sameDay).toBe(0);
    const said = chainSaid(c);
    expect(said).toContain("proves every line");
    expect(said).toContain("5 links across 6 lines");
  });

  it("A LINE MISSING names the line it broke at, its day, and the amount", () => {
    // The Sep 5 check never read. Sep 8's printed balance is then $1,250.00 further down than the
    // walk from Sep 2 can reach.
    const short = MONTH.filter((l) => l.cents !== -125000);
    const c = balanceChain(short);
    expect(c.ran).toBe(true);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toEqual({ row: 4, day: "2026-09-08", offByCents: 125000 });
    const said = chainSaid(c);
    expect(said).toContain("line 4 (Sep 8)");
    expect(said).toContain("$1,250.00");
    expect(said).toContain("missing, in twice");
  });

  it("A LINE IN TWICE breaks the day it sits on, by the line's own amount", () => {
    const twice = [MONTH[0], MONTH[1], { ...MONTH[1], row: 99 }, ...MONTH.slice(2)];
    const c = balanceChain(twice);
    expect(c.breaks).toHaveLength(1);
    // Named by the FIRST line of the day it broke on: that is where a person starts looking.
    expect(c.breaks[0]).toMatchObject({ row: 3, day: "2026-09-05", offByCents: 125000 });
  });

  it("A WRONG AMOUNT is caught to the cent", () => {
    const off = MONTH.map((l) => (l.row === 5 ? { ...l, cents: -81243 } : l));
    const c = balanceChain(off);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 5, offByCents: 10 });
  });

  it("A FLIPPED SIGN is caught, by twice the line", () => {
    const flipped = MONTH.map((l) => (l.row === 6 ? { ...l, cents: -3742 } : l));
    const c = balanceChain(flipped);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 6, offByCents: 2 * 3742 });
  });

  it("the FIRST break is said in full and the rest are counted, never listed", () => {
    // Two lines read wrong, far apart. One sentence, one line to go and look at, and a count.
    const two = MONTH.map((l) => (l.row === 3 ? { ...l, cents: -125100 } : l.row === 6 ? { ...l, cents: 3842 } : l));
    const c = balanceChain(two);
    expect(c.breaks.map((b) => b.row)).toEqual([3, 6]);
    const said = chainSaid(c);
    expect(said).toContain("line 3 (Sep 5)");
    expect(said).toContain("One more link");
    expect(said).not.toContain("line 6 (");
  });

  it("MANY BREAKS keep only a few, and still count them all: this verdict is stored on the row", () => {
    // A column that walks for one link and then goes wrong on every line after. Only the first few
    // breaks are kept (a jsonb column is not a place for thousands of them) and the count is honest.
    const wrong: ChainLine[] = [
      { row: 2, postedOn: "2026-09-01", cents: -1000, balanceAfterCents: 99000 },
      { row: 3, postedOn: "2026-09-02", cents: -1000, balanceAfterCents: 98000 },
      ...Array.from({ length: 12 }, (_, n) => ({ row: 4 + n, postedOn: `2026-09-${String(4 + n).padStart(2, "0")}`, cents: -1000, balanceAfterCents: 50000 + n })),
    ];
    const c = balanceChain(wrong);
    expect(c.ran).toBe(true);
    expect(c.broke).toBe(12);
    expect(c.breaks).toHaveLength(5);
    expect(chainSaid(c)).toContain("11 more links");
  });
});

/**
 * THE TEST THAT PROVES THE LANE WAS WORTH DOING. A totals check passes when two errors cancel; a chain
 * cannot, because it holds every line against the one before it rather than against a grand total.
 */
describe("two errors that cancel: the totals agree and the chain still catches it", () => {
  // $10.00 taken off the Sep 5 check and put onto the Sep 12 card payment. Money out is unchanged, so
  // every printed total still agrees to the cent, and so does the balance from end to end.
  const cancelled: ChainLine[] = MONTH.map((l) => (l.row === 3 ? { ...l, cents: -124000 } : l.row === 5 ? { ...l, cents: -82233 } : l));

  it("the printed totals see nothing wrong at all", () => {
    const totals = checkScanTotals(cancelled, CONTROLS);
    expect(totals.pass).toBe(true);
    expect(totals.failed).toEqual([]);
    expect(totals.agreed).toEqual(["the money going out", "the money coming in", "the balance from end to end"]);
  });

  it("the chain breaks at both of them, and names the first", () => {
    const c = balanceChain(cancelled);
    expect(c.breaks.map((b) => [b.row, b.offByCents])).toEqual([
      [3, 1000],
      [5, 1000],
    ]);
    expect(chainSaid(c)).toContain("line 3 (Sep 5)");
  });

  it("and the one verification refuses the read on the strength of the chain alone", () => {
    const v = verifyStatement({ lines: cancelled, source: "picture", controls: CONTROLS });
    expect(v.pass).toBe(false);
    expect(v.failed[0].which).toBe("chain");
    expect(v.failed[0].said).toContain("line 3 (Sep 5)");
    // And the sentence does NOT say the printed figures cleared it, which they did.
    expect(verifySaid(v)).toContain("stops adding up");
  });
});

describe("order: a file listed newest-first is not a broken file", () => {
  it("the same month in reverse passes, and the report says which way round it is", () => {
    const c = balanceChain([...MONTH].reverse());
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.reversed).toBe(true);
    expect(chainSaid(c)).toContain("newest first");
  });

  it("A GENUINELY BROKEN FILE IS NOT REPAIRED BY TRYING BOTH WAYS ROUND", () => {
    // The one thing a two-way walk must never do: pass a file with a line missing because the other
    // direction happened to complain less. A shape has to explain EVERY link to be believed.
    const broken = MONTH.filter((l) => l.cents !== -125000);
    for (const lines of [broken, [...broken].reverse()]) {
      const c = balanceChain(lines);
      expect(c.ran).toBe(true);
      expect(c.breaks).toHaveLength(1);
      expect(c.breaks[0].offByCents).toBe(125000);
    }
  });

  it("A MONTH ALL ON ONE DAY still has its links walked: date order never decides the order", () => {
    const oneDay: ChainLine[] = [
      { row: 2, postedOn: "2026-09-04", cents: -2000, balanceAfterCents: 98000 },
      { row: 3, postedOn: "2026-09-04", cents: -1500, balanceAfterCents: 96500 },
      { row: 4, postedOn: "2026-09-04", cents: 5000, balanceAfterCents: 101500 },
    ];
    const c = balanceChain(oneDay);
    expect(c.ran).toBe(true);
    expect(c.links).toBe(2);
    expect(c.breaks).toEqual([]);
    expect(c.sameDay).toBe(0);
  });
});

describe("a card's balance is what you owe, so the walk runs the other way", () => {
  // A card export, oldest first: a purchase RAISES what is owed and the payment lowers it.
  const CARD: ChainLine[] = [
    { row: 2, postedOn: "2026-09-03", cents: -6210, balanceAfterCents: 46210 },
    { row: 3, postedOn: "2026-09-09", cents: -14500, balanceAfterCents: 60710 },
    { row: 4, postedOn: "2026-09-18", cents: 50000, balanceAfterCents: 10710 },
    { row: 5, postedOn: "2026-09-27", cents: -3300, balanceAfterCents: 14010 },
  ];

  it("it passes, and the sentence says which balance this is", () => {
    const c = balanceChain(CARD);
    expect(c.ran).toBe(true);
    expect(c.card).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(chainSaid(c)).toContain("what you owe");
  });

  it("and a line missing off a card is still caught", () => {
    const c = balanceChain(CARD.filter((l) => l.row !== 3));
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 4, offByCents: 14500 });
  });
});

/**
 * SAME-DAY LINES, AND WHY A CHECK THAT CRIES WOLF IS WORSE THAN NONE. Several transactions on one day
 * may be printed in an order they did not post in, so the running balance beside them looks out of
 * step on a file with no error in it at all. The day's NET is what the balance column proves, so a day
 * whose lines don't walk one by one is held to its own net instead — and said as that.
 */
describe("same-day lines printed out of posting order raise no false alarm", () => {
  // Sep 12 posted -200.00 then -50.00 (balances 1800.00 then 1750.00) and is PRINTED the other way up.
  const SAME_DAY: ChainLine[] = [
    { row: 2, postedOn: "2026-09-11", cents: -10000, balanceAfterCents: 200000 },
    { row: 3, postedOn: "2026-09-12", cents: -5000, balanceAfterCents: 175000 },
    { row: 4, postedOn: "2026-09-12", cents: -20000, balanceAfterCents: 180000 },
    { row: 5, postedOn: "2026-09-15", cents: 30000, balanceAfterCents: 205000 },
  ];

  it("no break, and the report says one day was settled as a day", () => {
    const c = balanceChain(SAME_DAY);
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.sameDay).toBe(1);
    expect(chainSaid(c)).toContain("settled as a day");
  });

  it("but a line MISSING out of that same day is still caught, because the day's net is wrong", () => {
    const c = balanceChain(SAME_DAY.filter((l) => l.row !== 4));
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ day: "2026-09-12", offByCents: 20000 });
  });

  /**
   * THE CORNER THAT HAS TO SAY NOTHING. A file that OPENS on a multi-line day printed out of posting
   * order has no balance before that day to hold its net against, and which of the day's printed
   * balances is its close is exactly what is unknown. So that day goes unchecked and the walk starts
   * again at the next one — rather than reporting a figure worked out from a missing one, which is the
   * "something wrong" this check exists to say nothing instead of.
   */
  it("A FILE THAT OPENS ON AN OUT-OF-ORDER DAY checks the rest and SAYS it claims nothing about that day", () => {
    const opens = SAME_DAY.slice(1); // the Sep 12 pair first, then Sep 15
    const c = balanceChain(opens);
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.lines).toBe(3);
    // Only the Sep 12 → Sep 15 link could be walked, from the close Sep 12's own two figures work out
    // between them — and the coverage figure says so rather than implying the whole file was proved.
    expect(c.links).toBe(1);
    // AND IT IS THE FORWARD READING, not the reversed one landing on Sep 15's balance by coincidence.
    // This test used to pass either way round: 2x+y+z = 0 for (-50.00, -200.00, +300.00), so the walk
    // backwards reached 205000 from 180000 with zero links and the verdict said "1 link" regardless.
    expect(c.reversed).toBe(false);
    // THE DAY IS COUNTED AND NAMED. It used to be dropped in silence under "proves every line", so a
    // wrong amount, a duplicate or a flipped sign on it was missed every single time.
    expect(c.unwalked).toBe(2);
    expect(c.unwalkedDay).toBe("2026-09-12");
    const said = chainSaid(c);
    expect(said).toContain("1 link across 3 lines");
    expect(said).not.toContain("proves every line");
    expect(said).toContain("could not check Sep 12's 2 lines");
  });

  /**
   * AND THE DAY'S OWN FIGURES SAY WHEN IT IS BROKEN, whatever order its lines are printed in. Whichever
   * line posted FIRST opens the day at its own printed balance less its own money, and the day closes at
   * that open plus the day's net; a close the day never printed means that line did not post first. When
   * NO line can have posted first, no order explains the column and the day is wrong — which is how an
   * error on a file's opening day is caught instead of quietly going unchecked.
   */
  it("A WRONG AMOUNT ON THE OPENING MULTI-LINE DAY is caught, not passed as 'proves every line'", () => {
    // A correct month that opens on a two-line day, with the rent misread as $1,500.00 and the balance
    // column left exactly as the bank printed it.
    const month: ChainLine[] = [
      { row: 2, postedOn: "2026-09-01", cents: 250000, balanceAfterCents: 350000 },
      { row: 3, postedOn: "2026-09-01", cents: -150000, balanceAfterCents: 230000 },
      { row: 4, postedOn: "2026-09-02", cents: -6000, balanceAfterCents: 224000 },
      { row: 5, postedOn: "2026-09-03", cents: -8500, balanceAfterCents: 215500 },
      { row: 6, postedOn: "2026-09-04", cents: -12000, balanceAfterCents: 203500 },
      { row: 7, postedOn: "2026-09-05", cents: -4500, balanceAfterCents: 199000 },
    ];
    const c = balanceChain(month);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 3, day: "2026-09-01", offByCents: 30000 });
    expect(chainSaid(c)).toContain("$300.00");
    // And the same month read right still proves every line it can.
    const right = month.map((l) => (l.row === 3 ? { ...l, cents: -120000 } : l));
    const ok = balanceChain(right);
    expect(ok.breaks).toEqual([]);
    expect(ok.links).toBe(5);
    expect(chainSaid(ok)).toContain("proves every line");
  });

  it("A LINE IN TWICE INSIDE THE OPENING DAY is caught, by the line's own amount", () => {
    // Four lines on one opening day, the $10.00 card purchase read twice. The day's net is then wrong by
    // $10.00 against its own printed column, and no order of its lines can make it right.
    const dupe: ChainLine[] = [
      { row: 2, postedOn: "2026-09-01", cents: -4000, balanceAfterCents: 96000 },
      { row: 3, postedOn: "2026-09-01", cents: -1000, balanceAfterCents: 95000 },
      { row: 4, postedOn: "2026-09-01", cents: -1000, balanceAfterCents: 95000 },
      { row: 5, postedOn: "2026-09-01", cents: 2500, balanceAfterCents: 97500 },
      { row: 6, postedOn: "2026-09-03", cents: -10000, balanceAfterCents: 87500 },
      { row: 7, postedOn: "2026-09-05", cents: 30000, balanceAfterCents: 117500 },
    ];
    const c = balanceChain(dupe);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 4, offByCents: 1000 });
    expect(verifyStatement({ lines: dupe, source: "picture" }).pass).toBe(false);
  });

  it("A MONTH ALL ON ONE DAY with ONE amount wrong names the line, instead of saying there was no walk", () => {
    // Forty lines, every one of them dated the same day and carrying a balance, and one amount $5.00 out.
    // The whole day used to go unchecked, and the report then said "no two lines next to each other both
    // carry a running balance" — which is plainly false of a file where all forty do.
    const lines: ChainLine[] = [];
    let bal = 500000;
    for (let i = 0; i < 40; i++) {
      bal -= 1000;
      lines.push({ row: 2 + i, postedOn: "2026-09-04", cents: -1000, balanceAfterCents: bal });
    }
    const off = lines.map((l) => (l.row === 12 ? { ...l, cents: -1500 } : l));
    const c = balanceChain(off);
    expect(c.ran).toBe(true);
    expect(c.links).toBe(39);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 12, offByCents: 500 });
    const said = chainSaid(c);
    expect(said).toContain("line 12 (Sep 4)");
    expect(said).not.toContain("no two lines next to each other");
    // And the correct forty still walk every link they have.
    expect(balanceChain(lines).links).toBe(39);
  });

  /**
   * A LINE THE BANK HAS NOT POSTED SITTING ON AN OUT-OF-ORDER DAY. The day's net has to leave that line
   * out, exactly as the strict walk does — a bank leaves an unposted line out of its own balance column,
   * so counting its money against the column breaks a correct file. And the walk cannot carry a close out
   * of such a day either, because whether the day's last printed balance IS its close (the bank left the
   * line out) or is short by that line's money (the cell simply didn't read) is not on the paper.
   */
  it("A BLANK BALANCE ON AN OUT-OF-ORDER DAY raises no alarm, at the day or the one after it", () => {
    const unposted: ChainLine[] = [
      { row: 2, postedOn: "2026-09-11", cents: -10000, balanceAfterCents: 200000 },
      { row: 3, postedOn: "2026-09-12", cents: -5000, balanceAfterCents: 175000 },
      { row: 4, postedOn: "2026-09-12", cents: -20000, balanceAfterCents: 180000 },
      { row: 5, postedOn: "2026-09-12", cents: -3000, balanceAfterCents: null },
      { row: 6, postedOn: "2026-09-15", cents: 30000, balanceAfterCents: 205000 },
    ];
    const c = balanceChain(unposted);
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.sameDay).toBe(1);
    expect(c.reversed).toBe(false);
    expect(chainSaid(c)).not.toContain("stops adding up");
  });
});

/**
 * A CORRECT FILE IS NEVER REPORTED BROKEN, AND THAT IS THE WHOLE BAR (2026-10-02): "a check that cries
 * wolf is worse than no check at all", and on the scanned lane a cried wolf is a REFUSAL that dropping the
 * paper again cannot fix.
 *
 * THE FOUR WAYS A BANK MAY LAY OUT A CORRECT LEDGER. Days oldest-first or newest-first, and the lines
 * inside a multi-line day printed in posting order or against it — the last of which is what a stable
 * date-descending sort of a chronological ledger does to every multi-line day at once. Nothing in these
 * files is wrong; every one of them has to pass.
 *
 * THIS IS THE TEST THE OLD RANKING FAILED. It picked the shape with the MOST agreed links, and a day
 * settled as a day counted as ONE link however many lines it settled — so the wrong direction, walking
 * that day line by line, outscored the right direction's break-free reading and the file was reported
 * broken. Short files are the ones it bit: a long month's single-line days always gave the right reading
 * somewhere to get started.
 */
describe("a sweep of correct ledgers, in every layout: not one false alarm", () => {
  /** A fixed-seed generator, so a failure here is the same failure tomorrow. */
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  /** One correct ledger: a real opening balance, real days, and a balance column walked by arithmetic. */
  const ledger = (next: () => number, days: number) => {
    const out: { postedOn: string; cents: number; balanceAfterCents: number }[] = [];
    let bal = 100000 + Math.floor(next() * 900000);
    for (let d = 0; d < days; d++) {
      const day = `2026-09-${String(d + 1).padStart(2, "0")}`;
      const perDay = 1 + Math.floor(next() * 3);
      for (let i = 0; i < perDay; i++) {
        const cents = (next() < 0.3 ? 1 : -1) * (100 + Math.floor(next() * 400000));
        bal += cents;
        out.push({ postedOn: day, cents, balanceAfterCents: bal });
      }
    }
    return out;
  };

  /** The same correct ledger laid out as a bank might print it, and numbered as a file's own rows. */
  const laidOut = (rows: ReturnType<typeof ledger>, newestFirst: boolean, linesAgainstOrder: boolean): ChainLine[] => {
    const byDay = new Map<string, typeof rows>();
    for (const r of rows) {
      const got = byDay.get(r.postedOn);
      if (got) got.push(r);
      else byDay.set(r.postedOn, [r]);
    }
    const days = [...byDay.keys()];
    if (newestFirst) days.reverse();
    const laid = days.flatMap((d) => {
      const block = byDay.get(d)!;
      return linesAgainstOrder ? [...block].reverse() : block;
    });
    return laid.map((r, i) => ({ row: i + 2, postedOn: r.postedOn, cents: r.cents, balanceAfterCents: r.balanceAfterCents }));
  };

  for (const newestFirst of [false, true]) {
    for (const linesAgainstOrder of [false, true]) {
      const how = `${newestFirst ? "newest-first days" : "oldest-first days"}, lines ${linesAgainstOrder ? "against" : "in"} posting order`;
      it(`${how}: every file passes, and none is called broken`, () => {
        const next = rng(newestFirst ? (linesAgainstOrder ? 97 : 31) : linesAgainstOrder ? 5 : 11);
        const cried: string[] = [];
        for (let n = 0; n < 400; n++) {
          const lines = laidOut(ledger(next, 3 + Math.floor(next() * 10)), newestFirst, linesAgainstOrder);
          const v = verifyStatement({ lines, source: "rows" });
          if (!v.pass) cried.push(`${n}: ${verifySaid(v)}`);
          // AND NEVER THE WRONG WAY ROUND EITHER, because the sentence a person reads says which way the
          // file is listed and a wrong answer there is a wrong explanation of a correct file.
          if (v.chain.ran && v.chain.reversed !== newestFirst) cried.push(`${n}: called ${v.chain.reversed ? "newest" : "oldest"} first`);
          if (v.chain.card) cried.push(`${n}: called a card`);
        }
        expect(cried.slice(0, 3)).toEqual([]);
      });
    }
  }
});

/**
 * TWO ACCOUNTS IN ONE FILE ARE TWO CHAINS. The bank reader keeps every line of a file that mixes a card
 * and a checking account, and says so in as many words — but the chain was handed the lot as one sequence,
 * so two accounts each printing their own CORRECT running balance came out as a missing line at the seam.
 * On a scanned combined statement that was a REFUSAL of a perfect read, and "Drop it again" bought another
 * model read and the same refusal, which is a dead end wearing a sentence.
 */
describe("a file that holds more than one running balance", () => {
  const MIXED = `Account,Date,Description,Amount,Balance
1111,09/02/2026,DEPOSIT INVOICE PAYMENT,500.00,1500.00
1111,09/03/2026,CHECK 1042,-200.00,1300.00
1111,09/04/2026,ACH HARROWGATE ELECTRIC,-100.00,1200.00
2222,09/02/2026,DEPOSIT INVOICE PAYMENT,50.00,5050.00
2222,09/03/2026,MONTHLY SERVICE CHARGE,-10.00,5040.00
2222,09/05/2026,ATM WITHDRAWAL,-40.00,5000.00
`;

  it("TWO ACCOUNTS ONE AFTER THE OTHER: the join is not a missing line", () => {
    const dl = readBankTable(parseCSV(MIXED), "Both.csv", hash)!;
    expect(dl.verified?.pass).toBe(true);
    expect(dl.verified?.chain.breaks).toEqual([]);
    // Each account's own first line only seeds its own walk, so four links across six lines is every one.
    expect(dl.verified?.chain.links).toBe(4);
    expect(dl.verified?.chain.runs).toBe(2);
    const said = dl.readSaid ?? "";
    expect(said).not.toContain("stops adding up");
    // AND IT IS SAID, never quietly forgiven: a statement that holds two balances is a thing to be told.
    expect(said).toContain("2 separate running balances");
  });

  it("TWO ACCOUNTS INTERLEAVED BY DATE are walked one account at a time, by the file's own column", () => {
    const rows = parseCSV(MIXED);
    const interleaved = [rows[0], rows[1], rows[4], rows[2], rows[5], rows[3], rows[6]];
    const dl = readBankTable(interleaved, "Both.csv", hash)!;
    expect(dl.verified?.pass).toBe(true);
    expect(dl.verified?.chain.ran).toBe(true);
    expect(dl.verified?.chain.links).toBe(4);
    expect(dl.verified?.chain.byAccount).toBe(true);
    // It used to say the column isn't a running balance at all, of a file whose every line carries one.
    expect(dl.readSaid).not.toContain("isn't a running account balance");
    expect(dl.readSaid).not.toContain("no two lines next to each other");
  });

  it("A COMBINED STATEMENT with no account per line: its own days say where the second balance starts", () => {
    // What a scanned combined statement looks like once it is rows: the checking section, then the savings
    // section, each with its own running balance, and one account number stamped on every line.
    const combined: ChainLine[] = [
      { row: 2, postedOn: "2026-09-01", cents: 50000, balanceAfterCents: 150000 },
      { row: 3, postedOn: "2026-09-02", cents: -20000, balanceAfterCents: 130000 },
      { row: 4, postedOn: "2026-09-03", cents: -10000, balanceAfterCents: 120000 },
      { row: 5, postedOn: "2026-09-01", cents: 250, balanceAfterCents: 850250 },
      { row: 6, postedOn: "2026-09-02", cents: -100000, balanceAfterCents: 750250 },
    ];
    const v = verifyStatement({ lines: combined, source: "picture" });
    expect(v.pass).toBe(true);
    expect(v.chain.breaks).toEqual([]);
    expect(v.chain.runs).toBe(2);
    expect(v.chain.links).toBe(3);
  });

  it("but a line MISSING out of one account is still caught, because the days never go backwards there", () => {
    const short = parseCSV(MIXED).filter((r) => !r.join(" ").includes("CHECK 1042"));
    const dl = readBankTable(short, "Both.csv", hash)!;
    expect(dl.verified?.pass).toBe(false);
    expect(dl.readSaid).toContain("$200.00");
  });
});

/**
 * A SHAPE THE FILE'S OWN DAYS RULE OUT IS NOT TRIED AT ALL. The reading {newest-first, a card's balance}
 * walks bal(j+1) = bal(j) + money(j) in file order — which is ALGEBRAICALLY the same relation as a whole
 * amount column slipped one row up (a classic table-extraction failure), and as a balance printed BEFORE
 * its line. So a file with that fault walked perfectly in that one shape and was passed as clean, with a
 * sentence explaining it as a card listed newest first, on a checking account whose dates ascend.
 */
describe("the direction the dates rule out", () => {
  it("A WHOLE AMOUNT COLUMN SLIPPED ONE ROW is not explained away as a card listed newest first", () => {
    const rows = parseCSV(WALKS_CSV);
    // Every line keeps its own date, description and printed balance, and takes the NEXT line's amount.
    const slipped = rows.map((r, i) => (i === 0 || i === rows.length - 1 ? r : [r[0], r[1], rows[i + 1]?.[2] ?? r[2], r[3]]));
    const dl = readBankTable(slipped, "Checking.csv", hash)!;
    expect(dl.verified?.pass).toBe(false);
    expect(dl.readSaid).not.toContain("proves every line");
    expect(dl.readSaid).not.toContain("newest first");
    expect(dl.readSaid).not.toContain("what you owe");
  });

  it("and a file all on ONE day rules nothing out, so it is still walked both ways round", () => {
    // The dates can never decide the order on their own, which is why the walk is tried both ways. A file
    // with one day in it says nothing about its order, and must keep both readings.
    const oneDayCard: ChainLine[] = [
      { row: 2, postedOn: "2026-09-04", cents: -6210, balanceAfterCents: 46210 },
      { row: 3, postedOn: "2026-09-04", cents: -14500, balanceAfterCents: 60710 },
      { row: 4, postedOn: "2026-09-04", cents: 50000, balanceAfterCents: 10710 },
    ];
    const c = balanceChain(oneDayCard);
    expect(c.ran).toBe(true);
    expect(c.card).toBe(true);
    expect(c.breaks).toEqual([]);
  });
});

/**
 * ONE FACT MUST NOT HAVE TWO RULES WITH OPPOSITE POLICIES. `checkScanTotals` refuses to read a balance the
 * other way round unless the paper's own two totals already pinned every line's side, and says why: with
 * no printed totals, accepting either direction would launder a read with its signs inverted. The chain was
 * accepting the other direction on its own — so a scanned DEPOSIT statement whose every column had been
 * swapped came back "proves every line … its balance is what you owe", and Apply would have counted every
 * deposit as a cost. On main the same read said NOTHING here checked it.
 */
describe("which way the balance runs is the paper's to say, not the chain's to choose", () => {
  const INVERTED = MONTH.map((l) => ({ ...l, cents: -l.cents }));
  const blank = (over: Partial<ScanControls> = {}): ScanControls => ({ beginning: null, ending: null, deposits: null, withdrawals: null, account: null, ...over });

  it("a DEPOSIT statement read with every column swapped is not waved through as a card", () => {
    const v = verifyStatement({ lines: INVERTED, source: "picture", controls: blank({ account: "deposit" }) });
    expect(v.chain.card).toBe(false);
    expect(v.chain.ran).toBe(false);
    const said = verifySaid(v);
    // NOT ONE WORD OF ASSURANCE: on the branch this fixes, the card said "proves every line … its balance is
    // what you owe" over a read whose every column had come off the paper the wrong way round, and Apply
    // would have counted every deposit as a cost.
    expect(said).not.toContain("proves every line");
    expect(said).not.toContain("add up to the cent");
    expect(said).toContain("NOTHING here checked it");
    // AND IT NAMES THE ONE THING TO GO AND CHECK, which is the thing that actually happened.
    expect(said).toContain("only adds up read as a card");
    expect(said).toContain("didn't come off the paper the wrong way round");
  });

  it("and a paper that names no kind at all is read as a deposit account, exactly as the totals are", () => {
    expect(verifyStatement({ lines: INVERTED, source: "picture", controls: blank() }).chain.card).toBe(false);
  });

  it("a CARD statement the paper calls a card still walks the way a card works", () => {
    const CARD: ChainLine[] = [
      { row: 2, postedOn: "2026-09-03", cents: -6210, balanceAfterCents: 46210 },
      { row: 3, postedOn: "2026-09-09", cents: -14500, balanceAfterCents: 60710 },
      { row: 4, postedOn: "2026-09-18", cents: 50000, balanceAfterCents: 10710 },
    ];
    const v = verifyStatement({ lines: CARD, source: "picture", controls: blank({ account: "card" }) });
    expect(v.chain.card).toBe(true);
    expect(v.chain.breaks).toEqual([]);
  });

  it("and the other direction IS allowed once the paper's own two totals pinned every line", () => {
    // Both printed totals agree with the lines as read, so every line's side is pinned by the statement's
    // own labels and the only thing the other direction can mean is a kind the reader named wrongly.
    const pinned: ScanControls = { beginning: null, ending: null, deposits: 221641, withdrawals: 343742, account: "deposit" };
    const v = verifyStatement({ lines: INVERTED, source: "picture", controls: pinned });
    expect(v.totals?.pinned).toBe(2);
    expect(v.chain.card).toBe(true);
    expect(v.chain.breaks).toEqual([]);
  });

  // A DOWNLOAD CAME WITH NO PAPER, so nothing named a kind and nothing may be ruled out: a card's CSV
  // names its kind nowhere, and this is the one door where both senses have to stay on the table.
  it("a file off the bank constrains nothing, because no paper came with it", () => {
    expect(verifyStatement({ lines: INVERTED, source: "rows" }).chain.card).toBe(true);
  });

  /**
   * AND REFUSING TO VOUCH FOR THE OTHER DIRECTION MUST NOT BECOME A CRIED WOLF. A card statement the reader
   * labelled a deposit account is a kind named wrongly, not a line missing — and on this lane a break is a
   * REFUSAL that dropping the paper again cannot fix, so it says what to go and check instead.
   */
  it("a paper whose kind was named wrongly is told so, and never accused of a missing line", () => {
    // A card month, correct to the cent, that the reader labelled a deposit account. Its Sep 4 charge and
    // same-day refund net to nothing, so the deposit direction settles that day and then breaks twice —
    // which is exactly the shape that would cry wolf on a paper with nothing wrong on it.
    const card: ChainLine[] = [
      { row: 2, postedOn: "2026-09-03", cents: -6210, balanceAfterCents: 46210 },
      { row: 3, postedOn: "2026-09-04", cents: 5000, balanceAfterCents: 41210 },
      { row: 4, postedOn: "2026-09-04", cents: -5000, balanceAfterCents: 46210 },
      { row: 5, postedOn: "2026-09-09", cents: -14500, balanceAfterCents: 60710 },
      { row: 6, postedOn: "2026-09-18", cents: 50000, balanceAfterCents: 10710 },
    ];
    const v = verifyStatement({ lines: card, source: "picture", controls: blank({ account: "deposit" }) });
    expect(v.pass).toBe(true);
    expect(v.chain.ran).toBe(false);
    expect(v.chain.breaks).toEqual([]);
    const said = verifySaid(v);
    expect(said).not.toContain("stops adding up");
    expect(said).toContain("only adds up read as a card");
    expect(said).toContain("the wrong way round");
  });

  it("but a genuine break in the direction the paper named is still named", () => {
    // A deposit month with its Sep 5 check missing. The card direction explains nothing, so there is no
    // other reading to prefer and the break is the truth.
    const v = verifyStatement({ lines: MONTH.filter((l) => l.cents !== -125000), source: "picture", controls: blank({ account: "deposit" }) });
    expect(v.pass).toBe(false);
    expect(verifySaid(v)).toContain("stops adding up at line 4 (Sep 8), by $1,250.00");
  });
});

describe("nothing to check against is said out loud, never claimed either way", () => {
  it("NO BALANCE COLUMN AT ALL: it could not run, and nothing says it did", () => {
    const none = MONTH.map((l) => ({ ...l, balanceAfterCents: null }));
    const c = balanceChain(none);
    expect(c.ran).toBe(false);
    expect(c.links).toBe(0);
    expect(c.why).toContain("prints no running balance");
    const said = chainSaid(c);
    expect(said).toContain("prints no running balance beside its lines");
    expect(said).not.toContain("proves every line");
    const v = verifyStatement({ lines: none, source: "rows" });
    expect(v.pass).toBe(true); // a check that could not run never fails a read
    expect(verifySaid(v)).toContain("the file's own rows");
  });

  it("A PARTIAL COLUMN checks the links it can and says how many out of how many lines", () => {
    // Two lines carry no balance (a pending line, a line the bank left out of its column). The walk
    // stops at each of them and starts again at the next line that has one.
    const partial = MONTH.map((l) => (l.row === 4 || l.row === 7 ? { ...l, balanceAfterCents: null } : l));
    const c = balanceChain(partial);
    expect(c.ran).toBe(true);
    expect(c.withBalance).toBe(4);
    expect(c.links).toBe(2);
    expect(c.lines).toBe(6);
    expect(c.breaks).toEqual([]);
    expect(chainSaid(c)).toContain("2 links across 6 lines");
  });

  it("ONE LINE WITH A BALANCE is no chain at all", () => {
    const one = MONTH.map((l, i) => (i === 0 ? l : { ...l, balanceAfterCents: null }));
    expect(balanceChain(one).why).toContain("only one of its lines carries a running balance");
  });

  it("A 'Balance' COLUMN THAT ISN'T A RUNNING BALANCE says nothing rather than something wrong", () => {
    // What a supplier's own open list prints beside its papers: each row's own balance, not the
    // account's. Nothing walks, so the chain keeps quiet instead of reporting five breaks.
    const openItems: ChainLine[] = [
      { row: 2, postedOn: "2026-08-14", cents: -41055, balanceAfterCents: 41055 },
      { row: 3, postedOn: "2026-08-29", cents: -12200, balanceAfterCents: 12200 },
      { row: 4, postedOn: "2026-09-08", cents: -90410, balanceAfterCents: 90410 },
      { row: 5, postedOn: "2026-09-19", cents: -7733, balanceAfterCents: 7733 },
    ];
    const c = balanceChain(openItems);
    expect(c.ran).toBe(false);
    expect(c.why).toContain("isn't a running account balance");
    expect(chainSaid(c)).not.toContain("stops adding up");
  });
});

/**
 * THE THREE OUTCOMES, AND THE CLAUSE THAT SAYS HOW HARD TO LOOK (Erik, on the tiers of reliability).
 * It is one short clause, after the fact, with nothing to decide — never a menu.
 */
describe("the one read report", () => {
  it("checked and agrees", () => {
    const said = verifySaid(verifyStatement({ lines: MONTH, source: "rows", controls: CONTROLS }));
    expect(said).toContain("agree to the cent");
    expect(said).toContain("proves every line");
    expect(said).toContain("Read from the file's own rows.");
  });

  it("checked and names where it broke", () => {
    const v = verifyStatement({ lines: MONTH.filter((l) => l.cents !== -125000), source: "page" });
    expect(verifySaid(v)).toContain("stops adding up at line 4 (Sep 8), by $1,250.00");
    expect(verifySaid(v)).toContain("Read off the page itself.");
  });

  it("nothing to check it against, said out loud, with one next action", () => {
    const blind = MONTH.map((l) => ({ ...l, balanceAfterCents: null }));
    const nothing: ScanControls = { beginning: null, ending: null, deposits: null, withdrawals: null, account: null };
    const said = verifySaid(verifyStatement({ lines: blind, source: "picture", controls: nothing }));
    // cn-v1050's own sentence, word for word, because it still applies here.
    expect(said).toContain("prints no totals to hold the read against");
    expect(said).toContain("NOTHING here checked it");
    expect(said).toContain("Read from a picture of the page.");
  });

  it("a paper with no totals whose CHAIN held is never told that nothing checked it", () => {
    const nothing: ScanControls = { beginning: null, ending: null, deposits: null, withdrawals: null, account: null };
    const said = verifySaid(verifyStatement({ lines: MONTH, source: "picture", controls: nothing }));
    expect(said).toContain("prints no totals to hold the read against");
    expect(said).not.toContain("NOTHING here checked it");
    expect(said).toContain("proves every line");
  });

  /**
   * "NOTHING AGREED" IS NOT "NOTHING WAS PRINTED". A check that RAN AND FAILED also leaves `agreed` empty.
   * cn-v1050 never met that case, because a scan whose figures disagreed was refused before this sentence
   * was ever built — but a person's Swap re-verifies a stored scan against its own kept control figures, so
   * a card could lead with "This statement prints no totals to hold the read against" and then quote the
   * three totals the statement prints. That is the one claim this module's header promises never to make.
   */
  it("a paper whose printed totals all FAILED is never told it prints no totals", () => {
    const inverted = MONTH.map((l) => ({ ...l, cents: -l.cents }));
    const v = verifyStatement({ lines: inverted, source: "picture", controls: CONTROLS });
    expect(v.pass).toBe(false);
    expect(v.totals?.agreed).toEqual([]);
    expect(v.totals?.failed.map((f) => f.which)).toEqual(["withdrawals", "deposits", "balance"]);
    const said = verifySaid(v);
    expect(said).not.toContain("prints no totals");
    expect(said).not.toContain("NOTHING here checked it");
    expect(said).toContain("does not stand up");
    expect(said).toContain("The money going out doesn't add up");
    // AND NOT ONE WORD OF REASSURANCE OVER IT: the chain cannot tell a read with every sign turned over
    // from a correct one, which is what the four shapes ARE, so it may not clear the printed figures.
    expect(said).not.toContain("proves every line");
  });

  it("and a chain that DOES walk under a failed total says that it clears nothing", () => {
    // The lines and the balance column are right; the paper's printed withdrawals total is not what they
    // come to. The chain walks every link — and must not read as though that settled the disagreement.
    const v = verifyStatement({ lines: MONTH, source: "picture", controls: { ...CONTROLS, withdrawals: 200000 } });
    expect(v.pass).toBe(false);
    expect(v.chain.breaks).toEqual([]);
    const said = verifySaid(v);
    expect(said).toContain("proves every line");
    expect(said).toContain("does not clear the figures above");
  });

  /**
   * TWO OPPOSITE INSTRUCTIONS IN ONE REPORT. A scan whose two totals agree but which prints no beginning or
   * ending balance was told to "go down those lines against the paper" and then, in the next sentence, that
   * its own running balance proves every line. What the walk cannot see is said ONCE, with the one action
   * that answers it.
   */
  it("a report never tells a person to redo the walk that just ran", () => {
    const ends: ScanControls = { beginning: null, ending: null, deposits: 343742, withdrawals: 221641, account: "deposit" };
    const said = verifySaid(verifyStatement({ lines: MONTH, source: "picture", controls: ends }));
    expect(said).toContain("It could not check the balance from end to end");
    expect(said).not.toContain("go down those lines against the paper");
    expect(said).toContain("proves every line");
    // AND THE ONE THING THE WALK CANNOT SEE IS NAMED, with the figure on his own paper to close it.
    expect(said).toContain("lost off the top or the bottom");
  });

  /**
   * THE TEXT-PDF DOOR HAS NO PRINTED CONTROLS AT ALL, so the person's own five-second comparison is the
   * whole of the proof at both ends of the table — a link needs a NEIGHBOURING balance, so a transaction
   * lost off the top or the bottom leaves every remaining link adding up to the cent. pdfReadSaid used to
   * ask for that comparison; the moment every download started carrying a read report, the report BECAME
   * pdfReadSaid's `checked` and silently replaced the instruction, on the one door that had nothing else.
   */
  it("a text PDF keeps its hold-against-the-totals instruction, chain or no chain", () => {
    const said = verifySaid(verifyStatement({ lines: MONTH, source: "page" }));
    expect(said).toContain("proves every line");
    expect(said).toContain("lost off the top or the bottom of the table");
    expect(said).toContain("hold the figures above against the totals your statement prints before you Apply");
    expect(said).toContain("Read off the page itself.");
  });

  it("and a scan whose paper DID print both ends is not told to go and find them again", () => {
    const said = verifySaid(verifyStatement({ lines: MONTH, source: "picture", controls: CONTROLS }));
    expect(said).toContain("agree to the cent");
    expect(said).not.toContain("lost off the top or the bottom");
  });

  /**
   * A FILE OFF THE BANK HAS NO PAPER TO HOLD IT AGAINST — its rows ARE the bank's, which is the whole reason
   * that door warns instead of refusing. "Hold the figures above against your account" pointed at nothing:
   * on a CSV the drop line carries a count of lines and the card's headline carries dates and counts, with
   * the first dollar figure BELOW the sentence. It points at the lines, which are on the card.
   */
  it("a file's own rows are sent to the account, not to a paper nobody has", () => {
    const blind = MONTH.map((l) => ({ ...l, balanceAfterCents: null }));
    const said = verifySaid(verifyStatement({ lines: blind, source: "rows" }));
    expect(said).toContain("Go down these lines against your account before you Apply.");
    expect(said).not.toContain("the figures above");
    const broke = verifySaid(verifyStatement({ lines: MONTH.filter((l) => l.cents !== -125000), source: "rows" }));
    expect(broke).toContain("Go and look at that line in the file against your account before you Apply.");
    expect(broke).not.toContain("against the paper");
  });

  /**
   * "ONE MORE LINK FURTHER DOWN" POINTED THE WRONG WAY. Breaks are collected in WALK order, which on a
   * newest-first file runs from the bottom of the page upward — so the sentence named the bottom-most break
   * and then said the others were "further down", when they are higher up the page.
   */
  it("a second break on a newest-first file is never said to be further down", () => {
    // Eight single-line days, newest first, each one $10.00 out, with $1.00 added to two of the amounts.
    const lines: ChainLine[] = Array.from({ length: 8 }, (_, i) => ({
      row: 2 + i,
      postedOn: `2026-09-${String(9 - i).padStart(2, "0")}`,
      cents: -1000,
      balanceAfterCents: 92000 + i * 1000,
    })).map((l) => (l.row === 3 || l.row === 8 ? { ...l, cents: -1100 } : l));
    const c = balanceChain(lines);
    expect(c.reversed).toBe(true);
    // The walk runs up the page, so the FIRST break it meets is the lowest line of the two.
    expect(c.breaks.map((b) => b.row)).toEqual([8, 3]);
    const said = chainSaid(c);
    expect(said).toContain("line 8 (Sep 3)");
    expect(said).toContain("One more link");
    expect(said).not.toContain("further down");
  });
});

// ── EVERY DOOR, AND THE TEETH THAT KEEP IT THAT WAY ────────────────────────────────────────────

/** A bank's CSV with a running balance down the side, oldest first. Opening balance $4,000.00. */
const WALKS_CSV = `Date,Description,Amount,Balance
09/02/2026,CARD PURCHASE HARROWGATE FUEL,-142.08,3857.92
09/05/2026,CHECK 1042,-1250.00,2607.92
09/08/2026,DEPOSIT,3400.00,6007.92
09/12/2026,ACH WESTMERE CARD SERVICES,-812.33,5195.59
09/19/2026,REFUND WESTMERE HARDWARE,37.42,5233.01
09/30/2026,MONTHLY SERVICE CHARGE,-12.00,5221.01
`;

describe("the reader carries the balance, and verifies what it read before it hands it back", () => {
  it("a CSV's running balance lands on every line, in cents", () => {
    const dl = readBankTable(parseCSV(WALKS_CSV), "Checking.csv", hash)!;
    expect(dl.lines.map((l) => l.balanceAfterCents)).toEqual([385792, 260792, 600792, 519559, 523301, 522101]);
    expect(dl.verified?.chain.ran).toBe(true);
    expect(dl.verified?.chain.breaks).toEqual([]);
    expect(dl.readSaid).toContain("proves every line");
    expect(dl.readSaid).toContain("Read from the file's own rows.");
  });

  it("A BREAK ON A STRUCTURED FILE WARNS, it does not refuse: the rows are still the bank's own", () => {
    const missing = WALKS_CSV.split("\n").filter((l) => !l.includes("CHECK 1042")).join("\n");
    const dl = readBankTable(parseCSV(missing), "Checking.csv", hash)!;
    // The download exists, with all of its lines on it — the card is where a person confirms them.
    expect(dl.lines).toHaveLength(5);
    expect(dl.verified?.pass).toBe(false);
    // Line 3 of THIS file: the row number is where it is in the file in front of him, not where it
    // would have been had the missing line been there.
    expect(dl.readSaid).toContain("stops adding up at line 3 (Sep 8), by $1,250.00");
  });

  it("no balance column: the download still lands and the report says nothing walked it", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/02/2026,HARROWGATE FUEL,-142.08\n09/05/2026,CHECK 1042,-1250.00\n`), "x.csv", hash)!;
    expect(dl.lines.every((l) => l.balanceAfterCents === null)).toBe(true);
    expect(dl.verified?.chain.ran).toBe(false);
    expect(dl.readSaid).toContain("prints no running balance");
  });

  it("AN OFX CARRIES NO PER-LINE BALANCE, and the report says so rather than implying a check", () => {
    // OFX's own shape: a <STMTTRN> has a date, an amount, a payee and an id, and no balance at all.
    // (A <LEDGERBAL> is the account's closing figure, not one per line.)
    const ofx = readOfx(
      `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>XXXXX4417</BANKACCTFROM><BANKTRANLIST>` +
        `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902120000<TRNAMT>-142.08<FITID>T1<NAME>HARROWGATE FUEL</STMTTRN>` +
        `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260908120000<TRNAMT>3400.00<FITID>T2<NAME>DEPOSIT</STMTTRN>` +
        `</BANKTRANLIST><LEDGERBAL><BALAMT>5221.01</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
      "Checking.qfx",
    );
    expect(ofx.ok).toBe(true);
    expect(ofx.ok && ofx.rows[0]).not.toContain("Balance");
    const dl = readBankTable((ofx as { rows: string[][] }).rows, "Checking.qfx", hash)!;
    expect(dl.lines).toHaveLength(2);
    expect(dl.lines.every((l) => l.balanceAfterCents === null)).toBe(true);
    expect(dl.readSaid).toContain("prints no running balance beside its lines");
    expect(dl.readSaid).toContain("Read from the file's own rows.");
  });

  it("A SUPPLIER'S OPEN LIST WITH A Balance COLUMN NEVER GETS A BANK CHAIN RUN ON IT", () => {
    // Its "Balance" is what is open on each paper, not an account's running balance. It is not a bank
    // table at all (bank-download.ts keeps "balance" out of the words only a bank prints), so it goes
    // to the supplier reader and no chain is ever walked over it.
    const list = `Invoice,Invoice Date,Due Date,Amount,Balance\nINV-4011,08/14/2026,09/13/2026,410.55,410.55\nINV-4066,08/29/2026,09/28/2026,122.00,122.00\nINV-4120,09/08/2026,10/08/2026,904.10,904.10\n`;
    const table = parseCSV(list);
    const at = findHeaderRow(table);
    const hasRef = at >= 0 && readHeaderRow(table[at] ?? []).columns.reference !== undefined;
    expect(hasRef).toBe(true);
    expect(looksLikeBankTable(table, hasRef)).toBe(false);
    expect(readBankTable(table, "Statement.csv", hash)).toBeNull();
    // And it reads as the supplier's list it is.
    const read = readOpenListTable({ table, from: "file", name: "Statement.csv", listDate: "2026-09-26", listDateFrom: "file" });
    expect(read.ok).toBe(true);
  });

  it("a person's Swap re-verifies: the sentence beside Apply always describes the lines under it", async () => {
    const { swapDownloadSigns } = await import("./bank-download");
    const dl = readBankTable(parseCSV(WALKS_CSV), "Checking.csv", hash)!;
    const swapped = swapDownloadSigns(dl, hash);
    // The file didn't change, so its printed balance didn't either — the walk simply comes out as a
    // balance that is what you OWE, and still proves every line.
    expect(swapped.lines.map((l) => l.balanceAfterCents)).toEqual(dl.lines.map((l) => l.balanceAfterCents));
    expect(swapped.verified?.chain.ran).toBe(true);
    expect(swapped.verified?.chain.card).toBe(true);
    expect(swapped.readSaid).toContain("what you owe");
    expect(swapped.readSaid).not.toBe(dl.readSaid);
  });
});

/**
 * THE TEETH. A rule fixed at one door while another keeps the old behaviour is the bug this repo keeps
 * shipping, so these two hold the whole app to it: there is ONE place a bank download becomes a stored
 * card, and every door that reads one SAYS how it read it. A new door that forgets fails here.
 */
describe("the teeth: no door makes a bank download without asking the one verification", () => {
  const sourceFiles = async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(process.cwd(), "src");
    const out: { file: string; text: string }[] = [];
    const walkDir = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walkDir(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push({ file: path.relative(root, full), text: readFileSync(full, "utf8") });
      }
    };
    walkDir(root);
    return out;
  };

  /** The arguments of the call that starts at `open`, split at the commas between them. */
  const argsAt = (text: string, open: number): string[] => {
    let depth = 0;
    const args: string[] = [];
    let start = open + 1;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          args.push(text.slice(start, i));
          break;
        }
      } else if (ch === "," && depth === 1) {
        args.push(text.slice(start, i));
        start = i + 1;
      }
    }
    return args.map((a) => a.trim()).filter(Boolean);
  };

  it("every call that reads a bank download says how the file was read", async () => {
    const files = await sourceFiles();
    // A real sweep, not an empty one that passes for being empty.
    expect(files.length).toBeGreaterThan(300);
    const silent: string[] = [];
    let seen = 0;
    for (const { file, text } of files) {
      for (const m of [...text.matchAll(/\breadBankTable\s*\(/g), ...text.matchAll(/\breadBankDownload\s*\(/g)]) {
        // The declarations themselves are not calls.
        if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
        seen++;
        const args = argsAt(text, m.index + m[0].length - 1);
        const needs = m[0].startsWith("readBankTable") ? 4 : 3;
        if (args.length < needs) silent.push(`${file} → ${m[0]}…) with ${args.length} arguments`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(silent).toEqual([]);
  });

  it("a bank download becomes a stored card in exactly ONE place, and that place asks the verification", async () => {
    const files = await sourceFiles();
    const makers = files.filter(({ text }) => /\bcreateBankPaper\s*\(/.test(text) && !/export async function createBankPaper/.test(text)).map((f) => f.file);
    expect(makers).toEqual(["app/(app)/bills/open-list-add-core.ts"]);
    const maker = files.find((f) => f.file === makers[0])!.text;
    // It gets its download from the one reader, which verifies before it hands anything back, and it
    // composes no sentence of its own: `readSaid` is read off the download, never written onto it.
    expect(maker).toMatch(/readBankDownload\(bankTable, name, bankRead\)/);
    expect(maker).toContain("download.readSaid");
    expect(maker).not.toMatch(/readSaid:/);
  });

  it("and the reader always hands back a verdict and a sentence, whatever it was given", async () => {
    const shapes = [
      WALKS_CSV,
      `Date,Description,Amount\n09/02/2026,HARROWGATE FUEL,-142.08\n`,
      `Post Date,Description,Debit,Credit\n09/02/2026,HARROWGATE FUEL,142.08,\n09/08/2026,DEPOSIT,,3400.00\n`,
      `Date,Description,Amount,Type\n09/02/2026,HARROWGATE FUEL,142.08,Debit\n09/08/2026,DEPOSIT,3400.00,Credit\n`,
    ];
    for (const csv of shapes) {
      const dl = readBankTable(parseCSV(csv), "x.csv", hash)!;
      expect(dl.verified).toBeTruthy();
      expect(String(dl.readSaid ?? "").length).toBeGreaterThan(20);
      expect(dl.readSaid).toContain("Read from the file's own rows.");
    }
  });
});
