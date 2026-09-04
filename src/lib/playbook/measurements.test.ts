import { describe, it, expect } from "vitest";
import { measurementOptions, measurementLabel } from "./measurements";
import type { Playbook } from "./types";

const electrical: Playbook = {
  needs: [
    { key: "run_ft", label: "Conduit run", ask: "How far?", slot: { type: "number", unit: "ft" }, measured: true },
    { key: "device_count", label: "Devices", ask: "How many?", slot: { type: "number" }, measured: true },
    { key: "panel_brand", label: "Panel brand", ask: "Which?", slot: { type: "text" } as never, measured: true },
    { key: "notes", label: "Notes", ask: "Anything?", slot: { type: "number", unit: "ft" } },
  ],
};

describe("measurementOptions", () => {
  it("lists the built-ins first, then every measured number need, deduped", () => {
    const opts = measurementOptions([electrical, electrical]);
    expect(opts.map((o) => o.key)).toEqual(["area_sqft", "length_lf", "run_ft", "device_count"]);
  });
  it("labels a key for a person", () => {
    const opts = measurementOptions([electrical]);
    expect(measurementLabel("run_ft", opts)).toBe("Conduit run (ft)");
    expect(measurementLabel("device_count", opts)).toBe("Devices");
    expect(measurementLabel("area_sqft", opts)).toBe("Square feet of the job");
    expect(measurementLabel("stair_steps", opts)).toBe("stair steps");
    expect(measurementLabel(null, opts)).toBeNull();
  });
});
