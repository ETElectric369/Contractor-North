import { describe, it, expect } from "vitest";
import { REGISTRY, listActions } from "./registry";

// Structural invariants over the WHOLE registry — so a malformed new entity (wrong
// key, missing handler, bad auth) fails CI instead of at runtime on a real surface.
describe("action registry — structural invariants", () => {
  const entries = Object.entries(REGISTRY);

  it("every entry's key matches its name, which is group.verb", () => {
    for (const [key, def] of entries) {
      expect(def.name).toBe(key);
      expect(key).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(key.startsWith(def.group + ".")).toBe(true);
    }
  });

  it("every action has valid auth + effect, a handler, an input schema, and labels", () => {
    for (const def of Object.values(REGISTRY)) {
      expect(["any", "staff", "owner"]).toContain(def.auth);
      expect(["read", "write"]).toContain(def.effect);
      expect(typeof def.handler).toBe("function");
      expect(typeof (def.input as { safeParse?: unknown }).safeParse).toBe("function");
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});

// Fault #3 close-out: time-logging is now a first-class registry capability, so voice
// and every surface call ONE path (the same the timeclock UI uses).
describe("action registry — time entity (Fault #3)", () => {
  it("clock-in/out are open to any tech; manual add-entry is staff-only (office correction)", () => {
    for (const v of ["time.clockIn", "time.clockOut", "time.addEntry"]) {
      expect(REGISTRY[v]).toBeDefined();
      expect(REGISTRY[v].effect).toBe("write");
    }
    expect(REGISTRY["time.clockIn"].auth).toBe("any"); // a tech clocks themselves
    expect(REGISTRY["time.clockOut"].auth).toBe("any");
    expect(REGISTRY["time.addEntry"].auth).toBe("staff"); // back-dated entries = padding risk
  });

  it("listActions can surface the whole time group", () => {
    const ids = listActions({ group: "time" }).map((a) => a.name).sort();
    expect(ids).toEqual(["time.addEntry", "time.clockIn", "time.clockOut"]);
  });

  it("time.clockIn validates a minimal (jobless) clock-in", () => {
    expect(REGISTRY["time.clockIn"].input.safeParse({}).success).toBe(true);
    expect(REGISTRY["time.clockIn"].input.safeParse({ job_id: "j1", clock_in_at: "2026-06-23T08:00:00Z" }).success).toBe(true);
  });

  it("time.addEntry requires the start & end timestamps", () => {
    expect(REGISTRY["time.addEntry"].input.safeParse({ clock_in: "a", clock_out: "b" }).success).toBe(true);
    expect(REGISTRY["time.addEntry"].input.safeParse({ clock_in: "a" }).success).toBe(false);
  });
});
