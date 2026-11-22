import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NO DEPOSIT DRAW FROM NEW INVOICE (cn-v1177 seams). The owner's pick: "the old deposit door becomes the
 * new payment". A deposit DRAW (createProgressInvoice kind "deposit") locked a time and material job out
 * of a standard invoice; every deposit door in the New Invoice button now opens the Request a Payment
 * form on Deposit: the link, the sheet's own Deposit choice and ?invoice=deposit. And the job card nets
 * the same money Finish counts. Stand-ins: J-900.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/jobs/j-1", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../actions", () => ({ createInvoiceForJob: vi.fn() }));
vi.mock("../../recurring/actions", () => ({ createProgressInvoice: vi.fn() }));
vi.mock("../../billing/actions", () => ({ createProgressReportInvoice: vi.fn(), requestNextPayment: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/components/request-payment", () => ({ RequestPaymentSheet: () => null }));

const { sheetChoicesFor } = await import("./new-invoice-button");

const SRC = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/new-invoice-button.tsx"), "utf8");
const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");

describe("the New Invoice sheet makes no deposit", () => {
  it("the sheet never starts on Deposit, a deposit preset starts on the first bill, and a sheet whose only choice is Deposit is the form", () => {
    const fixed = { billingType: "fixed", estimate: 12400, hasEstimate: true, wholeEstimate: 12400 };
    expect(sheetChoicesFor(fixed, null)).toMatchObject({ choices: ["deposit", "part", "whole"], initial: "part" });
    expect(sheetChoicesFor(fixed, "deposit").initial).toBe("part");
    // A job billed with draws and no estimate: lib/actuals-draw offers Deposit alone.
    expect(sheetChoicesFor({ billingType: "fixed", estimate: 0, hasEstimate: false, drawBilled: true }, null)).toMatchObject({ choices: ["deposit"], initial: null });
  });
  it("nothing in the button makes a deposit draw: the choice, the preset and the link open the Request a Payment form", () => {
    expect(SRC).not.toMatch(/kind: "deposit"/);
    expect(SRC).not.toContain("Deposit started as a draft");
    expect(SRC).not.toContain("depositAmt");
    expect(SRC).not.toMatch(/\bdepositFor\(|deposit-rule/);
    expect(SRC).toMatch(/if \(c === "deposit"\) return p\.onDeposit\(\);/);
    expect(SRC).toMatch(/if \(preset === "deposit"\) return openDepositForm\(\);/);
    expect(SRC).toMatch(/if \(sheetChoicesFor\(p, preset\)\.initial === null\) return openDepositForm\(\);/);
    expect(SRC).toContain('purpose="deposit"');
    // The hand-off: the form opens first, the sheet closes in the next commit.
    expect(SRC).toMatch(/onDeposit=\{\(\) => openDepositForm\(true\)\}/);
    expect(SRC).toMatch(/if \(!sheetHandingOff\) return;\n\s+setSheetHandingOff\(false\);\n\s+setSheet\(\{ open: false/);
    // Part of the Estimate keeps its draws (createProgressInvoice stays for those and the schedule card).
    expect(SRC).toMatch(/createProgressInvoice\(p\.jobId, \{ kind: last \? "final" : "progress"/);
  });
});

describe("the job card and Finish decide by the DRAW pool only (cn-v1177, re-pinned on purpose after skeptic #80)", () => {
  it("the Not Billed Yet card, its door and New Invoice get lumpToNet (the draw money) and never the requests; the header's Get Paid reads its own paid-ahead figure (cn-v1179)", () => {
    // A payment request never "covers" work: the bill is built and the sync takes the request off it.
    expect(PAGE).not.toContain("jobLump");
    expect(PAGE.match(/lumpToNet=\{lumpToNet\}/g)).toHaveLength(3);
    expect(PAGE).toMatch(/\n\s+lumpToNet,\n\s+\/\/ cn-v1177: the pay-door facts/);
    // cn-v1179, re-pinned on purpose: the page no longer hands the header's Get Paid a paid-ahead figure.
    // The one it had was the requests' leftToNet (money only ASKED); the sheet reads the true one itself.
    expect(PAGE).not.toMatch(/paidAhead/);
    expect(PAGE).toMatch(/textReady=\{payDoor\.textReady\}\n\s+\/>/);
  });
});

describe("the pay-door facts: one rule in one function", () => {
  it("the job page calls lib/payment-request payDoorFacts, reads its four columns, and keeps no second copy of the formula", async () => {
    const { PAY_DOOR_ORG_COLUMNS } = await import("@/lib/payment-request");
    expect(PAGE).toMatch(/const payDoor = payDoorFacts\(org as Parameters<typeof payDoorFacts>\[0\]\);/);
    const orgSelect = PAGE.match(/from\("organizations"\)\.select\("([^"]+)"\)/)?.[1] ?? "";
    for (const col of PAY_DOOR_ORG_COLUMNS.split(",").map((c) => c.trim())) expect(orgSelect.split(",").map((c) => c.trim())).toContain(col);
    for (const copy of ["canAcceptPayments(", "connectStateFromOrg(", "smsReadiness(", "venmo_handle", ".payment_methods"]) expect(PAGE, copy).not.toContain(copy);
  });
});
