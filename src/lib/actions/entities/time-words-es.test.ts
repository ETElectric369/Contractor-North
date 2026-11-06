import { describe, it, expect, vi, beforeEach } from "vitest";
import { dict } from "@/lib/i18n";

/**
 * THE TIME VERBS ANSWER IN THE PERSON'S LANGUAGE (cn-v1138). time.clockIn's `recorded`,
 * time.clockOut's read-back and time.switchJob's `speak` reach the person word for word (the tool
 * descriptions order the model to repeat them), so they are built from the nt_ catalog in ctx.lang.
 * The English is byte for byte what it was (every older test still passes with an empty context);
 * here the same handlers run with lang "es".
 */
const state = vi.hoisted(() => ({ lastEntry: null as Record<string, unknown> | null, switched: { ok: true, mode: "cut", closed_hours: 2.32 } as Record<string, unknown>, open: { id: "entry-9", notes: "", job_id: "job-old" } as Record<string, unknown> | null }));
vi.mock("@/app/(app)/timeclock/actions", () => ({
  clockIn: vi.fn(async () => ({ ok: true, id: "entry-1" })),
  clockOutCurrent: vi.fn(async () => ({ ok: true })),
  createManualEntry: vi.fn(),
  switchJob: vi.fn(async () => state.switched),
  updateTimeEntry: vi.fn(),
}));
vi.mock("../resolve-id", () => ({
  resolveJobId: vi.fn(async (_s: unknown, v: string | null) => (v && v.trim() ? { id: v } : { id: null })),
  resolveProfileId: vi.fn(async (_s: unknown, v: string | null) => ({ id: v })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-tech" } } }) },
    from(table: string) {
      const chain: any = {};
      for (const m of ["select", "eq", "not", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "jobs") return { data: { id: "job-1", job_number: "J-047", name: "Larkspur panel", address: "12 Larkspur Lane", customers: { name: "Larkspur" } }, error: null };
        if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } }, error: null };
        if (table === "time_entries") return { data: state.open ?? state.lastEntry, error: null };
        return { data: null, error: null };
      };
      return chain;
    },
  })),
}));

const ES = { userId: "user-tech", orgId: "org-1", role: "tech", lang: "es" } as const;

describe("time verbs, in Spanish", () => {
  beforeEach(() => {
    state.open = { id: "entry-9", notes: "", job_id: "job-old" };
    state.lastEntry = null;
    state.switched = { ok: true, mode: "cut", closed_hours: 2.32 };
  });

  it("clockIn says the job it landed on in Spanish; the same call with no context says it in English", async () => {
    const { timeActions } = await import("./time");
    const es = (await timeActions["time.clockIn"].handler({ job_id: "job-1" } as any, ES as any)) as any;
    expect(es.recorded).toMatch(/^Entrada marcada en .*Larkspur.*\.$/);
    const en = (await timeActions["time.clockIn"].handler({ job_id: "job-1" } as any, {} as any)) as any;
    expect(en.recorded).toMatch(/^Clocked in on .*Larkspur.*\.$/);
  });

  it("clockOut reads the shift back in Spanish, in the company's clock and the es-US date form", async () => {
    const { timeActions } = await import("./time");
    state.open = null;
    state.lastEntry = { clock_in: "2026-10-28T15:00:00Z", clock_out: "2026-10-28T23:30:00Z", job_id: null, lunch_minutes: 30 };
    const es = (await timeActions["time.clockOut"].handler({} as any, ES as any)) as any;
    expect(es.recorded).toMatch(/^Registrado: .+ → .+ \(8\.00h, 30m de almuerzo descontados, SIN trabajo asignado\)\.$/);
    expect(es.recorded).toMatch(/oct/i); // es-US: "28 oct", never "Oct 28"
    expect(es.recorded).not.toMatch(/Oct 28/);
    const en = (await timeActions["time.clockOut"].handler({} as any, {} as any)) as any;
    expect(en.recorded).toMatch(/^Recorded: Oct 28, .+ → Oct 28, .+ \(8\.00h, 30m lunch deducted, NO job attached\)\.$/);
  });

  it("a punch taken back says so in Spanish", async () => {
    const { clockOutCurrent } = await import("@/app/(app)/timeclock/actions");
    (clockOutCurrent as any).mockResolvedValueOnce({ ok: true, undone: true });
    const { timeActions } = await import("./time");
    const es = (await timeActions["time.clockOut"].handler({} as any, ES as any)) as any;
    expect(es.recorded).toBe(dict("es").nt_punchTakenBack);
    expect(dict("en").nt_punchTakenBack).toBe("That punch was taken back; nothing was recorded.");
  });

  it("switchJob: the cut and the whole move are said in Spanish, hours and the job named; its refusals too", async () => {
    const { timeActions, switchJobSpoken } = await import("./time");
    const cut = (await timeActions["time.switchJob"].handler({ job_id: "job-1" } as any, ES as any)) as any;
    expect(cut.speak).toMatch(/^Cambiado\. El reloj ya corre en el trabajo nuevo\. Las 2\.32 horas antes del cambio se quedaron en .*Larkspur/);
    expect(cut.speak).toMatch(/Tarjetas de Tiempo\.$/);
    expect(switchJobSpoken("repointed", 0, null, "es")).toBe(dict("es").nt_switchRepointed);
    expect(switchJobSpoken("cut", 1.5, null, "es")).toContain("se quedaron en el trabajo en el que estabas");
    // The English, untouched (the older pins): the default language.
    expect(switchJobSpoken("repointed", 0, "J-011 Honeysuckle")).toBe("Done — this whole punch is on the new job now. Any earlier part of the day stays where it was.");
    expect(switchJobSpoken("cut", 2.32, null)).toContain("The 2.32 hours before the switch stayed on the job you were on:");
    state.open = null;
    const none = (await timeActions["time.switchJob"].handler({ job_id: "job-1" } as any, ES as any)) as any;
    expect(none).toEqual({ ok: false, error: "No has marcado entrada." });
    state.open = { id: "entry-9", notes: "", job_id: null };
    const which = (await timeActions["time.switchJob"].handler({ job_id: "" } as any, ES as any)) as any;
    expect(which).toMatchObject({ ok: false, missingFields: ["job_id"], error: "¿A qué trabajo cambias?" });
  });

  it("the model is told the read-backs arrive in the user's language, and the description stays English", async () => {
    const { timeActions } = await import("./time");
    for (const v of ["time.clockIn", "time.clockOut", "time.switchJob"]) expect(timeActions[v].description).toMatch(/in the user's own language/);
  });
});
