import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AN INSPECTION'S FORM SAYS INSPECTION (cn-v1134). One form creates or edits an appointment OR an
 * inspection, and its door said "Edit appointment" / "New appointment" / "Save Appointment" for
 * both kinds. The words follow the kind now, in Title Case; the propose mode keeps its own.
 *
 * The modal only opens by state (a tap, or ?new=1 in an effect), which a static render cannot
 * reach, so the words are one pure function driven here both ways, the closed trigger is rendered
 * both ways, and a pin holds the Modal's title and Save button to that function.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/schedule",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => null }));
vi.mock("@/components/address-autocomplete", () => ({ AddressAutocomplete: () => createElement("input") }));
vi.mock("./actions", () => ({
  createAppointment: vi.fn(),
  updateAppointment: vi.fn(),
  deleteAppointment: vi.fn(),
  createJobFromAppointment: vi.fn(),
  createAppointmentProposal: vi.fn(),
}));

import { AppointmentButton, apptFormWords } from "./appointment-button";

const appt = {
  id: "appt-1",
  type: "inspection",
  title: "Inspection: 41 Larkspur",
  starts_at: "2026-10-28T16:00:00.000Z",
  ends_at: null,
  job_id: null,
  customer_id: null,
  location: "41 Larkspur",
  notes: null,
  assigned_to: null,
};
const html = (o: Partial<Parameters<typeof AppointmentButton>[0]>) =>
  renderToStaticMarkup(createElement(AppointmentButton, { jobs: [], customers: [], staff: [], ...o }));

describe("the form's words follow its kind", () => {
  it("an inspection: New Inspection / Edit Inspection / Save Inspection", () => {
    expect(apptFormWords({ kind: "inspection", editing: false, mode: "set", linkReady: false })).toEqual({ title: "New Inspection", saveLabel: "Save Inspection", trigger: "New Inspection" });
    expect(apptFormWords({ kind: "inspection", editing: true, mode: "set", linkReady: false })).toEqual({ title: "Edit Inspection", saveLabel: "Save Inspection", trigger: "New Inspection" });
  });

  it("every other kind: New Appointment / Edit Appointment / Save Appointment", () => {
    for (const kind of ["other", "job", "quote", "meeting", "call", "service_call", "final_inspection", ""]) {
      expect(apptFormWords({ kind, editing: false, mode: "set", linkReady: false }), kind).toEqual({ title: "New Appointment", saveLabel: "Save Appointment", trigger: "New Appointment" });
      expect(apptFormWords({ kind, editing: true, mode: "set", linkReady: false }).title, kind).toBe("Edit Appointment");
      expect(apptFormWords({ kind, editing: true, mode: "set", linkReady: false }).saveLabel, kind).toBe("Save Appointment");
    }
  });

  it("the propose mode keeps its own words, in Title Case; an edit never proposes", () => {
    expect(apptFormWords({ kind: "other", editing: false, mode: "propose", linkReady: false })).toEqual({ title: "New Appointment", saveLabel: "Create Link", trigger: "New Appointment" });
    expect(apptFormWords({ kind: "inspection", editing: false, mode: "propose", linkReady: false }).saveLabel).toBe("Create Link");
    expect(apptFormWords({ kind: "other", editing: false, mode: "propose", linkReady: true }).title).toBe("Text The Customer These Times");
    expect(apptFormWords({ kind: "inspection", editing: true, mode: "propose", linkReady: false })).toEqual({ title: "Edit Inspection", saveLabel: "Save Inspection", trigger: "New Inspection" });
  });

  it("every word on the door is Title Case", () => {
    for (const kind of ["inspection", "other"])
      for (const editing of [false, true])
        for (const mode of ["set", "propose"] as const)
          for (const linkReady of [false, true]) {
            const w = apptFormWords({ kind, editing, mode, linkReady });
            for (const s of [w.title, w.saveLabel, w.trigger]) for (const word of s.split(" ")) expect(word, s).toMatch(/^[A-Z]/);
          }
  });
});

describe("the closed form, rendered", () => {
  it("the create trigger reads the caller's kind: New Inspection on the Inspections tab, New Appointment elsewhere, a caller's own words first", () => {
    expect(html({ defaultType: "inspection" })).toContain("New Inspection");
    expect(html({ defaultType: "inspection" })).not.toContain("New Appointment");
    expect(html({})).toContain("New Appointment");
    expect(html({ defaultType: "job" })).toContain("New Appointment");
    expect(html({ defaultType: "inspection", buttonLabel: "Book An Inspection" })).toContain("Book An Inspection");
  });

  it("the edit trigger is still the pencil titled Edit", () => {
    const s = html({ appointment: appt });
    expect(s).toContain('title="Edit"');
    expect(s).not.toContain("New Inspection");
  });
});

describe("the Modal reads the same function (a pin: the words cannot drift from the test above)", () => {
  const src = readFileSync(join(__dirname, "appointment-button.tsx"), "utf8");
  it("title and Save from apptFormWords on the live Type box; the trigger from the caller's default kind", () => {
    expect(src).toContain('const words = apptFormWords({ kind: form.type, editing, mode, linkReady: !!linkToken });');
    expect(src).toContain('const triggerWords = apptFormWords({ kind: defaultType ?? "", editing, mode: "set", linkReady: false });');
    expect(src).toContain("title={words.title}");
    expect(src).toContain("saveLabel={words.saveLabel}");
    expect(src).toContain('{buttonLabel ?? triggerWords.trigger}');
    for (const gone of ['"Edit appointment"', '"New appointment"', '"Save Appointment"', '"Text the customer these times"', "Set a Time", "Convert to Job"]) expect(src).not.toContain(gone);
  });
});
