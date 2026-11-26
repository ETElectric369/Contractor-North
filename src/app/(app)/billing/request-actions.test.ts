import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE OFFICE'S REQUEST A PAYMENT DOOR (cn-v1177) says each refusal of lib/payment-request in the
 * signed-in person's language, and hands back the request it made (or the one that already stood).
 */
const state = vi.hoisted(() => ({ lang: "en", made: null as any, args: null as any }));

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: {}, userId: "user-1", orgId: "org-larkspur", role: "owner" })) }));
vi.mock("@/lib/lang-of", () => ({ callerLang: vi.fn(async () => state.lang) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/unbilled-work", () => ({ unbilledWorkForJob: vi.fn(), customerUnbilled: vi.fn() }));
vi.mock("@/lib/payment-request", () => ({
  createPaymentRequest: vi.fn(async (_db: unknown, args: unknown) => {
    state.args = args;
    return state.made;
  }),
  readPrepaymentStates: vi.fn(async () => []),
  liveRequestForQuote: vi.fn(async () => null),
  requestRefOf: vi.fn(),
  payDoorFacts: vi.fn(),
  PAY_DOOR_ORG_COLUMNS: "settings, stripe_account_id, stripe_account_status, stripe_charges_enabled",
}));

import { requestPayment } from "./request-actions";
import { dict } from "@/lib/i18n";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KEYS = ["su_req_noJob", "su_req_jobOver", "su_req_noCustomer", "su_req_badAmount", "su_req_badQuote", "su_req_failed", "su_req_readFailed"];

beforeEach(() => {
  state.lang = "en";
  state.made = null;
  state.args = null;
});

describe("requestPayment", () => {
  it("makes the request in the caller's company, by the caller, and hands it back", async () => {
    const request = { id: "r1", number: "INV-900", token: "t", label: "Deposit", amount: 420, balance: 420, status: "sent" };
    state.made = { ok: true, request, existing: false };
    expect(await requestPayment({ jobId: "job-900", purpose: "deposit", amount: 420, quoteId: "q-900" })).toEqual({ ok: true, request, existing: false });
    expect(state.args).toEqual({ orgId: "org-larkspur", jobId: "job-900", purpose: "deposit", amount: 420, label: null, quoteId: "q-900", createdBy: "user-1" });
  });

  const table: [string, string, string][] = [
    ["job_over", "su_req_jobOver", "finished or cancelled"],
    ["no_customer", "su_req_noCustomer", "no customer"],
    ["bad_amount", "su_req_badAmount", "above $0"],
    ["bad_quote", "su_req_badQuote", "accepted estimate"],
    ["no_job", "su_req_noJob", "isn't on this company's books"],
    ["failed", "su_req_failed", "nothing was charged"],
  ];
  for (const [why, key, words] of table) {
    it(`says ${why} in the person's language`, async () => {
      state.made = { ok: false, why };
      const en = await requestPayment({ jobId: "job-900", purpose: "materials", amount: 10 });
      expect(en).toEqual({ ok: false, error: dict("en")[key] });
      expect(String((en as { error: string }).error)).toContain(words);
      state.lang = "es";
      const es = await requestPayment({ jobId: "job-900", purpose: "materials", amount: 10 });
      expect(es).toEqual({ ok: false, error: dict("es")[key] });
      expect(dict("es")[key]).not.toBe(dict("en")[key]);
    });
  }

  it("every refusal has its words in both languages, and none is a clickable", () => {
    for (const k of KEYS) {
      expect(dict("en")[k], k).toBeTruthy();
      expect(dict("es")[k], k).toBeTruthy();
      expect(k.startsWith("su_btn_")).toBe(false);
    }
  });
});

describe("the seed carries the pay door", () => {
  it("fills payDoor from the company row through lib/payment-request payDoorFacts, never a second formula", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/request-actions.ts"), "utf8");
    // The seed's reading lives in lib/payment-request-seed since cn-v1190 (the door checks its caller,
    // then reads through it; the job page reads it directly with what it already holds).
    const seed = readFileSync(join(process.cwd(), "src/lib/payment-request-seed.ts"), "utf8");
    expect(seed).toContain('supabase.from("organizations").select(PAY_DOOR_ORG_COLUMNS).eq("id", orgId).maybeSingle()');
    expect(seed).toContain("...(org ? { payDoor: payDoorFacts(org as Parameters<typeof payDoorFacts>[0]) } : {}),");
    expect(src).toContain("return readPaymentRequestSeedAs(supabase, { orgId, lang: await callerLang(supabase, userId) }, jobId);");
    expect(src).toContain("payDoor?: PayDoorFacts;");
    expect(src).not.toMatch(/from "@\/components\//); // a "use server" file imports no client file
  });
});
