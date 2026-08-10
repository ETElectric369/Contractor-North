import { describe, it, expect } from "vitest";
import { patchFrom } from "./form-patch";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const ORG = {
  name: (v: FormDataEntryValue | null) => String(v ?? "").trim() || "My Company",
  phone: (v: FormDataEntryValue | null) => String(v ?? "").trim() || null,
  default_tax_pct: (v: FormDataEntryValue | null) => Number(v) / 100,
  timezone: (v: FormDataEntryValue | null) => String(v ?? "America/Los_Angeles"),
};

describe("patchFrom — a pane must only write its own fields", () => {
  it("THE ONE THAT MATTERS: a phone-only pane touches nothing else", () => {
    const p = patchFrom(fd({ phone: "5305551234" }), ORG);
    expect(p).toEqual({ phone: "5305551234" });
    // The old whole-row write would have produced all four of these:
    expect(p).not.toHaveProperty("name");            // …and renamed the company "My Company"
    expect(p).not.toHaveProperty("default_tax_pct"); // …and zeroed the tax rate
    expect(p).not.toHaveProperty("timezone");        // …and moved the business to Los Angeles
  });

  it("SUBMITTED BLANK is still a real edit — clearing a field must work", () => {
    expect(patchFrom(fd({ phone: "" }), ORG)).toEqual({ phone: null });
  });

  it("a blank NAME still falls back, because a nameless company is not a thing", () => {
    expect(patchFrom(fd({ name: "  " }), ORG)).toEqual({ name: "My Company" });
  });

  it("the whole form still writes the whole form — today's single-form page is unchanged", () => {
    const p = patchFrom(fd({ name: "ET Electric", phone: "1", default_tax_pct: "8.25", timezone: "America/Denver" }), ORG);
    expect(Object.keys(p).sort()).toEqual(["default_tax_pct", "name", "phone", "timezone"]);
    expect(p.default_tax_pct).toBeCloseTo(0.0825);
  });

  it("an empty form patches nothing, rather than writing an empty object", () => {
    expect(patchFrom(fd({}), ORG)).toEqual({});
  });
});
