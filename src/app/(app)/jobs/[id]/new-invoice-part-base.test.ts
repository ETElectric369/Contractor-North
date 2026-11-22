import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { everythingBillable } from "@/lib/everything-billable";

/**
 * PART OF THE ESTIMATE TAKES A PART OF THE TILE'S OWN FIGURE (cn-v1181). The New Invoice sheet used to
 * subtract on its own (the estimate's total less what went out), so on a job whose estimate was billed
 * and an approved add was left, "Percent of what is left" was a part of nothing the estimate still had,
 * and on a taxed estimate billed with no tax it offered the tax as a part. Now the sheet's base is
 * Everything Billable's partLeftGross, handed by the page to BOTH New Invoice buttons (the tile's and the
 * Invoices tab's), so the two sheets and the tile say one Left. Stand-ins only: Q-900, INV-900.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../../billing/actions", () => ({}));
vi.mock("../../recurring/actions", () => ({ createProgressInvoice: vi.fn() }));

import { partBaseFor, partRequestsWords } from "./new-invoice-button";

const q = { quote_number: "Q-900", status: "accepted", created_at: "2026-10-01T00:00:00Z", subtotal: 10000, tax: 800, total: 10800 };

describe("partBaseFor", () => {
  it("the page's figure wins over the sheet's own subtraction", () => {
    // A taxed estimate billed with no tax: nothing of it is left to take a part of (the old base said $800).
    const e = everythingBillable({ quotes: [q], invoices: [{ id: "i1", status: "sent", invoice_kind: "standard", subtotal: 10000, tax: 0, total: 10000 }] });
    expect(e?.partLeftGross).toBe(0);
    expect(partBaseFor({ estimate: 10800, billed: 10000, partLeft: e?.partLeftGross })).toBe(0);
    expect(partBaseFor({ estimate: 10800, billed: 10000 })).toBe(800);
  });

  it("no figure from the page (a payment schedule, a time and material job): the sheet's own subtraction, as before; unread billed is null", () => {
    expect(partBaseFor({ estimate: 5000, billed: 2000, partLeft: null })).toBe(3000);
    expect(partBaseFor({ estimate: 5000, billed: null })).toBeNull();
  });

  it("the page hands the same figure to both New Invoice buttons (newInvoiceProps)", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/partLeft: billable\.partLeft,\s+\/\/[^\n]*\n\s+partUnread: billable\.partUnread,/);
    const sheet = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/new-invoice-button.tsx"), "utf8");
    expect(sheet).toMatch(/const left = partBaseFor\(p\);/);
  });
});

describe("money asked ahead comes off the part's bill: the Part choice says so (cn-v1181, lane S)", () => {
  it("one sentence with the amount when a request is still to come off; nothing when none is", () => {
    const e = everythingBillable({
      quotes: [{ ...q, subtotal: 5000, tax: 0, total: 5000 }],
      invoices: [{ id: "i1", status: "paid", invoice_kind: "prepayment", subtotal: 1000, tax: 0, total: 1000 }],
    });
    expect(e?.requestsToComeOff).toBe(1000);
    expect(partRequestsWords(e?.requestsToComeOff)).toBe("$1,000.00 already requested on this job comes off this bill, so its total will be lower than the part.");
    expect(partRequestsWords(0)).toBeNull();
    expect(partRequestsWords(null)).toBeNull();
    expect(partRequestsWords(undefined)).toBeNull();
  });

  it("the page hands it beside partLeft, and the sheet draws it under the percent box only", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/partLeft: billable\.partLeft,[\s\S]{0,400}requestsToComeOff: billable\.requestsToComeOff,/);
    const sheet = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/new-invoice-button.tsx"), "utf8");
    expect(sheet).toMatch(/The Rest\s*<\/button>\s*<\/div>\s*\{partRequestsWords\(p\.requestsToComeOff\) && <p className="text-sm text-slate-500">\{partRequestsWords\(p\.requestsToComeOff\)\}<\/p>\}/);
    expect(sheet.match(/partRequestsWords\(p\./g)).toHaveLength(2);
  });
});

describe("the tile is Everything Billable in the comments of the doors around it (cn-v1181, lane S)", () => {
  it.each(["unbilled-card.tsx", "payment-schedule-card.tsx", "new-invoice-button.tsx"])("%s no longer says Left to Bill", (f) => {
    expect(readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]", f), "utf8")).not.toContain("Left to Bill");
  });
});

describe("cn-v1181 fixer: one decision over the page's reads (skeptic #84, S3 and M2)", async () => {
  const { jobBillableView } = await import("./billable-view");
  const ok = { money: false, quotes: false, changeOrders: false, invoices: false };
  const base = {
    quotes: [{ ...q, subtotal: 10000, tax: 0, total: 10000 }],
    changeOrders: [],
    invoices: [{ id: "i1", status: "sent", invoice_kind: "standard", subtotal: 4000, tax: 0, total: 4000 }],
    billMoney: new Map(),
  };

  it("the tile is unread when ANY read it rests on failed, not only the money read", () => {
    for (const k of ["money", "quotes", "changeOrders", "invoices"] as const) {
      const v = jobBillableView({ ...base, tileWanted: true, partWanted: true, failed: { ...ok, [k]: true } });
      expect(v.tileUnread).toBe(true);
      expect(v.tile).toBeNull();
      // ...and the sheet says Couldn't total, never its own subtraction.
      expect(v.partUnread).toBe(true);
      expect(partBaseFor({ estimate: 10000, billed: 4000, partLeft: v.partLeft, partUnread: v.partUnread })).toBeNull();
    }
  });

  it("a failed invoices read never reads as the whole estimate still to bill", () => {
    const v = jobBillableView({ ...base, invoices: [], tileWanted: true, partWanted: true, failed: { ...ok, invoices: true } });
    expect(v.tile).toBeNull();
    expect(v.partLeft).toBeNull();
  });

  it("where the tile is not drawn (a schedule, a job that bills its work), the sheet still gets the rule's figure", () => {
    const v = jobBillableView({ ...base, tileWanted: false, partWanted: true, failed: ok });
    expect(v.tile).toBeNull();
    expect(v.tileUnread).toBe(false);
    expect(v.partLeft).toBe(6000);
    expect(v.partUnread).toBe(false);
  });

  it("all read: the tile and the sheet say the same Left", () => {
    const v = jobBillableView({ ...base, tileWanted: true, partWanted: true, failed: ok });
    expect(v.tile?.partLeftGross).toBe(6000);
    expect(v.partLeft).toBe(6000);
    expect(v.tileUnread).toBe(false);
  });
});
