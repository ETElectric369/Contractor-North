import { describe, it, expect } from "vitest";
import { voltageDrop, wireSizeForLoad, conduitFill, boxFill } from "./electrical-calc";

describe("electrical-calc", () => {
  it("voltage drop: 20A, 100ft, #12 Cu, 240V 1φ ≈ 3.3% (fails 3%)", () => {
    const r = voltageDrop({ amps: 20, lengthFt: 100, sizeAwg: "12", metal: "cu", phase: 1, sourceVolts: 240 }) as any;
    expect(r.volts_dropped).toBeCloseTo(7.9, 1);
    expect(r.percent).toBeCloseTo(3.29, 1);
    expect(r.ok_under_3pct).toBe(false);
  });

  it("voltage drop: upsizing to #8 Cu passes 3%", () => {
    const r = voltageDrop({ amps: 20, lengthFt: 100, sizeAwg: "8", metal: "cu", phase: 1, sourceVolts: 240 }) as any;
    expect(r.ok_under_3pct).toBe(true);
  });

  it("wire size: 100A copper → #3 (exact 100A at 75°C)", () => {
    expect((wireSizeForLoad({ amps: 100, metal: "cu", method: "raceway" }) as any).size_awg).toBe("3");
  });
  it("wire size: 100A aluminum → #1 (exactly 100A at 75°C)", () => {
    expect((wireSizeForLoad({ amps: 100, metal: "al", method: "raceway" }) as any).size_awg).toBe("1");
  });
  it("wire size: derate 0.8 → #2 (derates off the 90°C column, clamped to 75°C)", () => {
    // This answer CHANGED (was #1). Deriving the derate from the 75°C column was over-conservative:
    // #2 THHN is 130A at 90°C, ×0.8 = 104A ≥ 100A, and 104 sits under its own 115A 75°C termination
    // limit — so #2 is compliant and #1 was a size of wire the contractor didn't have to buy.
    const r = wireSizeForLoad({ amps: 100, metal: "cu", method: "raceway", derate: 0.8 }) as any;
    expect(r.size_awg).toBe("2");
    expect(r.derated_ampacity).toBe(104);
  });

  /**
   * THE SMALL-CONDUCTOR RULE (NEC 240.4(D)) — these are the cases the calculator got wrong in
   * production. It answered "14 AWG" for a 20A circuit because #14 Cu is listed at 20A in the
   * 75°C column, with no awareness that 240.4(D)(3) forbids protecting it above 15A. Every case
   * here is a circuit that exists in nearly every house.
   */
  describe("240.4(D) small-conductor rule", () => {
    it("20A circuit is #12, NEVER #14 — the shipped bug", () => {
      for (const method of ["nm", "raceway"] as const) {
        const r = wireSizeForLoad({ amps: 20, metal: "cu", method }) as any;
        expect(r.size_awg).toBe("12");
      }
    });
    it("15A circuit is #14 — the rule doesn't over-correct", () => {
      expect((wireSizeForLoad({ amps: 15, metal: "cu", method: "nm" }) as any).size_awg).toBe("14");
    });
    it("25A circuit is #10, not #12 (#12 Cu caps at 20A)", () => {
      const r = wireSizeForLoad({ amps: 25, metal: "cu", method: "raceway" }) as any;
      expect(r.size_awg).toBe("10");
      expect(r.limited_by).toContain("240.4(D)");
    });
    it("35A circuit is #8, not #10 (#10 Cu caps at 30A despite 35A of ampacity)", () => {
      expect((wireSizeForLoad({ amps: 35, metal: "cu", method: "raceway" }) as any).size_awg).toBe("8");
    });
    it("30A circuit is #10 — exactly at the cap, still allowed", () => {
      expect((wireSizeForLoad({ amps: 30, metal: "cu", method: "raceway" }) as any).size_awg).toBe("10");
    });
    it("aluminum: 30A is #8 — #10 Al caps at 25A AND was mis-tabled at 35A", () => {
      // Double bug: the old table listed #10 Al at 35A (the 90°C value) in a 75°C table, and
      // 240.4(D)(6) caps #10 Al at 25A anyway. Both had to be fixed to reach #8.
      expect((wireSizeForLoad({ amps: 30, metal: "al", method: "raceway" }) as any).size_awg).toBe("8");
    });
    it("the cap never applies above #10 Cu — a 50A raceway run is still #8", () => {
      expect((wireSizeForLoad({ amps: 50, metal: "cu", method: "raceway" }) as any).size_awg).toBe("8");
    });
  });

  /**
   * NM/UF are 60°C conductors (334.80 / 340.80) no matter how the panel is rated. Shipping only a
   * 75°C table undersized every Romex answer above 40A.
   */
  describe("wiring method picks the ampacity column", () => {
    it("50A range circuit: #6 on Romex but #8 in conduit", () => {
      expect((wireSizeForLoad({ amps: 50, metal: "cu", method: "nm" }) as any).size_awg).toBe("6");
      expect((wireSizeForLoad({ amps: 50, metal: "cu", method: "raceway" }) as any).size_awg).toBe("8");
    });
    it("UF is 60°C too", () => {
      expect((wireSizeForLoad({ amps: 50, metal: "cu", method: "uf" }) as any).size_awg).toBe("6");
    });
    it("a 60°C-terminated raceway matches the cable answer", () => {
      const r = wireSizeForLoad({ amps: 50, metal: "cu", method: "raceway", termination_c: 60 }) as any;
      expect(r.size_awg).toBe("6");
      expect(r.ampacity_column).toBe("60°C");
    });
    it("derating an NM run is clamped to the 60°C value, never above it", () => {
      // 334.80 permits derating from the 90°C column (#6 = 75A) but the result may not exceed
      // the 60°C ampacity of 55A. 75 × 0.9 = 67.5 must come back as 55.
      const r = wireSizeForLoad({ amps: 55, metal: "cu", method: "nm", derate: 0.9 }) as any;
      expect(r.size_awg).toBe("6");
      expect(r.derated_ampacity).toBe(55);
    });
    it("every answer names the column and the code basis it used", () => {
      const nm = wireSizeForLoad({ amps: 20, metal: "cu", method: "nm" }) as any;
      expect(nm.ampacity_column).toBe("60°C");
      expect(nm.basis).toContain("334.80");
      // On NM the 60°C column already stops #14 at 15A, so ampacity binds BEFORE 240.4(D) does —
      // the two limits agree, which is a useful cross-check that neither table is wrong. The rule
      // only becomes the deciding factor where the 75°C column would otherwise have allowed it.
      expect(nm.limited_by).toBe("ampacity");
      const raceway = wireSizeForLoad({ amps: 20, metal: "cu", method: "raceway" }) as any;
      expect(raceway.basis).toContain("240.4(D)");
      expect(raceway.limited_by).toContain("240.4(D)");
    });
    it("a raceway answer discloses that 75°C terminations are an ASSUMPTION", () => {
      const r = wireSizeForLoad({ amps: 100, metal: "cu", method: "raceway" }) as any;
      expect(r.basis).toContain("verify the panel/breaker marking");
    });
    it("defaults to raceway/75°C when the method is omitted", () => {
      expect((wireSizeForLoad({ amps: 50, metal: "cu" }) as any).size_awg).toBe("8");
    });
    it("refuses rather than guessing when nothing listed carries the load", () => {
      expect((wireSizeForLoad({ amps: 600, metal: "cu", method: "raceway" }) as any).error).toBeTruthy();
    });
  });

  it("conduit fill: 3× #12 THHN → 1/2\" EMT", () => {
    const r = conduitFill({ conductors: [{ size_awg: "12", count: 3 }], conduit_type: "EMT" }) as any;
    expect(r.recommended_size).toBe('1/2"');
    expect(r.fill_limit_percent).toBe(40);
  });

  /**
   * The fill limit is NOT always 40% (NEC ch.9 table 1). Applying 40% to a two-wire run undersizes
   * the pipe — the estimate buys conduit that won't pass inspection — and applying it to a single
   * conductor oversizes it, so the customer pays for pipe they don't need. Both were silent.
   */
  describe("fill limit varies with the conductor count", () => {
    it("two conductors are limited to 31%, not 40%", () => {
      const r = conduitFill({ conductors: [{ size_awg: "12", count: 2 }], conduit_type: "EMT" }) as any;
      expect(r.fill_limit_percent).toBe(31);
      expect(r.note).toMatch(/two conductors 31%/);
    });
    it("a single conductor is allowed 53%", () => {
      const r = conduitFill({ conductors: [{ size_awg: "4", count: 1 }], conduit_type: "EMT" }) as any;
      expect(r.fill_limit_percent).toBe(53);
    });
    it("the tighter 31% limit really does push to a bigger pipe", () => {
      // 2× 3/0 THHN = 0.5358 in². 1-1/4" EMT usable: 40% → 0.598 (fits), 31% → 0.463 (doesn't).
      const two = conduitFill({ conductors: [{ size_awg: "3/0", count: 2 }], conduit_type: "EMT" }) as any;
      expect(two.recommended_size).toBe('1-1/2"');
    });
    it("over two conductors stays at 40%", () => {
      const r = conduitFill({ conductors: [{ size_awg: "12", count: 4 }], conduit_type: "EMT" }) as any;
      expect(r.fill_limit_percent).toBe(40);
    });
  });

  it("box fill above 6 AWG explains 314.28 instead of just failing", () => {
    // A bare error sends the model back to reasoning the table from memory — the exact failure
    // these tools exist to prevent.
    const r = boxFill({ wire_size_awg: "2", conductors: 3 }) as any;
    expect(r.error).toMatch(/314.16/);
    expect(r.guidance).toMatch(/314.28/);
  });
  it("conduit fill: 9× #10 THHN needs a bigger conduit than 1/2\"", () => {
    const r = conduitFill({ conductors: [{ size_awg: "10", count: 9 }], conduit_type: "EMT" }) as any;
    expect(r.recommended_size).not.toBe('1/2"');
  });

  it("box fill: #12, 6 conductors + 1 device + grounds → 20.25 in³ → 4×4×1½ square", () => {
    const r = boxFill({ wire_size_awg: "12", conductors: 6, devices: 1, has_grounds: true }) as any;
    expect(r.required_volume_in3).toBeCloseTo(20.25, 2);
    expect(r.recommended_box).toContain("4×4×1½");
  });
});
