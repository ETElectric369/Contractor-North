import { describe, it, expect } from "vitest";
import { setupSteps, nextStep, setupProgress, type SetupFacts } from "./setup-steps";

/**
 * THE COLD START, from the day it actually bit. Andrew Cohen signed up as the first outside
 * tenant and landed on an empty My Day. Inside a minute the weather widget threw (no address on a
 * new org) and his inspection page had no questions on it (the seed makes job codes but no
 * inspection sheet). Neither failure announces itself — you just see a broken widget and an empty
 * form and decide the software is thin.
 */

const BRAND_NEW: SetupFacts = {
  fullName: "Andrew Cohen", // signup captured this
  tradeLabel: null,
  city: null,
  serviceArea: null,
  defaultLaborRate: null,
  inspectionSheets: 0,
  customers: 0,
};

describe("a brand-new company", () => {
  it("is asked for its trade FIRST", () => {
    // Trade is first because one answer lights up three dead surfaces at once: job codes, the
    // inspector's questions, and what the estimator thinks it is pricing.
    expect(nextStep(BRAND_NEW)?.key).toBe("identity");
  });

  it("has nothing done", () => {
    expect(setupProgress(BRAND_NEW)).toEqual({ done: 0, total: 4, complete: false });
  });

  it("gives a sentence to SAY, not a field to fill", () => {
    const step = nextStep(BRAND_NEW)!;
    expect(step.say).toBe("My name is ___ and I'm a ___");
    expect(step.because).toContain("walk-through questions");
  });
});

describe("the trade step is not done until the questions exist", () => {
  it("a name and a trade label alone are NOT enough", () => {
    // This is the exact hole: Vivian Builders got job codes seeded and no inspection sheet, so a
    // trade label would have marked the step complete while the inspector still had no questions.
    const named = { ...BRAND_NEW, tradeLabel: "general contractor", inspectionSheets: 0 };
    expect(setupSteps(named).find((s) => s.key === "identity")!.done).toBe(false);
    expect(nextStep(named)?.key).toBe("identity");
  });

  it("done only once the sheet is actually there", () => {
    const ready = { ...BRAND_NEW, tradeLabel: "general contractor", inspectionSheets: 1 };
    expect(setupSteps(ready).find((s) => s.key === "identity")!.done).toBe(true);
    expect(nextStep(ready)?.key).toBe("where");
  });
});

describe("the rest of the order", () => {
  const withTrade: SetupFacts = { ...BRAND_NEW, tradeLabel: "electrician", inspectionSheets: 1 };

  it("location next — it is what stops the weather widget throwing", () => {
    expect(nextStep(withTrade)?.key).toBe("where");
  });

  it("either a city OR a service area satisfies it", () => {
    expect(nextStep({ ...withTrade, city: "Truckee" })?.key).toBe("rate");
    expect(nextStep({ ...withTrade, serviceArea: "North Tahoe" })?.key).toBe("rate");
  });

  it("a zero rate is not a rate", () => {
    const at = { ...withTrade, city: "Truckee", defaultLaborRate: 0 };
    expect(nextStep(at)?.key).toBe("rate");
    expect(nextStep({ ...at, defaultLaborRate: 125 })?.key).toBe("first_customer");
  });

  it("and finally someone to work for, because an empty app shows you nothing", () => {
    const almost = { ...withTrade, city: "Truckee", defaultLaborRate: 125 };
    expect(nextStep(almost)?.key).toBe("first_customer");
    expect(nextStep({ ...almost, customers: 1 })).toBeNull();
    expect(setupProgress({ ...almost, customers: 1 }).complete).toBe(true);
  });
});

describe("it never becomes a gate", () => {
  it("always returns every step, so the card can show progress rather than a shrinking list", () => {
    expect(setupSteps(BRAND_NEW)).toHaveLength(4);
    expect(setupSteps({ ...BRAND_NEW, customers: 9 })).toHaveLength(4);
  });

  it("a skipped step does not block a later one from being marked done", () => {
    // Somebody who ignores setup and just adds a customer gets credit for it.
    const skipped = { ...BRAND_NEW, customers: 3 };
    expect(setupSteps(skipped).find((s) => s.key === "first_customer")!.done).toBe(true);
    expect(setupProgress(skipped).done).toBe(1);
  });

  it("an established company sees nothing left to do", () => {
    expect(
      nextStep({
        fullName: "Erik Taylor",
        tradeLabel: "electrical contractor",
        city: "Truckee",
        serviceArea: "Truckee & Tahoe",
        defaultLaborRate: 125,
        inspectionSheets: 1,
        customers: 22,
      }),
    ).toBeNull();
  });
});
