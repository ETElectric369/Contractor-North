import { describe, it, expect } from "vitest";
import { answersWithoutPrices, isMissingRpc, keepStoredPhotos, sheetsWithoutMoney, walkthroughAccess, withoutMoney } from "./walkthrough-access";

/**
 * "crew leader yes tech no" (Erik, 2026-09-26), as the page decides it. The database decides it again
 * (save_walkthrough_capture, 0356; its DB suite is walkthrough-crew-lead.integration.test.ts).
 */
describe("who fills in the walk-through", () => {
  const base = { isStaff: false, crewLead: false, onThisVisit: false, rpcReady: true };

  it("the office, always, whatever else is true", () => {
    expect(walkthroughAccess({ ...base, isStaff: true })).toBe("office");
    expect(walkthroughAccess({ ...base, isStaff: true, rpcReady: false })).toBe("office");
  });

  it("a crew lead on this visit, once the database has the door", () => {
    expect(walkthroughAccess({ ...base, crewLead: true, onThisVisit: true })).toBe("crewLead");
  });

  it("everyone else reads: a plain tech, a crew lead on someone else's visit, a crew lead before 0356", () => {
    expect(walkthroughAccess({ ...base, onThisVisit: true })).toBe("view");
    expect(walkthroughAccess({ ...base, crewLead: true })).toBe("view");
    expect(walkthroughAccess({ ...base, crewLead: true, onThisVisit: true, rpcReady: false })).toBe("view");
  });

  it("the missing function reads as missing, from PostgREST or Postgres; a refusal does not", () => {
    expect(isMissingRpc({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpc({ code: "42883" })).toBe(true);
    expect(isMissingRpc({ code: "42501" })).toBe(false);
    expect(isMissingRpc(null)).toBe(false);
  });
});

describe("the answers a crew lead's page carries have no price in them", () => {
  it("drops `price` from a scope pick list and keeps what was picked and how many", () => {
    const stored = {
      work: "Remodel",
      scope: [
        { code: "R1", qty: 2, price: 500 },
        { code: "R2", qty: 1, price: 0 },
      ],
      rooms: ["Kitchen", "Bath"],
      count: 3,
      done: true,
      obj: { price: 9, note: "x" },
      none: null,
    };
    const out = answersWithoutPrices(stored);
    expect(out).toEqual({
      work: "Remodel",
      scope: [
        { code: "R1", qty: 2 },
        { code: "R2", qty: 1 },
      ],
      rooms: ["Kitchen", "Bath"],
      count: 3,
      done: true,
      obj: { note: "x" },
      none: null,
    });
    expect(JSON.stringify(out)).not.toMatch(/price|500/);
    // The stored answers are not touched: the office's page reads the same object.
    expect(stored.scope[0].price).toBe(500);
  });

  it("is safe on nothing", () => {
    expect(answersWithoutPrices(null)).toEqual({});
    expect(answersWithoutPrices(undefined)).toEqual({});
  });
});

describe("a crew lead adds photos and never takes one off", () => {
  it("keeps every stored photo, in place, and appends the new ones", () => {
    expect(keepStoredPhotos(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    // His page dropped one (or never had the office's newest): it is kept.
    expect(keepStoredPhotos(["a", "b", "office-new"], ["a", "c"])).toEqual(["a", "b", "office-new", "c"]);
    expect(keepStoredPhotos([], ["x"])).toEqual(["x"]);
  });
});

describe("the sheets, with no money in them, for anyone who isn't the office", () => {
  it("a why line keeps its words and loses its dollar figures", () => {
    expect(withoutMoney("Decides breaker or service change — Zinsco or FPE turns a $400 circuit into a panel swap.")).toBe(
      "Decides breaker or service change — Zinsco or FPE turns a circuit into a panel swap.",
    );
    expect(withoutMoney("Run length × $4.50/ft, plus $1,250.00 for the can.")).toBe("Run length ×, plus for the can.");
    expect(withoutMoney("$2k minimum")).toBe("minimum");
    expect(withoutMoney("Labor at $90 per hr")).toBe("Labor at");
    expect(withoutMoney("How many circuits")).toBe("How many circuits");
  });

  it("every note goes, every why is stripped (or dropped when nothing is left), and nothing else moves", () => {
    const sheets = [
      {
        id: "s1",
        name: "Electrical walk-through",
        schema: [],
        playbook: {
          needs: [
            {
              key: "panel_condition",
              label: "Panel",
              ask: "What shape is the panel in?",
              slot: { type: "select", options: ["Good", "Zinsco", "FPE"] },
              why: "Decides breaker or service change — Zinsco or FPE turns a $400 circuit into a panel swap.",
              note: "A $400 circuit becomes a $3,500 panel swap; never price it before the cover is off.",
            },
            { key: "scopes", label: "Scopes", ask: "Which?", slot: { type: "scopes" }, why: "$0.00", note: "The R codes sit at $0.00 in his price list on purpose" },
            { key: "run", label: "Run", ask: "How far?", slot: { type: "number", unit: "ft" }, why: "Wire run" },
          ],
        },
      },
      { id: "s2", name: "Converted checklist", schema: [{ key: "a", label: "A", type: "text" }], playbook: null },
    ];
    const out = sheetsWithoutMoney(sheets);
    expect(JSON.stringify(out)).not.toMatch(/\$|400|3,500|0\.00|"note"/);
    const needs = (out[0].playbook as { needs: Record<string, unknown>[] }).needs;
    expect(needs.map((n) => n.key)).toEqual(["panel_condition", "scopes", "run"]);
    expect(needs[0].why).toBe("Decides breaker or service change — Zinsco or FPE turns a circuit into a panel swap.");
    expect(needs[0].ask).toBe("What shape is the panel in?");
    expect(needs[0].slot).toEqual({ type: "select", options: ["Good", "Zinsco", "FPE"] });
    expect(needs[1]).not.toHaveProperty("why");
    expect(needs[2].why).toBe("Wire run");
    // A sheet with no written playbook goes as it is (it carries no why or note), still with no playbook.
    expect(out[1]).toBe(sheets[1]);
    // The office's rows are not touched.
    expect(sheets[0].playbook?.needs[0].note).toMatch(/\$400/);
  });
});
