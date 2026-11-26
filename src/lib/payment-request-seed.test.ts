import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, failingReads, type Row, type Tables, type Write } from "@/lib/prepayment-db.test-util";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE JOB PAGE'S PAID AHEAD SEED, READ WITH WHAT THE PAGE ALREADY HOLDS (cn-v1190, P1).
 *
 * Before: the page called the office door readPaymentRequestSeed, which asked who is signed in again,
 * read the profile twice more and worked out the unbilled work a second time, and it ran after every
 * other read on the page. Now the page reads lib/payment-request-seed with its own client, the company
 * the job was read in, the viewer's language and its own unbilled-work result. The page must be handed
 * EXACTLY what it was handed before: the door's answer and the page's answer are compared here over
 * stand-in books (no request, a paid request, a refusal, a failed read), in both languages.
 * Stand-ins: the Larkspur job J-900, its estimate E-900, request INV-900.
 */
const state = vi.hoisted(() => ({ client: null as any, lang: "en", orgId: "org-larkspur" as string | null, workReads: 0 }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: state.orgId, role: "owner" })) }));
vi.mock("@/lib/lang-of", () => ({ callerLang: vi.fn(async () => state.lang) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}) }));
// The unbilled work is a token here; its marked-up materials are what customerUnbilled reads off it.
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: vi.fn(async () => {
    state.workReads += 1;
    return { materials: 130 };
  }),
  customerUnbilled: vi.fn((w: { materials?: number } | null) => ({ materials: Number(w?.materials ?? 0) })),
}));

import { readPaymentRequestSeed } from "@/app/(app)/billing/request-actions";
import { readPaymentRequestSeedAs } from "./payment-request-seed";
import { asLang } from "@/lib/locale";

const ORG = "org-larkspur";
const JOB = "job-900";
let db: Tables;
let writes: Write[];

const PAID_REQUEST: Row = { id: "inv-900", org_id: ORG, job_id: JOB, customer_id: "cust-1", quote_id: "q-900", invoice_kind: "prepayment", status: "paid", title: "Deposit", invoice_number: "INV-900", public_token: "tok-900", tax_rate: 0, total: 420, subtotal: 420, amount_paid: 420, created_at: "2026-11-01T00:00:00Z" };

function book(over: Partial<Tables> = {}): Tables {
  return {
    jobs: [{ id: JOB, org_id: ORG, job_number: "J-900", status: "in_progress", customer_id: "cust-1" }],
    organizations: [{ id: ORG, settings: {} }],
    quotes: [{ id: "q-900", org_id: ORG, job_id: JOB, quote_number: "E-900", status: "accepted", deposit_amount: 420, revises_quote_id: null, created_at: "2026-10-01T00:00:00Z" }],
    invoices: [],
    invoice_items: [],
    customer_credits: [],
    payments: [],
    ...over,
  };
}

/** The page's own unbilled-work read, as the page makes it (pilesOn), handed to the seed as a promise. */
const pageWork = () => Promise.resolve({ materials: 130 } as any);

/** The two paths, over the same book, in the same language. */
async function both(client: any) {
  state.client = client;
  state.workReads = 0;
  const door = await readPaymentRequestSeed(JOB);
  const doorReads = state.workReads;
  state.workReads = 0;
  const page = await readPaymentRequestSeedAs(client, { orgId: ORG, lang: asLang(state.lang) }, JOB, pageWork());
  return { door, page, doorReads, pageReads: state.workReads };
}

beforeEach(() => {
  writes = [];
  db = book();
  state.lang = "en";
  state.orgId = ORG;
  state.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
});

describe("the page's seed is the door's seed", () => {
  for (const lang of ["en", "es"]) {
    it(`no payment request on the job (${lang})`, async () => {
      state.lang = lang;
      const { door, page } = await both(fakeDb(db, { org: ORG, writes, seq: { n: 100 } }));
      expect(door.ok).toBe(true);
      expect(page).toEqual(door);
      expect(page.ok && page.requests).toEqual([]);
    });

    it(`a paid deposit request (${lang})`, async () => {
      state.lang = lang;
      db = book({
        invoices: [PAID_REQUEST],
        invoice_items: [{ id: "l-900", org_id: ORG, invoice_id: "inv-900", description: "Deposit", quantity: 1, unit_price: 420, line_total: 420, import_source: "prepayment", prepaid_invoice_id: null, sort_order: 0 }],
      });
      const { door, page } = await both(fakeDb(db, { org: ORG, writes, seq: { n: 100 } }));
      expect(door.ok && door.requests.length).toBe(1);
      expect(page).toEqual(door);
    });

    it(`a refusal: the job is not in the company (${lang})`, async () => {
      state.lang = lang;
      db = book({ jobs: [] });
      const { door, page } = await both(fakeDb(db, { org: ORG, writes, seq: { n: 100 } }));
      expect(door.ok).toBe(false);
      expect(page).toEqual(door);
    });

    it(`a failed read is said, never an empty card (${lang})`, async () => {
      state.lang = lang;
      const { door, page } = await both(failingReads(fakeDb(db, { org: ORG, writes, seq: { n: 100 } }), "quotes"));
      expect(door).toMatchObject({ ok: false });
      expect(page).toEqual(door);
    });
  }

  it("no company: the same refusal from both", async () => {
    state.orgId = null;
    state.client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    const door = await readPaymentRequestSeed(JOB);
    const page = await readPaymentRequestSeedAs(state.client, { orgId: null, lang: "en" }, JOB, pageWork());
    expect(door.ok).toBe(false);
    expect(page).toEqual(door);
  });
});

describe("the seed does not repeat what the page holds", () => {
  it("the page's own unbilled work is used: the seed reads it no second time", async () => {
    const { doorReads, pageReads } = await both(fakeDb(db, { org: ORG, writes, seq: { n: 100 } }));
    expect(doorReads).toBe(1);
    expect(pageReads).toBe(0);
  });

  it("a page that did not read it (or whose read failed, null) has the seed read it, as the door does", async () => {
    state.workReads = 0;
    const client = fakeDb(db, { org: ORG, writes, seq: { n: 100 } });
    const none = await readPaymentRequestSeedAs(client, { orgId: ORG, lang: "en" }, JOB, Promise.resolve(null));
    expect(state.workReads).toBe(1);
    const rejected = await readPaymentRequestSeedAs(client, { orgId: ORG, lang: "en" }, JOB, Promise.reject(new Error("timeout")));
    expect(state.workReads).toBe(2);
    expect(none).toEqual(rejected);
    expect(none.ok && none.materials.unbilled).toBe(130);
  });
});

describe("where the page starts it", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
  const seedFile = readFileSync(join(process.cwd(), "src/lib/payment-request-seed.ts"), "utf8");

  it("the page reads the inner reader, never the office door, and hands it its own unbilled work", () => {
    expect(page).not.toContain("readPaymentRequestSeed(");
    expect(page).toMatch(/readPaymentRequestSeedAs\(supabase, \{ orgId: \(j\.org_id as string \| null\) \?\? null, lang: asLang\(lang\) \}, j\.id, unbilledP\)/);
  });

  it("the seed and the money read start before the third wave and are awaited where they are used", () => {
    const third = page.indexOf("{ data: canonicalItems },");
    expect(third).toBeGreaterThan(0);
    for (const started of ["const unbilledP = pilesOn", "const billsReadP = billableWanted || partWanted", "const requestSeedP = viewerIsStaff"]) {
      const at = page.indexOf(started);
      expect(at, started).toBeGreaterThan(0);
      expect(at, started).toBeLessThan(third);
    }
    expect(page).toContain("const billsRead = await billsReadP;");
    expect(page).toContain("const requestSeed = await requestSeedP;");
    expect(page).not.toMatch(/\?\s*await supabase\s*\.from\("invoices"\)/);
  });

  it("the inner reader is no public endpoint", () => {
    expect(seedFile).not.toMatch(/^["']use server["']/m);
  });
});
