import { describe, it, expect } from "vitest";
import { parseInspectionSchema, visibleFields } from "./schema";
import { STARTER_TRADES, starterSchemaJson, starterSheet, starterTradeFor } from "./starter-sheets";

/**
 * These sheets are the difference between a feature and a demo. Nothing in the repo seeded an
 * inspection sheet, so Andrew Cohen's first inspection page had no questions on it at all, and
 * Erik's answer sets read as empty for months because the SHEET was empty — not because he
 * wasn't filling it in.
 */

describe("every starter sheet survives the real parser", () => {
  it.each(STARTER_TRADES)("%s loses no fields to parseInspectionSchema", (trade) => {
    const raw = starterSchemaJson(trade);
    const parsed = parseInspectionSchema(raw);
    // A dropped field is silent — a bad type or a duplicate key just vanishes. Count is the alarm.
    expect(parsed).toHaveLength(raw.length);
  });

  it.each(STARTER_TRADES)("%s has no duplicate keys", (trade) => {
    const keys = starterSheet(trade).fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("THE THESIS: you land on one question, not ten", () => {
  it.each(STARTER_TRADES)("%s opens with EXACTLY one visible field", (trade) => {
    // This is the entire progressive-disclosure argument, asserted. "the inspection page
    // shouldn't start with the panel questions, those should come up if i choose a panel."
    const visible = visibleFields(starterSheet(trade).fields, {});
    expect(visible).toHaveLength(1);
    expect(visible[0].type).toBe("select");
  });

  it.each(STARTER_TRADES)("%s fans out once the router is answered", (trade) => {
    const fields = starterSheet(trade).fields;
    const router = fields[0];
    const firstOption = router.options![0];
    const after = visibleFields(fields, { [router.key]: firstOption });
    expect(after.length).toBeGreaterThan(1);
    // ...but never into a wall. Five controls is the most a person handles on a ladder.
    expect(after.length).toBeLessThanOrEqual(8);
  });

  it.each(STARTER_TRADES)("%s never leaves a branch with nothing but the router", (trade) => {
    // A router option that reveals no questions is a dead end — the person picked the thing
    // that describes their job and the sheet had nothing to ask about it.
    const fields = starterSheet(trade).fields;
    const router = fields[0];
    for (const opt of router.options ?? []) {
      expect(visibleFields(fields, { [router.key]: opt }).length, `${trade} / ${opt}`).toBeGreaterThan(1);
    }
  });
});

describe("no rule can point forward or sideways", () => {
  it.each(STARTER_TRADES)("%s: every showIf.key names a field ABOVE it", (trade) => {
    // A rule pointing at a later field can never be satisfied at the moment it is evaluated,
    // so the question becomes unreachable — worse than a question asked needlessly, because
    // nobody ever learns it exists.
    const fields = starterSheet(trade).fields;
    const seen = new Set<string>();
    for (const f of fields) {
      if (f.showIf) expect(seen.has(f.showIf.key), `${trade}: ${f.key} → ${f.showIf.key}`).toBe(true);
      seen.add(f.key);
    }
  });

  it.each(STARTER_TRADES)("%s: every showIf value is a real option of its router", (trade) => {
    // A typo here ("Service/panel" vs "Service / panel") hides the question forever and looks
    // like nothing at all went wrong.
    const fields = starterSheet(trade).fields;
    const byKey = new Map(fields.map((f) => [f.key, f]));
    for (const f of fields) {
      if (!f.showIf) continue;
      const opts = byKey.get(f.showIf.key)?.options ?? [];
      for (const v of f.showIf.in) expect(opts, `${trade}: ${f.key}`).toContain(v);
    }
  });

  it.each(STARTER_TRADES)("%s has exactly one router (the field nothing depends on a choice for)", (trade) => {
    const fields = starterSheet(trade).fields;
    const unconditionalSelects = fields.filter((f) => !f.showIf && f.type === "select");
    // 'access' is also an unconditional select; the ROUTER is the one every rule points at.
    const routed = new Set(fields.filter((f) => f.showIf).map((f) => f.showIf!.key));
    expect(routed.size).toBe(1);
    expect(unconditionalSelects.map((f) => f.key)).toContain([...routed][0]);
  });
});

describe("a trade label maps to a starter, and never to nothing", () => {
  it("reads what a person actually says out loud", () => {
    expect(starterTradeFor("electrical contractor")).toBe("electrical");
    expect(starterTradeFor("I'm an electrician")).toBe("electrical");
    expect(starterTradeFor("general contractor")).toBe("deck");
    expect(starterTradeFor("I build decks")).toBe("deck");
    expect(starterTradeFor("plumbing and HVAC")).toBe("plumbing");
  });

  it("falls back to generic rather than to an empty sheet", () => {
    // The failure this prevents IS the Andrew Cohen bug: an unrecognised trade must still get
    // questions. A blank inspector reads as a thin product, not a missing template.
    for (const label of ["landscaping", "glazier", "", null, undefined, "   "]) {
      expect(starterTradeFor(label)).toBe("generic");
    }
    expect(starterSheet(starterTradeFor("landscaping")).fields.length).toBeGreaterThan(1);
  });

  it("every trade yields a named, non-empty sheet", () => {
    for (const t of STARTER_TRADES) {
      const s = starterSheet(t);
      expect(s.name.trim()).not.toBe("");
      expect(s.fields.length).toBeGreaterThan(2);
    }
  });
});

describe("the measured flag is set where a kit would size itself", () => {
  it("the deck sheet marks length and width measured", () => {
    // measurementsFromAnswers reads these to compute sqft; unmarked, the estimator re-derives
    // an area it was handed.
    const f = starterSheet("deck").fields;
    expect(f.find((x) => x.key === "length")?.measured).toBe(true);
    expect(f.find((x) => x.key === "width")?.measured).toBe(true);
  });

  it("every number field on every sheet is marked measured", () => {
    // A number nobody measured is a number nobody should price from.
    for (const t of STARTER_TRADES) {
      for (const f of starterSheet(t).fields) {
        if (f.type === "number") expect(f.measured, `${t}: ${f.key}`).toBe(true);
      }
    }
  });
});
