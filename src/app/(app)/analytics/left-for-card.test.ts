import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ setOfficeSeesOwnerMoney: vi.fn() }));

import { LeftForCard } from "./left-for-card";
import { computeOwnerMoney, ownerMoneyWindow, type OwnerMoneyInputs } from "@/lib/analytics/owner-money";
import { ownerRegister } from "@/lib/owner-draw";

/**
 * THE OWNER'S DRAW CARD WITH FUEL ON ITS OWN LINE (Erik, 2026-09-27: "lets make fuel stand out from
 * business costs"). Made-up figures only.
 */
const TZ = "America/Los_Angeles";
const TODAY = "2026-09-24";
const noJob = (id: string, amount: number, category: string) => ({ id, job_id: null, amount, bill_date: "2026-08-12", created_at: "2026-08-12T18:00:00Z", category, status: "paid" });
const inputs: OwnerMoneyInputs = {
  payments: [{ amount: 1000, paid_at: "2026-08-20T18:00:00Z", processor_fee: null, stripe_payment_intent: null, invoices: { status: "paid" } }],
  refunds: [],
  bills: [noJob("f1", 150.25, "Fuel"), noJob("a1", 80, "Auto"), noJob("o1", 20, "Other")],
  pos: [],
  pettyCash: [],
  entries: [],
  runs: [],
  payPayments: [],
  creditMemos: [],
  people: new Map(),
  recordsStart: "2026-06-01",
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the Owner's Draw card: Fuel stands out", () => {
  const money = computeOwnerMoney(inputs, ownerMoneyWindow("2026-08", TODAY), TZ, TODAY);
  const html = renderToStaticMarkup(
    createElement(LeftForCard, {
      money,
      problem: null,
      voice: ownerRegister([{ id: "owner-1", name: "Pat Owner" }], "owner-1"),
      windowKey: "2026-08",
      viewerIsOwner: false,
      officeSees: true,
    }),
  );
  const t = text(html);

  it("says Fuel on its own line, in the Fuel colour, and Business Costs without it", () => {
    expect(money.totals.fuel).toBe(150.25);
    expect(money.totals.businessCostsTotal).toBe(100);
    expect(t).toMatch(/Fuel\s+-?−?\$150\.25/);
    expect(t).toMatch(/Business Costs\s+-?−?\$100\.00/);
    expect(html).toContain("bg-pink-800");
  });

  it("lists Auto among the Business Costs buckets, and never Fuel there too", () => {
    const inside = t.slice(t.indexOf("Business Costs"));
    expect(inside).toContain("Auto $80.00");
    expect(inside).toContain("Other $20.00");
    expect(inside).not.toMatch(/\bFuel\b/);
    expect(t).not.toContain("Gas & Truck");
  });

  it("the draw is the same money: received less Fuel less Business Costs", () => {
    expect(money.totals.left).toBe(749.75);
    expect(t).toContain("$749.75");
  });
});
