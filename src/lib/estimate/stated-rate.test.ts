import { describe, it, expect } from "vitest";
import { statedLaborRate } from "./stated-rate";
import { mapEstimatorLine } from "./line-map";

describe("the rate he actually said", () => {
  it("reads Erik's own paragraph — the one that came back at his company default instead", () => {
    // Verbatim from the estimate he corrected by hand. Note it also contains "200 amps each",
    // "twelve 20 amp" and "two full days", which is exactly why the pattern needs a context guard.
    const scope =
      "2 sub panels going to be installed next to each other, 200 amps each, feed wires are already " +
      "in place, each panel will get twelve 20 amp single pole breakers and 5 single pole 15 amp " +
      "breakers, 2 guys will take us two full days at a 2 man labor rate of 200 per hour";
    expect(statedLaborRate(scope)).toBe(200);
  });

  it.each([
    ["at $185/hr", 185],
    ["labor rate of 200 per hour", 200],
    ["bill it at 95 an hour", 95],
    ["our hourly is 132.50", null], // no hr/hour token after the number — left alone on purpose
    ["$1,250 per hour", 1250],
    ["charge 75/hr for the helper", 75],
  ])("%s", (text, expected) => {
    expect(statedLaborRate(text)).toBe(expected);
  });

  it("REFUSES a measurement that merely sits next to the word hour", () => {
    // The failure that would matter: a number lifted out of the work and billed as a rate.
    expect(statedLaborRate("24 hour emergency callout, 200 amp service")).toBeNull();
    expect(statedLaborRate("allow 3 hours for the trip")).toBeNull();
    expect(statedLaborRate("twelve 20 amp single pole breakers")).toBeNull();
  });

  it("refuses a number that is not a plausible rate at all", () => {
    expect(statedLaborRate("labor rate of 0 per hour")).toBeNull();
    expect(statedLaborRate("$99999 per hour")).toBeNull();
  });

  it("is quiet on anything that is not a string", () => {
    for (const v of [null, undefined, 42, {}, []]) expect(statedLaborRate(v)).toBeNull();
  });
});

describe("which rate reaches the line", () => {
  const ctx = { rate: 145, byCode: new Map(), levelPct: null, orgDefaultPct: 25 };
  const labor = { kind: "labor", description: "Install and terminate", quantity: 16, unit_cost: 145 };

  it("HIS STATED RATE BEATS THE COMPANY DEFAULT — the whole bug", () => {
    const line = mapEstimatorLine(labor as never, { ...ctx, statedRate: 200 });
    expect(line.unit_price).toBe(200);
    expect(line.quantity * line.unit_price).toBe(3200);
  });

  it("and the company rate still governs when he said nothing", () => {
    expect(mapEstimatorLine(labor as never, { ...ctx, statedRate: null }).unit_price).toBe(145);
  });

  it("the model's echo is still only a last resort, and still says so", () => {
    const line = mapEstimatorLine(labor as never, { ...ctx, rate: 0, statedRate: null });
    expect(line.unit_price).toBe(145);
    expect(line.flag).toMatch(/no company labor rate/i);
  });

  it("a stated rate carries no warning — it is his own number", () => {
    expect(mapEstimatorLine(labor as never, { ...ctx, rate: 0, statedRate: 200 }).flag).toBeUndefined();
  });
});

describe("statedLaborRate — audit 7: policies are not prices", () => {
  it("a billing minimum is not a rate, and the real rate later in the text still wins", () => {
    expect(statedLaborRate("We bill a 4 hour minimum for service calls. Replace 6 outlets in kitchen.")).toBeNull();
    expect(statedLaborRate("We bill a 4 hour minimum. Our rate is $185/hr.")).toBe(185);
  });
  it("increments, response windows and callouts are policies too", () => {
    expect(statedLaborRate("billed in 1 hour increments")).toBeNull();
    expect(statedLaborRate("24 hour response, bill on completion")).toBeNull();
    expect(statedLaborRate("charge a 2 hour callout")).toBeNull();
  });
  it("a bare $-prefixed rate needs no context words", () => {
    expect(statedLaborRate("Panel swap at $185/hr, two days")).toBe(185);
  });
  it("sub-$25 'rates' are hours misread, not prices", () => {
    expect(statedLaborRate("we bill 4 per hour")).toBeNull();
  });
});

describe("statedLaborRate — two rates is a decision, not a dictation", () => {
  it("two different stated rates stand down to the company default", () => {
    expect(statedLaborRate("journeyman at $120/hr and foreman billed at $185/hr")).toBeNull();
  });
  it("the same rate said twice is still one instruction", () => {
    expect(statedLaborRate("billed at $145/hr — again, rate is $145/hr")).toBe(145);
  });
});
