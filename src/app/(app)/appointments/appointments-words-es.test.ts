import { describe, it, expect, vi, beforeEach } from "vitest";
import { dict, translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { jobStatusLabel } from "@/lib/job-status";

/**
 * THE VISITS' ANSWERS IN THE CALLER'S LANGUAGE (the agenda-in-Spanish wave; the visit's page is next
 * and reads them): a Spanish-reading office gets the refusal, the For box's sub lines and their slots
 * from lib/words/agenda-server in Spanish (the profile's language, read once per call); an English
 * reader gets the very bytes the actions always said. Without a database.
 */
const db = vi.hoisted(() => ({ language: "es", refuse: null as null | { code: string; message: string } }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client(), userId: "office-1", orgId: "org-1" })),
  requireMember: vi.fn(async () => ({ supabase: client(), userId: "office-1", orgId: "org-1", staff: true, name: "Office" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));

import { searchLinkTargets, setAppointmentAssignee, unscheduleAppointment } from "./actions";

const ROWS: Record<string, unknown[]> = {
  inquiries: [{ id: "l1", name: "Catbird Rewire", address: "3 Catbird Rd", status: "new" }],
  customers: [
    { id: "c1", name: "Catbird Hollow HOA", address: null, phone: "(530) 555-0100" },
    { id: "c2", name: "Catbird Kim", address: null, phone: null },
  ],
  jobs: [
    { id: "j7", job_number: "J-007", name: "Catbird Panel", address: null, status: "scheduled" },
    { id: "j8", job_number: "J-008", name: "Catbird Shed", address: null, status: null },
  ],
};

function client() {
  return {
    from(table: string) {
      let cols = "";
      let patch: Record<string, unknown> | null = null;
      const b: any = {
        select: (c?: string) => ((cols = String(c ?? cols)), b),
        update: (p: Record<string, unknown>) => ((patch = p), b),
        eq: () => b,
        in: () => b,
        is: () => b,
        or: () => b,
        neq: () => b,
        order: () => b,
        limit: () => b,
        // The caller's profile answers its language; any other profile read (the person put on a visit) is nobody.
        maybeSingle: async () => ({ data: table === "profiles" && cols.includes("language") ? { language: db.language } : null, error: null }),
        then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
          const run = () => {
            if (table === "appointments" && patch && "starts_at" in patch && db.refuse) return { data: null, error: db.refuse };
            if (patch) return { data: [{ id: "a1" }], error: null };
            return { data: ROWS[table] ?? [], error: null };
          };
          return Promise.resolve(run()).then(ok, bad);
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  db.language = "es";
  db.refuse = null;
});

describe("a Spanish reader", () => {
  it("a refusal is the Spanish sentence", async () => {
    db.refuse = { code: "23502", message: 'null value in column "starts_at"' };
    expect(await unscheduleAppointment("a1")).toEqual({
      ok: false,
      error: "Una visita no puede esperar sin día hasta que se haga una actualización rápida de la base de datos. Su fecha no cambió.",
    });
    expect(await setAppointmentAssignee("a1", "p-nobody")).toEqual({ ok: false, error: "Esa persona no está en este equipo, así que nadie cambió." });
  });

  it("the For box's sub lines fill their slots in Spanish: a lead's status, a phone, a job's number and status", async () => {
    const subs = (await searchLinkTargets("Catbird")).map((r) => r.sub);
    expect(subs).toEqual([
      "Prospecto · nuevo",
      "Cliente · (530) 555-0100",
      "Cliente",
      `Trabajo · J-007 · ${jobStatusLabel("scheduled", "es", translator("es"))}`,
      "Trabajo · J-008",
    ]);
    expect(subs[3]).not.toContain("Scheduled");
  });

  it("a plural is a pair of keys, never an English 's' (the tasks and parts a linked visit carries)", () => {
    const es = (k: string, n: number) => fillSlots(dict("es")[k], { n });
    expect([es("ag_srv_taskOne", 1), es("ag_srv_taskMany", 3), es("ag_srv_partOne", 1), es("ag_srv_partMany", 2)]).toEqual(["1 tarea", "3 tareas", "1 pieza", "2 piezas"]);
    expect(fillSlots(dict("es").ag_srv_listAnd, { list: "1 tarea", last: "2 piezas" })).toBe("1 tarea y 2 piezas");
  });
});

describe("an English reader gets the same bytes as before the wave", () => {
  it("the refusal and the sub lines", async () => {
    db.language = "en";
    db.refuse = { code: "23502", message: 'null value in column "starts_at"' };
    expect((await unscheduleAppointment("a1")).error).toBe("A visit can't wait without a day until a quick database update is done. Its date is unchanged.");
    const subs = (await searchLinkTargets("Catbird")).map((r) => r.sub);
    expect(subs).toEqual(["Lead · new", "Customer · (530) 555-0100", "Customer", `Job · J-007 · ${jobStatusLabel("scheduled")}`, "Job · J-008"]);
  });
});
