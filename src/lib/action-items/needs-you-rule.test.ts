import { describe, it, expect } from "vitest";
import {
  DUE_AHEAD_DAYS,
  DUE_KINDS,
  DUE_PASSED_DAYS,
  GROUP_MONEY_KINDS,
  GROUP_ORDER,
  KIND_GROUP,
  NOW_DISCOUNT_DAYS,
  NOW_INVOICE_LATE_DAYS,
  NOW_KINDS,
  NOW_LIEN_DAYS,
  QUOTE_EXPIRY_SOON_DAYS,
  SOON_DISCOUNT_DAYS,
  dueClock,
  isDue,
  isUnreadLine,
  levelOf,
  maxLevel,
  openFirst,
  summarize,
  withoutMoneyForTech,
} from "./needs-you-rule";
import { AFFORDANCES, type ActionItem, type ActionKind, type Group, type Level } from "./types";
import { pileOf } from "./piles";
import { daysAgoStr } from "./leak-detectors";

/**
 * NEEDS YOU'S ONE RULE: the tile each kind sits in and the mark a row carries, the plan's table arm
 * by arm, each window at its edges. Days are the company's: today is passed in, never read from the
 * clock. Since cn-v1162 amber (SOON, said "Due") is a real CLOCK that is close or just went by; age
 * alone marks nothing, so every test below also hands the rule an old `since` and proves it unread.
 */
const TODAY = "2026-10-20";
const TZ = "America/Los_Angeles";
const ctx = { todayStr: TODAY, tz: TZ };
const ago = (n: number) => daysAgoStr(TODAY, n); // n days before today (negative: ahead)
const KINDS = Object.keys(AFFORDANCES) as ActionKind[];
const CLOCK_KINDS: ActionKind[] = ["materials_needed", "inquiry", "quote_awaiting", "invoice_draft", "job_on_hold", "permit_inspection"];

// `since` rides along on purpose: the rule must not read it.
type LevelIn = Pick<ActionItem, "kind" | "id" | "urgency" | "when" | "clock"> & { since?: string | null };
const it0 = (kind: ActionKind, o: Partial<LevelIn> = {}): LevelIn => ({ kind, id: `${kind}-1`, urgency: 1, when: null, clock: null, since: null, ...o });
const lv = (kind: ActionKind, o: Partial<LevelIn> = {}) => levelOf(it0(kind, o), ctx);

describe("the four tiles", () => {
  it("every kind sits in exactly one tile, sized 5 / 5 / 7 / 5", () => {
    expect(Object.keys(KIND_GROUP)).toEqual(Object.keys(AFFORDANCES));
    const size = (g: Group) => KINDS.filter((k) => KIND_GROUP[k] === g).length;
    expect(GROUP_ORDER.map(size)).toEqual([5, 5, 7, 5]);
    expect(KINDS).toHaveLength(22);
  });

  it("the tiles hold what the plan says", () => {
    const of = (g: Group) => KINDS.filter((k) => KIND_GROUP[k] === g).sort();
    expect(of("get_paid")).toEqual(["invoice_draft", "invoice_overdue", "job_unbilled_work", "lien_deadline", "visit_unbilled"]);
    expect(of("win_work")).toEqual(["contract_unsigned", "inquiry", "inspection_writeup", "quote_awaiting", "quote_draft"]);
    expect(of("run_jobs")).toEqual(["appointment", "job_on_hold", "job_to_schedule", "materials_needed", "permit_inspection", "quote_accepted", "time_stray"]);
    expect(of("keep_books")).toEqual(["organize", "receipt_unbilled", "stock_short", "supplier_paper", "supplier_pay"]);
  });

  it("every pile's kinds share one tile: a pile cannot straddle two", () => {
    const byPile = new Map<string, Set<Group>>();
    for (const kind of KINDS) {
      for (const paper of [undefined, "tray", "organize", "bank"] as const) {
        const p = pileOf({ kind, id: "x", paper });
        if (p) byPile.set(p, new Set([...(byPile.get(p) ?? []), KIND_GROUP[kind]]));
      }
    }
    expect(byPile.size).toBeGreaterThan(0);
    for (const [p, groups] of byPile) expect(groups.size, p).toBe(1);
  });

  it("each tile's money kinds sit in that tile, and Operations adds up no money", () => {
    for (const g of GROUP_ORDER) for (const k of GROUP_MONEY_KINDS[g]) expect(KIND_GROUP[k], k).toBe(g);
    expect(GROUP_MONEY_KINDS.run_jobs).toEqual([]);
  });
});

describe("the clock (cn-v1162)", () => {
  it("the thresholds: the passed window, the offer's, the discount's, the lien's and the invoice's", () => {
    expect([DUE_PASSED_DAYS, QUOTE_EXPIRY_SOON_DAYS, NOW_INVOICE_LATE_DAYS, NOW_LIEN_DAYS, NOW_DISCOUNT_DAYS, SOON_DISCOUNT_DAYS]).toEqual([7, 5, 30, 7, 3, 7]);
    expect(DUE_AHEAD_DAYS).toEqual({ quote_awaiting: QUOTE_EXPIRY_SOON_DAYS, materials_needed: 1 });
    expect([...DUE_KINDS].sort()).toEqual(
      ["inquiry", "invoice_draft", "invoice_overdue", "job_on_hold", "lien_deadline", "materials_needed", "permit_inspection", "quote_awaiting", "supplier_pay"],
    );
  });

  it("isDue: the window's edges, ahead -ahead-1 / -ahead, then 0, +7 and +8", () => {
    for (const ahead of [0, 1, 5]) {
      expect(isDue(ago(-ahead - 1), ctx, ahead), `${ahead} early`).toBe(false);
      expect(isDue(ago(-ahead), ctx, ahead), `${ahead} first day`).toBe(true);
      expect(isDue(ago(0), ctx, ahead), `${ahead} today`).toBe(true);
      expect(isDue(ago(DUE_PASSED_DAYS), ctx, ahead), `${ahead} last day`).toBe(true);
      expect(isDue(ago(DUE_PASSED_DAYS + 1), ctx, ahead), `${ahead} old`).toBe(false);
    }
    expect(isDue(ago(-1), ctx)).toBe(false); // ahead defaults to 0: the day itself
    expect(isDue(null, ctx)).toBe(false);
    expect(isDue(undefined, ctx, 5)).toBe(false);
    expect(isDue("not a day", ctx)).toBe(false);
  });

  it("dueClock: the first that is due, else the first that is set, else null", () => {
    // A follow-up day long gone and an offer ending in three days: the offer is the clock.
    expect(dueClock("quote_awaiting", [ago(20), ago(-3)], ctx)).toBe(ago(-3));
    // Both due: the first wins.
    expect(dueClock("quote_awaiting", [ago(1), ago(-3)], ctx)).toBe(ago(1));
    // Neither due: the first that is set, so the row still knows its day (and stays plain).
    expect(dueClock("quote_awaiting", [null, ago(-30)], ctx)).toBe(ago(-30));
    expect(dueClock("quote_awaiting", [ago(40), ago(-30)], ctx)).toBe(ago(40));
    // The kind's own window decides: five days ahead is due for an offer, not for a draft.
    expect(dueClock("quote_awaiting", [ago(-30), ago(-5)], ctx)).toBe(ago(-5));
    expect(dueClock("invoice_draft", [ago(-30), ago(-5)], ctx)).toBe(ago(-30));
    expect(dueClock("quote_awaiting", [null, undefined, ""], ctx)).toBeNull();
    expect(dueClock("quote_awaiting", [], ctx)).toBeNull();
  });
});

describe("the level table", () => {
  it("1 quote_accepted: always NOW", () => {
    expect(lv("quote_accepted", { urgency: 2, when: ago(0) })).toBe("now");
    expect(lv("quote_accepted", { urgency: 0 })).toBe("now");
  });

  it("2 time_stray: a clock running from a past day is NOW; anything else is plain at every age", () => {
    expect(lv("time_stray", { urgency: 2, when: ago(1) })).toBe("now");
    for (const n of [0, 6, 7, 8, 90]) {
      expect(lv("time_stray", { when: ago(n), since: ago(n) }), `${n}`).toBe("none");
      // The rollup of hours on no job: its `since` is its age, never a mark.
      expect(lv("time_stray", { id: "stray-no-job", since: ago(n), clock: ago(0) }), `rollup ${n}`).toBe("none");
    }
  });

  it("3 lien_deadline: NOW within seven days, past included; otherwise SOON (on `when`, unchanged)", () => {
    expect(lv("lien_deadline", { when: ago(-8) })).toBe("soon");
    expect(lv("lien_deadline", { when: ago(-7) })).toBe("now");
    expect(lv("lien_deadline", { when: ago(-6) })).toBe("now");
    expect(lv("lien_deadline", { when: ago(5) })).toBe("now");
    expect(lv("lien_deadline", { when: ago(-14) })).toBe("soon");
  });

  it("4 supplier_pay: NOW within three days, SOON within seven, no mark beyond (on `when`, unchanged)", () => {
    expect(lv("supplier_pay", { when: ago(-2) })).toBe("now");
    expect(lv("supplier_pay", { when: ago(-3) })).toBe("now");
    expect(lv("supplier_pay", { when: ago(-4) })).toBe("soon");
    expect(lv("supplier_pay", { when: ago(-6) })).toBe("soon");
    expect(lv("supplier_pay", { when: ago(-7) })).toBe("soon");
    expect(lv("supplier_pay", { when: ago(-8) })).toBe("none");
    expect(lv("supplier_pay", { when: null })).toBe("none");
  });

  it("5 invoice_overdue: NOW thirty days past its day, SOON before (its own rule, no seven-day cut)", () => {
    expect(lv("invoice_overdue", { when: ago(8) })).toBe("soon");
    expect(lv("invoice_overdue", { when: ago(29) })).toBe("soon");
    expect(lv("invoice_overdue", { when: ago(30) })).toBe("now");
    expect(lv("invoice_overdue", { when: ago(31) })).toBe("now");
    expect(lv("invoice_overdue", { when: null })).toBe("soon");
  });

  it("the six clock kinds: Due from their window's first day through seven days past, read on `clock` alone", () => {
    for (const k of CLOCK_KINDS) {
      const ahead = DUE_AHEAD_DAYS[k] ?? 0;
      expect(lv(k, { clock: ago(-ahead - 1) }), `${k} early`).toBe("none");
      expect(lv(k, { clock: ago(-ahead) }), `${k} first day`).toBe("soon");
      expect(lv(k, { clock: ago(0) }), `${k} today`).toBe("soon");
      expect(lv(k, { clock: ago(7) }), `${k} +7`).toBe("soon");
      expect(lv(k, { clock: ago(8) }), `${k} +8`).toBe("none");
      // No clock is plain, whatever `when`, `since` or `urgency` say.
      for (const urgency of [0, 1, 2] as const) {
        expect(lv(k, { urgency, clock: null, when: ago(0), since: ago(30) }), `${k} ${urgency} no clock`).toBe("none");
      }
      // An ISO clock reads as the company's day.
      expect(lv(k, { clock: `${ago(1)}T18:00:00Z` }), `${k} iso`).toBe("soon");
    }
  });

  it("each clock kind's own story", () => {
    // materials_needed: the crew's day, today or tomorrow.
    expect(lv("materials_needed", { when: ago(-1), clock: ago(-1) })).toBe("soon");
    expect(lv("materials_needed", { when: null, clock: null })).toBe("none");
    // inquiry: a follow-up day that came, or a new lead's first week (its clock is the day it came in).
    expect(lv("inquiry", { urgency: 2, clock: ago(3), since: ago(3) })).toBe("soon");
    expect(lv("inquiry", { urgency: 2, clock: ago(8), since: ago(8) })).toBe("none");
    expect(lv("inquiry", { urgency: 0, clock: null, since: ago(30) })).toBe("none");
    // quote_awaiting: an offer ending inside five days is Due; quiet a week alone is not.
    expect(lv("quote_awaiting", { clock: ago(-5), since: ago(20), when: ago(-5) })).toBe("soon");
    expect(lv("quote_awaiting", { clock: ago(-6), since: ago(20), when: ago(-6) })).toBe("none");
    expect(lv("quote_awaiting", { clock: null, since: ago(20), when: ago(20) })).toBe("none");
    // invoice_draft: a set-aside day that came. A draft back because its job finished has none.
    expect(lv("invoice_draft", { urgency: 0, clock: ago(2), when: ago(40) })).toBe("soon");
    expect(lv("invoice_draft", { urgency: 1, clock: null, when: ago(0) })).toBe("none");
    // job_on_hold: a come-back day that came; a hold with no day is plain.
    expect(lv("job_on_hold", { clock: ago(0), since: ago(0) })).toBe("soon");
    expect(lv("job_on_hold", { clock: null, since: ago(60) })).toBe("none");
    // permit_inspection: a booked day gone by unwritten, or the day a visit failed. To book: plain.
    expect(lv("permit_inspection", { clock: ago(1), when: ago(1) })).toBe("soon");
    expect(lv("permit_inspection", { urgency: 2, clock: ago(2), since: ago(2) })).toBe("soon");
    expect(lv("permit_inspection", { urgency: 2, clock: null })).toBe("none");
  });

  it("a kind with no clock is plain at every age, whatever it is handed", () => {
    const plain: ActionKind[] = [
      "supplier_paper",
      "visit_unbilled",
      "job_unbilled_work",
      "inspection_writeup",
      "quote_draft",
      "contract_unsigned",
      "job_to_schedule",
      "appointment",
      "receipt_unbilled",
      "stock_short",
      "organize",
    ];
    for (const k of plain) {
      expect(DUE_KINDS, k).not.toContain(k);
      for (const n of [-3, 0, 6, 7, 8, 90])
        for (const urgency of [0, 1, 2] as const) expect(lv(k, { urgency, when: ago(n), since: ago(n), clock: ago(n) }), `${k} ${n} ${urgency}`).toBe("none");
    }
    // A visit nobody closed out is not amber (the owner, 2026-11-11), not even on its booked day.
    expect(lv("appointment", { when: ago(1), clock: ago(1) })).toBe("none");
  });

  it("days are the company's: an evening timestamp on a clock is that evening's day, not UTC's next", () => {
    // 2026-10-12 at 9 PM in Los Angeles is 04:00 UTC on the 13th: eight company days ago (past the
    // window), seven UTC days (inside it).
    const clock = "2026-10-13T04:00:00Z";
    expect(lv("inquiry", { clock })).toBe("none");
    expect(levelOf(it0("inquiry", { clock }), { todayStr: TODAY, tz: "UTC" })).toBe("soon");
  });

  it("every kind has a row in the table: the level is defined for all 22", () => {
    for (const k of KINDS) expect(["now", "soon", "none"]).toContain(lv(k));
  });
});

const DAYS = [null, ago(-30), ago(-8), ago(-7), ago(-6), ago(-5), ago(-3), ago(-1), ago(0), ago(6), ago(7), ago(8), ago(29), ago(30), ago(400), "2026-10-14T04:00:00Z"];

describe("only five kinds can ever be NOW", () => {
  it("over every combination of urgency, when, since and clock", () => {
    expect([...NOW_KINDS].sort()).toEqual(["invoice_overdue", "lien_deadline", "quote_accepted", "supplier_pay", "time_stray"]);
    for (const kind of KINDS) {
      if (NOW_KINDS.includes(kind)) continue;
      for (const urgency of [0, 1, 2] as const)
        for (const when of DAYS)
          for (const clock of DAYS) {
            expect(lv(kind, { urgency, when, since: when, clock }), `${kind} ${urgency} ${when} ${clock}`).not.toBe("now");
            expect(lv(kind, { urgency, when: clock, since: ago(400), clock: when }), `${kind} ${urgency} ${clock} ${when}`).not.toBe("now");
          }
    }
  });

  it("only DUE_KINDS can ever be amber, whatever the age, the urgency or the days", () => {
    for (const kind of KINDS) {
      if (DUE_KINDS.includes(kind)) continue;
      for (const urgency of [0, 1, 2] as const)
        for (const when of DAYS) for (const clock of DAYS) expect(lv(kind, { urgency, when, since: when, clock }), `${kind} ${urgency} ${when} ${clock}`).not.toBe("soon");
    }
  });

  it("a Couldn't Check line is never marked, whatever its kind and dates", () => {
    for (const kind of KINDS) {
      for (const urgency of [0, 1, 2] as const) {
        expect(levelOf(it0(kind, { id: "receipts-unread", urgency, when: ago(0), since: ago(60), clock: ago(0) }), ctx), kind).toBe("none");
      }
    }
    expect(isUnreadLine({ id: "needday-unread" })).toBe(true);
    expect(isUnreadLine({ id: "stray-no-job" })).toBe(false);
  });
});

describe("maxLevel", () => {
  it("the most urgent of several; none when there are none", () => {
    expect(maxLevel([])).toBe("none");
    expect(maxLevel(["none", undefined, null])).toBe("none");
    expect(maxLevel(["none", "soon"])).toBe("soon");
    expect(maxLevel(["soon", "now", "none"])).toBe("now");
  });
});

// A fixed pseudo-random sequence, so the generated lists are the same on every run.
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
type Row = Pick<ActionItem, "id" | "kind" | "done" | "group" | "level" | "amount" | "pile">;
function generated(seed: number, n: number): Row[] {
  const r = seeded(seed);
  const levels: Level[] = ["now", "soon", "none"];
  return Array.from({ length: n }, (_, i) => {
    const kind = KINDS[Math.floor(r() * KINDS.length)];
    const unread = r() < 0.1;
    return {
      id: unread ? `x${i}-unread` : `x${i}`,
      kind,
      group: KIND_GROUP[kind],
      done: r() < 0.15,
      level: unread ? "none" : levels[Math.floor(r() * 3)],
      amount: r() < 0.5 ? Math.round(r() * 5000) : null,
    };
  });
}

describe("the counts", () => {
  it("the three invariants hold over generated lists", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rows = generated(seed, seed * 3);
      const s = summarize(rows, { isStaff: true });
      const open = rows.filter((r) => !r.done).length;
      expect(s.now + s.soon + s.more, `seed ${seed}`).toBe(open);
      expect(s.tiles.reduce((a, t) => a + t.count, 0), `seed ${seed}`).toBe(s.soon + s.more);
      expect(s.tiles.reduce((a, t) => a + t.soon, 0), `seed ${seed}`).toBe(s.soon);
      expect(s.tiles.map((t) => t.group)).toEqual(GROUP_ORDER);
    }
  });

  it("a done row, a NOW row and an unread line count where they belong", () => {
    const rows: Row[] = [
      { id: "a", kind: "invoice_overdue", group: "get_paid", done: false, level: "now", amount: 900 },
      { id: "b", kind: "invoice_draft", group: "get_paid", done: false, level: "soon", amount: 100 },
      { id: "c", kind: "invoice_draft", group: "get_paid", done: true, level: "soon", amount: 50 },
      { id: "receipts-unread", kind: "receipt_unbilled", group: "keep_books", done: false, level: "none" },
      { id: "e", kind: "appointment", group: "run_jobs", done: false },
    ];
    const s = summarize(rows, { isStaff: true });
    expect([s.now, s.soon, s.more]).toEqual([1, 1, 2]);
    const paid = s.tiles[0];
    // The strip's NOW invoice is not in the tile, nor in its money.
    expect(paid).toEqual({ group: "get_paid", count: 1, soon: 1, money: 100, moneyCapped: false, unread: 0 });
    expect(s.tiles[3]).toMatchObject({ group: "keep_books", count: 1, unread: 1, money: null });
    expect(s.tiles[2]).toMatchObject({ group: "run_jobs", count: 1, soon: 0, money: null });
  });

  it("a pile counts one, with its own mark; a capped pile's money is 'at least'", () => {
    const rows: Row[] = [
      { id: "pile:invoices_not_sent", kind: "invoice_draft", group: "get_paid", done: false, level: "soon", amount: null, pile: { name: "invoices_not_sent", label: "Invoices Not Sent", count: 40, capped: true, listHref: null, listLabel: null, verb: "Send It" } },
      { id: "q", kind: "quote_draft", group: "win_work", done: false, level: "none", amount: 2500 },
    ];
    const s = summarize(rows, { isStaff: true });
    expect(s.tiles[0]).toMatchObject({ count: 1, soon: 1, money: null, moneyCapped: true });
    expect(s.tiles[1]).toMatchObject({ count: 1, money: 2500 });
  });

  it("money is null for anybody who is not staff", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const s = summarize(generated(seed, 30), { isStaff: false });
      for (const t of s.tiles) {
        expect(t.money).toBeNull();
        expect(t.moneyCapped).toBe(false);
      }
    }
  });

  it("the tile is read from the kind when a row was not stamped", () => {
    const s = summarize([{ id: "a", kind: "organize", done: false } as Row], { isStaff: true });
    expect(s.tiles[3].count).toBe(1);
  });
});

describe("the tile that opens first", () => {
  const t = (group: Group, count: number, soon: number) => ({ group, count, soon });

  it("the first tile in the fixed order with a SOON row", () => {
    expect(openFirst([t("get_paid", 3, 0), t("win_work", 2, 0), t("run_jobs", 4, 1), t("keep_books", 1, 1)])).toBe("run_jobs");
  });

  it("else the first with any row", () => {
    expect(openFirst([t("get_paid", 0, 0), t("win_work", 2, 0), t("run_jobs", 4, 0), t("keep_books", 1, 0)])).toBe("win_work");
  });

  it("none when every tile is empty, and the order is the fixed one whatever the input order", () => {
    expect(openFirst([t("get_paid", 0, 0), t("win_work", 0, 0), t("run_jobs", 0, 0), t("keep_books", 0, 0)])).toBeNull();
    expect(openFirst([t("keep_books", 1, 1), t("win_work", 1, 1)])).toBe("win_work");
  });

  it("summarize names it: a NOW row alone opens nothing", () => {
    const rows: Row[] = [
      { id: "a", kind: "quote_accepted", group: "run_jobs", done: false, level: "now" },
      { id: "b", kind: "organize", group: "keep_books", done: false, level: "none" },
    ];
    expect(summarize(rows, { isStaff: true }).open).toBe("keep_books");
    expect(summarize([rows[0]], { isStaff: true }).open).toBeNull();
  });
});

describe("withoutMoneyForTech: the tech's belt at the one exit", () => {
  const base = (o: Partial<ActionItem> = {}): ActionItem => ({
    id: "inv-1",
    kind: "invoice_overdue",
    group: "get_paid",
    title: "INV-001 · 3 days past due",
    subtitle: "Dana Rook",
    who: "Dana Rook",
    what: { key: "ny_w_invoiceLate", vars: { money: 420, day: "2026-11-01" } },
    whoSay: { key: "ny_who_paper", vars: { money2: 12 } },
    amount: 420,
    when: "2026-11-01",
    urgency: 1,
    done: false,
    href: "/billing/inv-1",
    affordances: [],
    ...o,
  });

  it("staff rows come back as the very same object", () => {
    const row = base({ children: [base({ id: "c1" })] });
    expect(withoutMoneyForTech(row, true)).toBe(row);
  });

  it("a tech's row loses its amount and every phrase that fills a money slot; other phrases stay", () => {
    const out = withoutMoneyForTech(base(), false);
    expect(out.amount).toBeNull();
    expect(out.what).toBeUndefined();
    expect(out.whoSay).toBeUndefined();
    expect(out.title).toBe("INV-001 · 3 days past due");
    const plain = withoutMoneyForTech(base({ what: { key: "ny_w_toWriteUp", vars: { type: "inspection" } }, whoSay: undefined }), false);
    expect(plain.what).toEqual({ key: "ny_w_toWriteUp", vars: { type: "inspection" } });
  });

  it("a pile's children are covered too", () => {
    const out = withoutMoneyForTech(base({ id: "pile:late_invoices", children: [base({ id: "c1" }), base({ id: "c2", what: { key: "ny_w_toWriteUp" }, whoSay: undefined })] }), false);
    expect(out.children!.map((c) => c.amount)).toEqual([null, null]);
    expect(out.children![0].what).toBeUndefined();
    expect(out.children![1].what).toEqual({ key: "ny_w_toWriteUp" });
  });
});
