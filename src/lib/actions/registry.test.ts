import { describe, it, expect } from "vitest";
import { REGISTRY, listActions } from "./registry";
import { AGENT_WRITE_ALLOWED, agentWriteToolsForRole } from "./agent-tools";
import { needsConsent } from "./risk";

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

// Conversational quote generation (Assistant): quote.create must be staff-gated, a tier-1
// write (so it's offered to the chat agent), and accept a minimal line-item payload.
describe("action registry — quote.create (Assistant quote generation)", () => {
  it("is a staff-only write in the registry", () => {
    expect(REGISTRY["quote.create"]).toBeDefined();
    expect(REGISTRY["quote.create"].effect).toBe("write");
    expect(REGISTRY["quote.create"].auth).toBe("staff");
    expect(REGISTRY["quote.create"].group).toBe("quote");
  });

  it("validates a minimal quote and a full one (tax_rate is a number fraction)", () => {
    const schema = REGISTRY["quote.create"].input;
    expect(schema.safeParse({}).success).toBe(true); // all keys defaulted
    expect(
      schema.safeParse({
        customer_id: "c1",
        title: "Panel upgrade",
        tax_rate: 0.0825,
        items: [{ description: "200A panel", quantity: 1, unit: "ea", unit_price: 450 }],
      }).success,
    ).toBe(true);
    // a line item must have a description
    expect(schema.safeParse({ items: [{ quantity: 1 }] }).success).toBe(false);
  });

  it("is offered as a chat tool to office/owner but NOT to a tech", () => {
    expect(AGENT_WRITE_ALLOWED.has("quote.create")).toBe(true);
    const offered = (role: string) => agentWriteToolsForRole(role).tools.map((t) => t.name);
    expect(offered("owner")).toContain("quote__create");
    expect(offered("office")).toContain("quote__create");
    expect(offered("tech")).not.toContain("quote__create");
  });
});

// One-assistant-everywhere: the agent can now do field + cost work. The cost action is
// confirm-gated (tier-2) and must surface a confirm before it writes; field clock work is
// tier-1 and runs straight through. Role gating still holds.
describe("action registry — agent field + cost powers (one assistant)", () => {
  const offered = (role: string) => agentWriteToolsForRole(role).tools.map((t) => t.name);

  it("clock in/out, log time, and record cost are all agent-allowed", () => {
    for (const n of ["time.clockIn", "time.clockOut", "time.addEntry", "bill.create"]) {
      expect(AGENT_WRITE_ALLOWED.has(n)).toBe(true);
    }
  });

  it("a tech may clock in/out by agent but NOT record a cost (staff-only)", () => {
    const tech = offered("tech");
    expect(tech).toContain("time__clockIn");
    expect(tech).toContain("time__clockOut");
    expect(tech).not.toContain("bill__create");
  });

  it("office/owner ARE offered the cost tool (confirm-gated tier-2 now surfaced)", () => {
    expect(offered("owner")).toContain("bill__create");
    expect(offered("office")).toContain("bill__create");
  });

  it("recording a cost still trips the confirm gate for the agent — no silent write", () => {
    expect(needsConsent(REGISTRY["bill.create"], "agent", false)).toBe(true);
    expect(needsConsent(REGISTRY["bill.create"], "agent", true)).toBe(false); // an explicit yes passes
    expect(needsConsent(REGISTRY["time.clockIn"], "agent", false)).toBe(false); // tier-1 runs straight
  });

  it("the cost confirm read-back states the amount + supplier (not just a label)", () => {
    const d = REGISTRY["bill.create"].describe?.({ amount: 40, supplier: "Home Depot" } as any);
    expect(d).toContain("40.00");
    expect(d).toContain("Home Depot");
  });

  it("money-MOVEMENT and tier-3 are never offered to the agent", () => {
    const all = offered("owner");
    // pay/refund/delete-style verbs must not leak into the chat agent's tools
    expect(all).not.toContain("bill__delete");
    expect(all).not.toContain("bill__setStatus");
  });
});

// CIB audit Phase 2 — the money loop. Building/adjusting a DRAFT invoice is tier-1 (runs
// straight through); recording a received PAYMENT is confirm-gated; SENDING / refunding /
// DELETING an invoice are never offered to the agent (the user's own tap).
describe("action registry — invoice money loop (draft fill by voice)", () => {
  const offered = (role: string) => agentWriteToolsForRole(role).tools.map((t) => t.name);

  it("offers the draft-invoice + payment tools to office/owner", () => {
    for (const t of [
      "invoice__fromJob",
      "invoice__fromQuote",
      "invoice__addItem",
      "invoice__updateItem",
      "invoice__deleteItem",
      "payment__record",
    ]) {
      expect(offered("owner")).toContain(t);
    }
  });

  it("draft-invoice edits run straight through, but recording a payment trips the confirm gate", () => {
    expect(needsConsent(REGISTRY["invoice.fromJob"], "agent", false)).toBe(false); // tier-1 draft
    expect(needsConsent(REGISTRY["invoice.addItem"], "agent", false)).toBe(false);
    expect(needsConsent(REGISTRY["payment.record"], "agent", false)).toBe(true); // money in → confirm
    expect(needsConsent(REGISTRY["payment.record"], "agent", true)).toBe(false); // explicit yes passes
  });

  it("never exposes invoice SEND / delete / refund to the agent", () => {
    const all = offered("owner");
    expect(all).not.toContain("invoice__send");
    expect(all).not.toContain("invoice__delete");
    expect(all).not.toContain("payment__delete");
  });

  it("invoice draft tools are staff-only — a tech is not offered them", () => {
    const tech = offered("tech");
    expect(tech).not.toContain("invoice__fromJob");
    expect(tech).not.toContain("payment__record");
  });
});
