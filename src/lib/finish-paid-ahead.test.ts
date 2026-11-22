import { describe, it, expect, vi, beforeEach } from "vitest";
import { dict } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import type { PrepaymentState } from "./prepayments";

/**
 * FINISH AND THE MONEY ASKED FOR AHEAD (cn-v1177; re-pinned on purpose after skeptic #80). Every
 * DECISION reads the draw pool's lump only: a payment request never "covers" work, the bill is built
 * for the work and the sync takes the request off it. The requests are read for the WORDS: money PAID
 * ahead that no bill used, naming the refund door on that request, in both languages.
 */
const reads = vi.hoisted(() => ({
  states: [] as PrepaymentState[],
  fail: false,
  unbilled: { schemaReady: true, hours: 0, billsCount: 0, stockCount: 0, laborAmount: 0, billsBilled: 0, stockBilled: 0, total: 0 } as any,
  drawLump: 0,
  draws: [] as unknown[],
}));
vi.mock("@/lib/payment-request", () => ({
  readPrepaymentStates: vi.fn(async () => {
    if (reads.fail) throw new Error("read failed");
    return reads.states;
  }),
}));
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: vi.fn(async () => reads.unbilled),
  fixedBillingsNotYetNetted: vi.fn(async () => reads.drawLump),
}));
vi.mock("@/lib/actuals-draw", async (orig) => ({ ...(await orig<typeof import("./actuals-draw")>()), openDraftOnJob: vi.fn(async () => null) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { finishBillingStep, paidAheadAtFinish, paidDoorVerdict } from "./finish-bills-first";
import { depositCoversWords, paidAheadUnusedWords } from "./finish-job-words";

const sb: any = {
  from(table: string) {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      limit: () => chain,
      maybeSingle: async () => (table === "jobs" ? { data: { billing_type: "tm" }, error: null } : { data: null, error: null }),
      then: (ok: any, bad: any) => Promise.resolve(table === "invoices" ? { data: reads.draws, error: null } : { data: [], error: null }).then(ok, bad),
    };
    return chain;
  },
};

const state = (over: Partial<PrepaymentState>): PrepaymentState => ({
  id: "r1",
  number: "INV-900",
  label: "Deposit",
  status: "paid",
  amount: 1000,
  paid: 1000,
  refunded: 0,
  taken: [],
  takenTotal: 0,
  left: 1000,
  moneyLeft: 1000,
  ...over,
});

beforeEach(() => {
  reads.states = [];
  reads.fail = false;
  reads.unbilled = { schemaReady: true, hours: 0, billsCount: 0, stockCount: 0, laborAmount: 0, billsBilled: 0, stockBilled: 0, total: 0 };
  reads.drawLump = 0;
  reads.draws = [];
});

describe("paidAheadAtFinish: what the requests still take off, and what was paid that no bill used", () => {
  it("none: null", () => {
    expect(paidAheadAtFinish([])).toBeNull();
  });
  it("sums what is left and names each request holding unused money", () => {
    const p = paidAheadAtFinish([state({}), state({ id: "r2", number: "INV-901", paid: 0, moneyLeft: 0, left: 300, amount: 300, status: "sent" })]);
    expect(p).toEqual({ left: 1300, moneyLeft: 1000, unused: [{ number: "INV-900", amount: 1000 }] });
  });
});

describe("the words, both languages", () => {
  const es = (key: string) => dict("es")[key];
  it("money in hand no bill used names the refund door", () => {
    const p = { left: 400, moneyLeft: 400, unused: [{ number: "INV-900", amount: 400 }] };
    expect(paidAheadUnusedWords(p)).toBe("$400.00 was paid ahead and no bill used it. Refund it from INV-900.");
    expect(paidAheadUnusedWords(p, "es", es)).toBe("$400.00 se pagó por adelantado y ninguna factura lo usó. Reembólsalo desde INV-900.");
    expect(paidAheadUnusedWords({ left: 0, moneyLeft: 0, unused: [] })).toBeNull();
    // The catalog's English is the inline English, slot for slot.
    expect(fillSlots(dict("en").jb_finPaidAheadUnused, { money: "$400.00", from: "INV-900" })).toBe(paidAheadUnusedWords(p));
  });
  it("a payment request is never 'covering' words (cn-v1177, skeptic #80): depositCoversWords is the draw's, byte for byte as before", () => {
    expect(depositCoversWords(600, 1000)).toBe(
      "The $1,000.00 deposit not yet taken off a bill covers the $600.00 of work not on a bill, so no bill is built. The deposit is $400.00 more than the work: settle the difference with the customer.",
    );
    // The keys of the request's "covers" sentences are gone from both catalogs: nothing reads them.
    for (const k of ["jb_finAskedAheadCovers", "jb_finAskedAheadOverSettle", "jb_finAskedAheadOverRefund", "jb_finMarksComplete"]) {
      expect(dict("en")[k]).toBeUndefined();
      expect(dict("es")[k]).toBeUndefined();
    }
  });
});

describe("finishBillingStep decides by the DRAW pool only; the requests are read for the words", () => {
  it("work $600 not on a bill, $1,000 paid ahead: the lump is the draw pool's (0), the door BUILDS a bill for the work, and the job is not finished by a paid bill until it is billed", async () => {
    reads.unbilled = { ...reads.unbilled, hours: 4, laborAmount: 600, total: 600 };
    reads.states = [state({})];
    const step = await finishBillingStep(sb, "job-1", { kind: "staff" });
    expect(step.kind).toBe("plan");
    if (step.kind !== "plan") return;
    expect(step.lump).toBe(0);
    expect(step.door).toMatchObject({ kind: "create", amount: 600 });
    expect(step.prepaid).toEqual({ left: 1000, moneyLeft: 1000, unused: [{ number: "INV-900", amount: 1000 }] });
    expect(paidDoorVerdict(step, "J-900 (Larkspur)").finish).toBe(false);
  });
  it("work $1,500 not on a bill, $1,000 asked ahead: the bill is built for the whole work (the sync takes the request off it)", async () => {
    reads.unbilled = { ...reads.unbilled, hours: 10, laborAmount: 1500, total: 1500 };
    reads.states = [state({})];
    const step = await finishBillingStep(sb, "job-1", { kind: "staff" });
    expect(step.kind === "plan" && step.door.kind === "create" && step.door.amount).toBe(1500);
  });
  it("a draw deposit still covers: the draw pool's lump alone, and a paid request no bill used is said after it", async () => {
    reads.unbilled = { ...reads.unbilled, hours: 4, laborAmount: 600, total: 600 };
    reads.draws = [{ id: "d1" }];
    reads.drawLump = 1000;
    reads.states = [state({ amount: 200, paid: 200, left: 200, moneyLeft: 200 })];
    const step = await finishBillingStep(sb, "job-1", { kind: "staff" });
    expect(step.kind === "plan" && step.lump).toBe(1000);
    expect(step.kind === "plan" && step.door.kind).toBe("covered");
    const v = paidDoorVerdict(step, "J-900");
    expect(v.say).toBe(
      "J-900 is finished. The $1,000.00 deposit not yet taken off a bill covers the $600.00 of work not on a bill, so no bill is built. The deposit is $400.00 more than the work: settle the difference with the customer. $200.00 was paid ahead and no bill used it. Refund it from INV-900.",
    );
  });
  it("nothing left to bill and a paid request no bill used: the job finishes and the money is said with its door", async () => {
    reads.states = [state({ left: 0, takenTotal: 600, taken: [{ invoiceId: "b", amount: 600 }], moneyLeft: 400 })];
    const step = await finishBillingStep(sb, "job-1", { kind: "staff" });
    expect(step.kind).toBe("skip");
    const v = paidDoorVerdict(step, "J-900 (Larkspur)");
    expect(v).toEqual({ finish: true, say: "J-900 (Larkspur) is finished. $400.00 was paid ahead and no bill used it. Refund it from INV-900.", title: "Job finished", why: "" });
  });
  it("no requests: the step is what it always was", async () => {
    const step = await finishBillingStep(sb, "job-1", { kind: "staff" });
    expect(step).toEqual({ kind: "skip" });
    expect(paidDoorVerdict(step, "J-900")).toEqual({ finish: true, say: null, title: null, why: "" });
  });
  it("a failed read of the requests is never 'none': the step is an error and the job is not finished", async () => {
    reads.fail = true;
    const step = await finishBillingStep(sb, "job-1", { kind: "staff" });
    expect(step.kind).toBe("error");
    expect(paidDoorVerdict(step, "J-900").finish).toBe(false);
  });
});
