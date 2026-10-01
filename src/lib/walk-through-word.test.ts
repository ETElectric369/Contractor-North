import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appointmentTypeLabel } from "@/lib/statuses";
import { bookingTitle, KIND_LABEL } from "@/lib/schedule/work-shape";
import { apptEventBody } from "@/lib/gcal-map";
import { DOCK } from "@/lib/dock";
import { FEATURES } from "@/lib/features";

/**
 * ONE WORD FOR THE SITE VISIT (W2-10). The visit before a price is a Walk-Through wherever staff or
 * Nort read it; "Inspection" is left to the city's inspection (the permit, the Permits & Inspections
 * switch, the legacy Final Inspection). Words only: the route (/inspections), the stored type
 * ('inspection') and every stored title stay as they are.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the site visit is a Walk-Through", () => {
  it("the type's label, the kind's chip and the dock row all say it", () => {
    expect(appointmentTypeLabel("inspection")).toBe("Walk-Through");
    expect(KIND_LABEL.walkthrough).toBe("Walk-Through");
    const row = DOCK.find((s) => s.key === "sales")?.children.find((c) => c.id === "sl-inspections");
    expect(row).toMatchObject({ label: "Walk-Throughs", href: "/inspections" });
  });

  it("a new walk-through's stock title is the word and who it's with", () => {
    expect(bookingTitle("walkthrough", "Matt Warren")).toBe("Walk-Through: Matt Warren");
  });

  it("the city's inspection keeps its word", () => {
    expect(appointmentTypeLabel("final_inspection")).toBe("Final Inspection");
    expect(FEATURES.find((f) => f.key === "permits")?.label).toBe("Permits & Inspections");
  });

  it("Nort's appointment and lead tools never call the site visit a site inspection", () => {
    for (const f of ["src/lib/actions/entities/appointment.ts", "src/lib/actions/entities/inquiry.ts"]) {
      expect(read(f).toLowerCase(), f).not.toContain("site inspection");
    }
    // …and appointment.create tells Nort which word means which.
    expect(read("src/lib/actions/entities/appointment.ts")).toContain(
      'Title a site visit \\"Walk-Through: <customer or place>\\"; \\"inspection\\" means the city\'s inspection on a permit.',
    );
  });

  it("an Other visit reaches Google with no bracket prefix; a walk-through reads [Walk-Through]", () => {
    const visit = { id: "a1", title: "Dentist", starts_at: "2026-10-01T16:00:00.000Z", ends_at: null, location: null, notes: null };
    expect(apptEventBody({ ...visit, type: "other" }).summary).toBe("Dentist");
    expect(apptEventBody({ ...visit, type: "other" }).summary).not.toMatch(/^\[/);
    expect(apptEventBody({ ...visit, type: "inspection", title: "Rough-in walk" }).summary).toBe("[Walk-Through] Rough-in walk");
  });

  it("the setup interview is setup, so the one word means only the site visit", () => {
    expect(read("src/lib/onboarding/help-rows.ts")).toContain('"Setup from the top. Change anything you told Nort."');
    const s = read("src/components/setup-interview.tsx");
    expect(s).toContain("Take setup again from Search Or Ask and tell me your trade");
    expect(s).toContain(">This setup</strong>");
    expect(s).not.toContain("Take the walk-through again");
  });
});
