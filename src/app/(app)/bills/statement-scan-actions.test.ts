import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * THE DOOR THAT READS A SCANNED STATEMENT (2026-10-02), against an in-memory database and a reader
 * that answers whatever each test says it answers.
 *
 * THE MODEL IS NEVER CALLED HERE. `getAnthropic` is replaced by a fake whose answers are queued by
 * hand, so every test states exactly what came back off the pages — and the number of calls is itself
 * asserted, because "the cheap look answers first" is only true if the expensive one never ran.
 *
 * WHAT IS PINNED: a receipt, an invoice and a plan still go to the + button for the price of one cheap
 * call; a read the statement's own figures disagree with writes NOTHING; a paper with no totals on it
 * still reaches the card and the card says nothing checked it; a cut-off answer is continued and, if it
 * is still cut off, refused; and the owner's own switch decides who may do any of it.
 *
 * SYNTHETIC THROUGHOUT: an invented bank, invented merchants, invented figures, and a "PDF" that is
 * eight bytes of header. No real statement, and no file outside this repository, is ever opened.
 */

const state = vi.hoisted(() => ({
  client: null as any,
  orgId: "org-1",
  answers: [] as any[],
  calls: [] as any[],
  over: false,
  /** What the Nth call throws instead of answering — a timeout, an outage. Null: it answers. */
  throwOn: null as null | ((nth: number) => unknown),
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: state.orgId })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "model-test",
  getAnthropic: () => ({
    messages: {
      // THE SECOND ARGUMENT IS KEPT TOO: a read's own timeout is what stops the platform ending it.
      create: async (args: unknown, options?: unknown) => {
        state.calls.push(Object.assign({ options }, args));
        const bang = state.throwOn?.(state.calls.length);
        if (bang) throw bang;
        const next = state.answers.shift();
        if (!next) throw new Error("the test queued no answer for this call");
        return next;
      },
    },
  }),
}));
// The real `modelFor` stays (the choice of model is part of what this builds); the ledger and the
// ceiling are the two that would reach a real database.
vi.mock("@/lib/ai-cost", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordAiUsage: async () => {},
  aiSpendExceeded: async () => state.over,
}));

import { readStatementScan } from "./statement-scan-actions";
import { SCAN_MORE_CALLS, SCAN_READ_MS } from "@/lib/statement-scan";

type Row = Record<string, any>;
let db: Record<string, Row[]>;
let seq = 0;

function fakeDb() {
  return {
    from(table: string) {
      const rows = (db[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let verb: "select" | "insert" | "update" | "delete" = "select";
      let payload: any = null;
      let one: "single" | "maybe" | null = null;
      let cap = Infinity;
      const run = () => {
        if (verb === "insert") {
          const list = (Array.isArray(payload) ? payload : [payload]).map((r: Row): Row => ({
            id: `${table}-${++seq}`,
            ...(table === "organized_items" && !r.org_id ? { org_id: state.orgId } : {}),
            ...r,
          }));
          if (table === "organized_items") {
            for (const r of list) {
              if (r.content_sha256 && rows.some((x) => x.org_id === r.org_id && x.content_sha256 === r.content_sha256)) {
                return { data: null, error: { code: "23505", message: "duplicate key value" } };
              }
            }
          }
          rows.push(...list);
          return { data: one ? list[0] : list, error: null };
        }
        const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, cap);
        if (verb === "update") {
          for (const r of hit) Object.assign(r, structuredClone(payload));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        const out = hit.map((r) => structuredClone(r));
        if (one) return { data: out[0] ?? null, error: null };
        return { data: out, error: null };
      };
      const chain: any = {
        select: () => chain,
        insert: (p: any) => ((verb = "insert"), (payload = p), chain),
        update: (p: any) => ((verb = "update"), (payload = p), chain),
        delete: () => ((verb = "delete"), chain),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), chain),
        order: () => chain,
        limit: (n: number) => ((cap = n), chain),
        single: () => ((one = "single"), chain),
        maybeSingle: () => ((one = "maybe"), chain),
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      };
      return chain;
    },
  };
}

/** The statement the reader got right: it balances, and both printed totals agree to the cent. */
const LINES = [
  { date: "2026-09-02", description: "CARD PURCHASE HARROWGATE FUEL", money_out: 142.08, money_in: null },
  { date: "2026-09-03", description: "REFUND WESTMERE HARDWARE", money_out: null, money_in: 37.42 },
  { date: "2026-09-05", description: "CHECK 1042", money_out: 1250.0, money_in: null },
  { date: "2026-09-08", description: "DEPOSIT INVOICE PAYMENT", money_out: null, money_in: 3400.0 },
  { date: "2026-09-22", description: "ACH CARD PAYMENT WESTMERE CARD SERVICES", money_out: 812.33, money_in: null },
  { date: "2026-09-30", description: "MONTHLY SERVICE CHARGE", money_out: 12.0, money_in: null },
];
const CONTROLS = { beginning_balance: 1284.55, ending_balance: 2505.56, deposits_total: 3437.42, withdrawals_total: 2216.41, account_last4: "4417" };
const GOOD = { ...CONTROLS, lines: LINES };

const PDF = Buffer.from("%PDF-1.4\n% a synthetic scan\n").toString("base64");
const SHA = createHash("sha256").update("september-statement").digest("hex");

const answer = (obj: unknown, stop: "end_turn" | "max_tokens" = "end_turn") => ({
  model: "model-test",
  stop_reason: stop,
  usage: { input_tokens: 2000, output_tokens: 800 },
  content: [{ type: "text", text: JSON.stringify(obj) }],
});
const isBank = () => answer({ paper: "bank_statement", what: "a checking account statement" });

const drop = (over: Partial<Parameters<typeof readStatementScan>[0]> = {}) =>
  readStatementScan({ name: "September.pdf", base64: PDF, pages: 3, sha256: SHA, listDate: "2026-09-30", ...over });

const items = () => db.organized_items ?? [];

beforeEach(() => {
  db = {
    profiles: [{ id: "user-1", role: "owner", org_id: "org-1" }],
    organizations: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" } }],
    organized_items: [],
  };
  seq = 0;
  state.client = fakeDb();
  state.orgId = "org-1";
  state.answers = [];
  state.calls = [];
  state.over = false;
  state.throwOn = null;
});

describe("a scanned bank statement becomes the one bank card, and nothing else", () => {
  it("reads, is held against the statement's own figures, and waits for Apply", async () => {
    state.answers = [isBank(), answer(GOOD)];
    const got = await drop();
    expect(got.ok).toBe(true);
    expect(got.line).toContain("Read as a bank download: 6 lines");
    expect(got.line).toContain("nothing is written until you press Apply");
    // THE ONE READ REPORT, carrying what the arithmetic found.
    expect(got.line).toContain("3 pages, 6 rows on them, 6 lines");
    expect(got.line).toContain("$2,216.41 out and $3,437.42 in");
    expect(got.line).toContain("agree to the cent");
    // ONE ROW, WAITING. No bank line, no bill, no cost: a model read is a proposal.
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ status: "needs_review", category: "Bank Download", doc_type: "statement", vendor: "Bank ••4417" });
    expect(items()[0].proposal.bankImport.applied).toBe(null);
    expect(items()[0].proposal.bankImport.download.lines).toHaveLength(6);
    expect(db.bank_lines).toBeUndefined();
    expect(db.bills).toBeUndefined();
    // AND THE CHECK IS ON THE CARD, not only in the line under the button: Apply may be tomorrow.
    expect(items()[0].proposal.bankImport.download.readSaid).toContain("agree to the cent");
  });

  it("the cheap look chooses the paper and the careful look reads the lines — in that order", async () => {
    state.answers = [isBank(), answer(GOOD)];
    await drop();
    expect(state.calls).toHaveLength(2);
    // Reading forty money lines off a picture is not a classify job, and the budget says so.
    expect(state.calls[0].max_tokens).toBeLessThan(1000);
    expect(state.calls[1].max_tokens).toBeGreaterThanOrEqual(16_000);
    expect(state.calls[0].model).not.toBe(state.calls[1].model);
    // The pages themselves go up, as the document block that reads his handwriting today.
    expect(state.calls[1].messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
  });
});

describe("an ordinary paper behaves exactly as it did: the + button reads a paper", () => {
  for (const [what, words] of [
    ["one_paper", "a hardware store receipt"],
    ["one_paper", "a supply house invoice"],
    ["other", "a set of plans"],
  ] as [string, string][]) {
    it(`${words} goes to the + button, and the expensive look is never paid for`, async () => {
      state.answers = [answer({ paper: what, what: words })];
      const got = await drop();
      expect(got.ok).toBe(false);
      expect(got.error).toContain(words);
      expect(got.error).toContain("+ button");
      expect(state.calls).toHaveLength(1);
      expect(items()).toEqual([]);
    });
  }

  it("a supplier's own statement names the door that reads one, and says why", async () => {
    state.answers = [answer({ paper: "supplier_statement", what: "a supply house statement" })];
    const got = await drop();
    expect(got.error).toContain("a supplier's statement rather than a bank's");
    expect(got.error).toContain("+ button");
    expect(items()).toEqual([]);
  });
});

describe("the gate decides whether anything is proposed at all", () => {
  it("one line misread by a cent: nothing is added, and the amount is named", async () => {
    state.answers = [isBank(), answer({ ...GOOD, lines: [{ ...LINES[0], money_out: 142.09 }, ...LINES.slice(1)] })];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("nothing was added");
    expect(got.error).toContain("The money going out doesn't add up");
    expect(got.error).toContain("$0.01");
    expect(got.error).toContain("Drop it again");
    expect(items()).toEqual([]);
  });

  it("a withdrawal read as a deposit never reaches the books", async () => {
    const flipped = [{ ...LINES[0], money_out: null, money_in: 142.08 }, ...LINES.slice(1)];
    state.answers = [isBank(), answer({ ...GOOD, lines: flipped })];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("$142.08");
    expect(items()).toEqual([]);
  });

  it("a paper with no printed totals still reaches the card, saying nothing checked it", async () => {
    state.answers = [isBank(), answer({ account_last4: "4417", beginning_balance: null, ending_balance: null, deposits_total: null, withdrawals_total: null, lines: LINES })];
    const got = await drop();
    expect(got.ok).toBe(true);
    expect(got.line).toContain("prints no totals to hold the read against");
    expect(got.line).toContain("NOTHING here checked it");
    expect(items()).toHaveLength(1);
    // THE SENTENCE THAT MATTERS MOST IS THE ONE THAT HAS TO BE BESIDE APPLY.
    expect(items()[0].proposal.bankImport.download.readSaid).toContain("NOTHING here checked it");
  });

  it("a reader that came back with no lines at all is never a card", async () => {
    state.answers = [isBank(), answer({ ...CONTROLS, lines: [] })];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("no transaction lines off it");
    expect(items()).toEqual([]);
  });
});

describe("length: a cut-off answer is continued, and never passes as a short list", () => {
  it("it continues from its last line, and every line lands", async () => {
    state.answers = [
      isBank(),
      answer({ ...CONTROLS, lines: LINES.slice(0, 3) }, "max_tokens"),
      answer({ ...CONTROLS, lines: LINES.slice(3) }),
    ];
    const got = await drop();
    expect(got.ok).toBe(true);
    expect(got.line).toContain("6 lines");
    expect(got.line).toContain("agree to the cent");
    expect(items()[0].proposal.bankImport.download.lines).toHaveLength(6);
    // The continuation says which line it is to carry on from, so nothing is read twice.
    const asked = state.calls[2].messages[2].content as string;
    expect(asked).toContain("2026-09-05");
    expect(asked).toContain("do not repeat");
  });

  /**
   * AND IT CONTINUES A REPLY THAT IS REALLY CUT OFF — invalid JSON, stopped in the middle of a line.
   *
   * This is the test the branch did not have, and its absence hid a dead capability. `answer()` queues
   * `JSON.stringify(...)` with stop_reason "max_tokens", which is VALID JSON and so parses directly; a
   * real max_tokens reply never is. The real one went to parseAiJson's repair round trip, which has to
   * re-emit the whole 16,000-token answer inside its own budget, could not, and threw "too large to
   * repair" — leaving the loop BEFORE a line had been kept and before a continuation was ever built. So
   * every statement past one answer read "it got 0 and the statement goes on": the continuation, the
   * roughly thousand-line reach and the count in the sentence were all fiction in production.
   *
   * A repair answer is queued after the cut one on purpose. If it is ever taken, the queue runs dry on
   * the continuation and the test fails on the call count — so this pins that the repair is NOT reached.
   */
  it("a reply cut off mid-JSON is closed in code, continued, and never sent to the repair model", async () => {
    const whole = JSON.stringify({ ...CONTROLS, lines: LINES });
    // Cut inside the fourth line's description: exactly what a max_tokens stop leaves behind.
    const truncated = whole.slice(0, whole.indexOf("DEPOSIT INVOICE PAYMENT") + 7);
    expect(() => JSON.parse(truncated)).toThrow();
    state.answers = [
      isBank(),
      { model: "model-test", stop_reason: "max_tokens", usage: { input_tokens: 2000, output_tokens: 16000 }, content: [{ type: "text", text: truncated }] },
      answer({ ...CONTROLS, lines: LINES.slice(3) }),
    ];
    const got = await drop();
    expect(got.ok).toBe(true);
    expect(items()[0].proposal.bankImport.download.lines).toHaveLength(6);
    expect(got.line).toContain("agree to the cent");
    // Three calls: the cheap look, the cut read, the continuation. No repair call anywhere.
    expect(state.calls).toHaveLength(3);
    expect(state.answers).toHaveLength(0);
    // THE CONTROL FIGURES SURVIVED THE CUT, because they come before "lines" in the asked-for shape.
    expect(items()[0].proposal.bankImport.download.readSaid).toContain("agree to the cent");
    // The continuation carries on after the last WHOLE line, so the half line is simply re-read.
    const asked = state.calls[2].messages[2].content as string;
    expect(asked).toContain("CHECK 1042");
    expect(asked).toContain("do not repeat");
  });

  it("still cut off after the last continuation: nothing is added, and it says so", async () => {
    state.answers = [isBank(), ...Array.from({ length: SCAN_MORE_CALLS + 1 }, (_, i) => answer({ ...CONTROLS, lines: [LINES[i]] }, "max_tokens"))];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("looks complete and isn't");
    // THE COUNT IS NOW A REAL ONE (four passes, one line each), and the way out is one that works:
    // the gate refuses the half of a split statement its printed totals no longer describe.
    expect(got.error).toContain("it got 4 lines");
    expect(got.error).not.toContain("two shorter PDFs");
    expect(got.error).toContain("CSV or OFX");
    expect(items()).toEqual([]);
    expect(state.calls).toHaveLength(SCAN_MORE_CALLS + 2);
  });

  it("a reply cut so early that no whole line closed says it was cut, with no count and no dead end", async () => {
    const whole = JSON.stringify({ ...CONTROLS, lines: LINES });
    state.answers = [
      isBank(),
      { model: "model-test", stop_reason: "max_tokens", usage: { input_tokens: 2000, output_tokens: 16000 }, content: [{ type: "text", text: whole.slice(0, whole.indexOf('"lines"') + 12) }] },
    ];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("more lines on it than the reader can hand back in one go.");
    expect(got.error).not.toContain("it got 0");
    expect(got.error).toContain("+ button");
    // NOT "the reader didn't answer": it answered, and what it said was cut. And nothing was repaired.
    expect(got.error).not.toContain("couldn't be read");
    expect(state.calls).toHaveLength(2);
    expect(items()).toEqual([]);
  });
});

describe("a credit-card statement reads, instead of being refused for being a card", () => {
  /** Previous 1,200.00 owed, one payment of 1,200.00, purchases of 845.31, new balance 845.31. */
  const CARD = {
    account_kind: "card",
    beginning_balance: 1200.0,
    ending_balance: 845.31,
    deposits_total: 1200.0,
    withdrawals_total: 845.31,
    account_last4: "9921",
    lines: [
      { date: "2026-09-04", description: "PAYMENT - THANK YOU", money_out: null, money_in: 1200.0 },
      { date: "2026-09-11", description: "HARROWGATE FUEL", money_out: 312.44, money_in: null },
      { date: "2026-09-19", description: "WESTMERE HARDWARE", money_out: 532.87, money_in: null },
    ],
  };

  it("a card month read perfectly becomes a card, and the report says which way it was walked", async () => {
    state.answers = [answer({ paper: "bank_statement", what: "a credit card statement" }), answer(CARD)];
    const got = await drop();
    expect(got.ok).toBe(true);
    expect(got.line).toContain("a card's balance: what you owe");
    expect(items()).toHaveLength(1);
    expect(items()[0].proposal.bankImport.download.lines).toHaveLength(3);
    // The charges are money OUT and the payment money IN, which is the bank reader's own convention.
    const cents = items()[0].proposal.bankImport.download.lines.map((l: { cents: number }) => l.cents);
    expect(cents).toEqual([120000, -31244, -53287]);
  });

  it("a card with a line missed is still refused, so the direction is not a way to pass", async () => {
    state.answers = [isBank(), answer({ ...CARD, lines: CARD.lines.slice(0, 2) })];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("$532.87 short");
    expect(items()).toEqual([]);
  });
});

/**
 * THE GATE JUDGES THE LINES THAT LAND, read by the one reader that lands them (readBankDownload). It
 * used to read the reader's answer a second way, with a different day reader, so the two sets drifted:
 * a line dated "2026/09/03" was invisible to the gate but landed on the card.
 */
describe("the gate and the card hold the same lines", () => {
  it("a correct read with one non-ISO date is not refused as short", async () => {
    state.answers = [isBank(), answer({ ...GOOD, lines: LINES.map((l, i) => (i === 1 ? { ...l, date: "2026/09/03" } : l)) })];
    const got = await drop();
    expect(got.ok).toBe(true);
    expect(items()[0].proposal.bankImport.download.lines).toHaveLength(6);
    // THE TWO FIGURES IN THE REPORT ARE ADDED UP FROM THE LINES THAT LANDED, and the gate's "agree"
    // is about those same lines. If the gate had judged its own set, these could not both be here.
    expect(got.line).toContain("$2,216.41 out and $3,437.42 in");
    expect(got.line).toContain("agree to the cent");
  });

  it("a duplicated line in a date form the gate used to miss is caught", async () => {
    state.answers = [isBank(), answer({ ...GOOD, lines: [...LINES, { date: "5 Sep 2026", description: "CHECK 1042", money_out: 1250.0, money_in: null }] })];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("$1,250.00 over");
    expect(items()).toEqual([]);
  });
});

describe("the clock is the reader's, and it ends in words", () => {
  it("a read the clock ran out on says so, and names one action then the fallback", async () => {
    state.answers = [isBank()];
    // The cheap look answers; the careful one times out, which is where the real time goes.
    state.throwOn = (nth) => (nth === 2 ? Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }) : null);
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("time one read gets ran out");
    expect(got.error).toContain("Drop it again");
    expect(got.error).toContain("+ button");
    expect(items()).toEqual([]);
  });

  it("every read gets a deadline, so the platform is never what ends it", async () => {
    state.answers = [isBank(), answer(GOOD)];
    await drop();
    // BOTH looks, on one clock started before either, with no silent retries behind it.
    for (const call of state.calls) {
      expect(call.options).toMatchObject({ maxRetries: 0 });
      expect(call.options.timeout).toBeGreaterThan(0);
      expect(call.options.timeout).toBeLessThanOrEqual(SCAN_READ_MS);
    }
    expect(state.calls).toHaveLength(2);
  });
});

describe("who may: the owner's own money, held to the one rule", () => {
  /**
   * THE CONDITION IS NEVER RE-DERIVED HERE, which is the whole point: `viewerSortsBank` is asked, so
   * the switch's own default (0286: office staff DO see owner money until the owner turns it off) is
   * whatever that one function says it is, on this door and on every other.
   */
  it("an office hand the owner has switched OFF is refused before a page is read", async () => {
    db.profiles = [{ id: "user-1", role: "office", org_id: "org-1" }];
    db.organizations = [{ id: "org-1", settings: { timezone: "America/Los_Angeles", office_sees_owner_money: false } }];
    state.answers = [isBank(), answer(GOOD)];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("The owner sorts bank downloads");
    // NOT A PENNY SPENT ON A READ THAT COULD NEVER BE STORED.
    expect(state.calls).toEqual([]);
    expect(items()).toEqual([]);
  });

  it("a tech never reaches it, whatever the switch says", async () => {
    db.profiles = [{ id: "user-1", role: "tech", org_id: "org-1" }];
    state.answers = [isBank(), answer(GOOD)];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("The owner sorts bank downloads");
    expect(state.calls).toEqual([]);
  });

  it("the same office hand reads it while that switch is on", async () => {
    db.profiles = [{ id: "user-1", role: "office", org_id: "org-1" }];
    state.answers = [isBank(), answer(GOOD)];
    const got = await drop();
    expect(got.ok).toBe(true);
    expect(items()).toHaveLength(1);
  });
});

describe("nothing is read twice, and nothing is read for free", () => {
  it("the same file again is Already In, before a penny is spent", async () => {
    db.organized_items = [{ id: "item-old", org_id: "org-1", content_sha256: SHA, status: "needs_review", created_at: "2026-09-30T12:00:00Z", title: "September.pdf" }];
    state.answers = [isBank(), answer(GOOD)];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.already).toBeTruthy();
    expect(state.calls).toEqual([]);
  });

  it("a month's allowance used up says so, and names the door that keeps the paper", async () => {
    state.over = true;
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("AI allowance");
    expect(got.error).toContain("+ button");
    expect(state.calls).toEqual([]);
  });

  it("something that isn't a PDF inside is refused without a read", async () => {
    const got = await drop({ base64: Buffer.from("just some text").toString("base64") });
    expect(got.ok).toBe(false);
    expect(got.error).toContain("isn't a PDF inside");
    expect(state.calls).toEqual([]);
  });
});
