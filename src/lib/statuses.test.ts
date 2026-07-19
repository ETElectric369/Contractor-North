import { describe, expect, it } from "vitest";
import { APPOINTMENT_STATUSES, APPT_PUSH_STATUSES } from "./statuses";

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
