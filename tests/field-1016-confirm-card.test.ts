/**
 * THE CONFIRM CARD SHOWS WHAT A PERSON CHECKS (field feedback 2026-10-16, the lock-screen round):
 * it read "id: 7deb…", "starts at: …", "ends at: null" while the address Nort was asked to fix sat
 * only in the sentence behind it. A record id is not a detail; "null" is not a value; and the
 * update door now takes the address. Source pins for the parts the unit tests cannot drive.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("the confirm card lists details, not record ids", () => {
  it("hides id and *_id keys and keeps the rest", () => {
    const c = read("src/app/(app)/assistant/assistant-chat.tsx");
    expect(c).toContain('.filter(([k, v]) => v != null && v !== "" && k !== "id" && !k.endsWith("_id") && !["status", "bill_number", "lunch_minutes"].includes(k))');
  });
});

describe("the model's empty words become null before the card is built", () => {
  it("every optional text on both appointment doors goes through nullableText", () => {
    const a = read("src/lib/actions/entities/appointment.ts");
    expect(a).toContain('const EMPTY_WORDS = new Set(["", "null", "none", "undefined", "n/a"]);');
    expect((a.match(/nullableText\(\)/g) ?? []).length).toBe(8);
    expect(a).not.toContain("z.string().nullable().optional() }");
  });
});

describe("a prompt promises details below only when the card has a row to show", () => {
  it("the status change and the timecard fix no longer say it; the address door pushes the calendar", () => {
    const a = read("src/lib/actions/entities/appointment.ts");
    expect(a).toContain("describe: (i) => `${statusVerb(i.status)} this appointment?`,");
    expect(read("src/lib/actions/entities/time.ts")).toContain('return `Fix this timecard entry — set ${parts.join(", ")} — say yes to confirm.`;');
    expect(read("src/lib/actions/entities/time.ts")).not.toContain("Check the details below.");
    const place = read("src/app/(app)/appointments/actions.ts");
    const body = place.slice(place.indexOf("export async function setAppointmentPlace("), place.indexOf("THE ONE WRITER for an inspection's field capture"));
    expect(body).toContain('await pushCalendarItem("appointment", id);');
  });
});

describe("Nort is told the update door takes an address", () => {
  it("the system prompt and the allow-list say so", () => {
    expect(read("src/app/api/chat/route.ts")).toContain("book an appointment (or move one / fix its address with appointment.update), draft a quote,");
    expect(read("src/lib/actions/agent-tools.ts")).toContain('"appointment.update", // reschedule or re-address by voice (no cancel+recreate)');
  });
});
