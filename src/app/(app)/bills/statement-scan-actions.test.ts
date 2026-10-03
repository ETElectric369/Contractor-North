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
      create: async (args: unknown) => {
        state.calls.push(args);
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
import { SCAN_MORE_CALLS } from "@/lib/statement-scan";

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

  it("still cut off after the last continuation: nothing is added, and it says so", async () => {
    state.answers = [isBank(), ...Array.from({ length: SCAN_MORE_CALLS + 1 }, (_, i) => answer({ ...CONTROLS, lines: [LINES[i]] }, "max_tokens"))];
    const got = await drop();
    expect(got.ok).toBe(false);
    expect(got.error).toContain("looks complete and isn't");
    expect(items()).toEqual([]);
    expect(state.calls).toHaveLength(SCAN_MORE_CALLS + 2);
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
