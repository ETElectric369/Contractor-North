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
    expect((wireSizeForLoad({ amps: 100, metal: "cu" }) as any).size_awg).toBe("3");
  });
  it("wire size: 100A aluminum → #1 (exactly 100A at 75°C)", () => {
    expect((wireSizeForLoad({ amps: 100, metal: "al" }) as any).size_awg).toBe("1");
  });
  it("wire size: derate 0.8 forces a bigger conductor (need ampacity ≥125 → #1/130A)", () => {
    expect((wireSizeForLoad({ amps: 100, metal: "cu", derate: 0.8 }) as any).size_awg).toBe("1");
  });

  it("conduit fill: 3× #12 THHN → 1/2\" EMT", () => {
    const r = conduitFill({ conductors: [{ size_awg: "12", count: 3 }], conduit_type: "EMT" }) as any;
    expect(r.recommended_size).toBe('1/2"');
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
