import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  APPT_PUSH_STATUSES,
  PICKABLE_APPOINTMENT_TYPES,
  appointmentTypeLabel,
  appointmentTypeOptions,
  isPickableAppointmentType,
} from "./statuses";

describe("the four kinds a person picks (W2-06, Service Call retired 2026-10-03)", () => {
  it("are Inspection, Job, Phone Call and Other, each a type the table allows, each with a real label", () => {
    expect(PICKABLE_APPOINTMENT_TYPES.map(appointmentTypeLabel)).toEqual(["Inspection", "Job", "Phone Call", "Other"]);
    // An old row still READS as Service Call — the read set keeps it, only the pickers narrowed.
    expect(appointmentTypeLabel("service_call")).toBe("Service Call");
    for (const t of PICKABLE_APPOINTMENT_TYPES) {
      expect(APPOINTMENT_TYPES as readonly string[]).toContain(t);
      expect(appointmentTypeLabel(t)).not.toBe(t); // a raw enum value is not a label
    }
  });

  it("an old row's kind still reads truly under its old label", () => {
    expect(appointmentTypeLabel("quote")).toBe("Quote / Estimate");
    expect(appointmentTypeLabel("meeting")).toBe("Client Meeting");
    expect(appointmentTypeLabel("appointment")).toBe("Appointment");
    expect(appointmentTypeLabel("final_inspection")).toBe("Final Inspection");
    for (const t of ["quote", "meeting", "appointment", "final_inspection"]) expect(isPickableAppointmentType(t)).toBe(false);
  });

  it("the Type select offers the five, plus a row's own old kind (so a Save never rewrites it)", () => {
    expect(appointmentTypeOptions(null)).toEqual([...PICKABLE_APPOINTMENT_TYPES]);
    expect(appointmentTypeOptions("inspection")).toEqual([...PICKABLE_APPOINTMENT_TYPES]);
    expect(appointmentTypeOptions("meeting")).toEqual([...PICKABLE_APPOINTMENT_TYPES, "meeting"]);
    expect(appointmentTypeOptions("final_inspection")).toEqual([...PICKABLE_APPOINTMENT_TYPES, "final_inspection"]);
    // Junk is never offered.
    expect(appointmentTypeOptions("nonsense")).toEqual([...PICKABLE_APPOINTMENT_TYPES]);
  });
});

describe("APPT_PUSH_STATUSES — the Google-push set is derived from the spine", () => {
  it("today's derived set is exactly the historical hand-written one", () => {
    expect([...APPT_PUSH_STATUSES]).toEqual(["scheduled", "completed"]);
  });

  it("is spine minus proposed/cancelled — a new spine status would push by default", () => {
    const expected = APPOINTMENT_STATUSES.filter((s) => s !== "proposed" && s !== "cancelled");
    expect([...APPT_PUSH_STATUSES]).toEqual(expected);
    // The exclusions must still be real spine values — if one is renamed/removed there,
    // this catches the drift instead of the push set silently changing.
    expect(APPOINTMENT_STATUSES).toContain("proposed");
    expect(APPOINTMENT_STATUSES).toContain("cancelled");
  });
});
