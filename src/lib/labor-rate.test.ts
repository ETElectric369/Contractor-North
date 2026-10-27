import { describe, it, expect } from "vitest";
import { laborRateFor, laborRateFromWords } from "@/lib/pricing/labor-rate";
import { computeJobLaborBilling } from "@/lib/labor-billing";

/**
 * ONE LABOR-RATE RULE, TWO DOORS (cn-v1131). An hour somebody WORKED (computeJobLaborBilling) and an
 * hour he is QUOTING (the estimate's labor rows) price through the same function, so the owner's
 * own hour can no longer bill at his Team rate while the estimate quotes the Settings default. This
 * pins the billing line's rate to laborRateFor's answer on every combination of person / level /
 * default present or absent, the person above and below the level — and the line's own words for
 * where the rate came from ("bill_rate" for a person: the importer and the editor read them).
 */
const entry = (bill_rate: number | null, hours = 2) => ({
  id: `e-${bill_rate ?? "none"}`,
  clock_in: "2026-10-20T08:00:00Z",
  clock_out: new Date(Date.parse("2026-10-20T08:00:00Z") + hours * 3_600_000).toISOString(),
  lunch_minutes: 0,
  job_code: "SVC",
  profiles: { id: "p-1", full_name: "Catbird", bill_rate },
});

const combos: Array<{ person: number | null; level: number | null; def: number }> = [];
for (const person of [null, 0, 95, 150]) for (const level of [null, 0, 125]) for (const def of [0, 145]) combos.push({ person, level, def });

describe("computeJobLaborBilling prices every line at laborRateFor's answer", () => {
  it.each(combos)("person $person, level $level, default $def", ({ person, level, def }) => {
    const { lines } = computeJobLaborBilling([entry(person)], def, level);
    const one = laborRateFor({ personRate: person, levelRate: level, orgDefault: def });
    expect(lines).toHaveLength(1);
    expect(lines[0].rate).toBe(one.rate);
    expect(lines[0].rateFrom).toBe(one.from === "person" ? "bill_rate" : one.from);
    expect(lines[0].amount).toBe(Math.round(2 * one.rate * 100) / 100);
  });

  it("the ladder, spelled out: the person held under the level, else the level, else the default, else nothing", () => {
    expect(laborRateFor({ personRate: 150, levelRate: 125, orgDefault: 145 })).toEqual({ rate: 125, from: "person" }); // above the level: capped
    expect(laborRateFor({ personRate: 95, levelRate: 125, orgDefault: 145 })).toEqual({ rate: 95, from: "person" }); // below it: their own
    expect(laborRateFor({ personRate: 95, levelRate: null, orgDefault: 145 })).toEqual({ rate: 95, from: "person" });
    expect(laborRateFor({ levelRate: 125, orgDefault: 145 })).toEqual({ rate: 125, from: "level" });
    expect(laborRateFor({ orgDefault: 145 })).toEqual({ rate: 145, from: "default" });
    expect(laborRateFor({ personRate: "150", levelRate: "", orgDefault: "145" })).toEqual({ rate: 150, from: "person" }); // strings, as the DB hands them
    expect(laborRateFor({})).toEqual({ rate: 0, from: "none" });
    expect(laborRateFor({ personRate: -5, levelRate: 0, orgDefault: "abc" })).toEqual({ rate: 0, from: "none" });
  });

  it("the words beside the figure", () => {
    expect(laborRateFromWords("person", "Catbird")).toBe("Catbird's rate");
    expect(laborRateFromWords("person")).toBe("their rate");
    expect(laborRateFromWords("level")).toBe("the customer's level");
    expect(laborRateFromWords("default")).toBe("company default");
    expect(laborRateFromWords("none")).toBe("no rate set");
  });
});
