import { describe, it, expect } from "vitest";
import { REGISTRY, listActions } from "./registry";
import { AGENT_WRITE_ALLOWED, agentWriteToolsForRole } from "./agent-tools";
import { needsConsent } from "./risk";
import { DATA_TOOLS } from "@/lib/assistant-tools";

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
    expect(ids).toEqual(["time.addEntry", "time.clockIn", "time.clockOut", "time.fixEntry", "time.listEntries", "time.splitEntry", "time.switchJob"]);
  });

  // 0288: a day on two jobs is two entries. Clock-out asks for no breakdown; a live switch is a
  // tech's own write; a finished-shift split is a FILL (the sheet), never a write by Nort.
  it("time.clockOut takes no job/hours breakdown any more", () => {
    const shape = (REGISTRY["time.clockOut"].input as any).shape ?? {};
    expect(Object.keys(shape).sort()).toEqual(["lunch_minutes", "miles", "notes"]);
    expect(REGISTRY["time.clockOut"].description).not.toMatch(/allocations/);
  });

  it("time.switchJob is the caller's own live write, offered to a tech", () => {
    expect(REGISTRY["time.switchJob"].auth).toBe("any");
    expect(REGISTRY["time.switchJob"].effect).toBe("write");
    expect(AGENT_WRITE_ALLOWED.has("time.switchJob")).toBe(true);
    expect(agentWriteToolsForRole("tech").tools.map((t) => t.name)).toContain("time__switchJob");
    expect(REGISTRY["time.switchJob"].input.safeParse({}).success).toBe(false);
  });

  it("time.splitEntry only FILLS the sheet: a staff read, never a write, never offered to a tech", () => {
    const a = REGISTRY["time.splitEntry"];
    expect(a.auth).toBe("staff");
    expect(a.effect).toBe("read");
    expect(AGENT_WRITE_ALLOWED.has("time.splitEntry")).toBe(false);
    expect(agentWriteToolsForRole("owner").tools.map((t) => t.name)).toContain("time__splitEntry");
    expect(agentWriteToolsForRole("tech").tools.map((t) => t.name)).not.toContain("time__splitEntry");
    const id = "11111111-1111-4111-8111-111111111111";
    expect(a.input.safeParse({ entry_id: id, at: "2001-07-14T16:30", job_id: "j" }).success).toBe(true);
    expect(a.input.safeParse({ entry_id: id, at: "2001-07-14T16:30", job_code: "DRIVE" }).success).toBe(true);
    expect(a.input.safeParse({ entry_id: id, at: "2001-07-14T16:30" }).success).toBe(false); // which job?
  });

  it("time.listEntries is the staff read that hands Nort the entry ids the split and fix verbs need", () => {
    const a = REGISTRY["time.listEntries"];
    expect(a.auth).toBe("staff");
    expect(a.effect).toBe("read");
    expect(AGENT_WRITE_ALLOWED.has("time.listEntries")).toBe(false);
    expect(agentWriteToolsForRole("owner").tools.map((t) => t.name)).toContain("time__listEntries");
    expect(agentWriteToolsForRole("tech").tools.map((t) => t.name)).not.toContain("time__listEntries");
    expect(a.input.safeParse({ day: "2001-07-14", person: "Brian" }).success).toBe(true);
    expect(a.input.safeParse({ day: "2001-07-14" }).success).toBe(true);
    expect(a.input.safeParse({ day: "Tuesday" }).success).toBe(false); // the model works the date out
    expect(REGISTRY["time.splitEntry"].description).toMatch(/time\.listEntries/);
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

  it("drafting an invoice runs straight through; changing a LINE or taking money trips the gate", () => {
    /**
     * THE LINE EDITS MOVED UP A TIER IN cn-v962, AND THIS ASSERTION MOVED WITH THEM.
     *
     * They were tier-1 on one argument: the server action underneath refused anything but a
     * draft, so the worst a misheard sentence could do was rearrange a bill nobody had seen.
     * Erik overruled that lock - "even if i did sent it ill always need to be able to go back and
     * make changes as per a client's request or my own review catches errors" - so the same
     * sentence spoken at a jobsite now reaches a SENT, PARTIAL, PAID or OVERDUE invoice and
     * changes what a customer owes. A confirm is the only thing left between a misheard line and
     * a re-priced bill somebody has already paid. The UI stays exempt (the person is looking at
     * the line), so this costs a typed edit nothing and gates voice and agent callers, which is
     * exactly where the risk is.
     */
    expect(needsConsent(REGISTRY["invoice.fromJob"], "agent", false)).toBe(false); // drafting a new bill asks nobody for money
    expect(needsConsent(REGISTRY["invoice.addItem"], "agent", false)).toBe(true);
    expect(needsConsent(REGISTRY["invoice.updateItem"], "agent", false)).toBe(true);
    expect(needsConsent(REGISTRY["invoice.deleteItem"], "agent", false)).toBe(true);
    expect(needsConsent(REGISTRY["invoice.addItem"], "agent", true)).toBe(false); // explicit yes passes
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

// The job's ONE materials list, by voice (Erik to Nort, 2026-09-16: "add a single gang bell box
// to the materials list for Jason Waldo job" → "I don't have a tool for that" → "I want you to
// be able to do everything that I can do on this app"). Techs work the same list (auth "any"),
// adding + ticking are reversible tier-1, removing a line is confirm-gated.
describe("action registry — material entity (the job's one materials list)", () => {
  const offered = (role: string) => agentWriteToolsForRole(role).tools.map((t) => t.name);

  it("registers the three verbs as writes open to any role", () => {
    const ids = listActions({ group: "material" }).map((a) => a.name).sort();
    expect(ids).toEqual(["material.addLine", "material.markPurchased", "material.removeLine"]);
    for (const v of ids) {
      expect(REGISTRY[v].effect).toBe("write");
      expect(REGISTRY[v].auth).toBe("any"); // a tech works the same list as the office
      expect(AGENT_WRITE_ALLOWED.has(v)).toBe(true);
    }
  });

  it("is offered to a tech AND the office as material__addLine / markPurchased / removeLine", () => {
    for (const role of ["tech", "office", "owner"]) {
      const names = offered(role);
      expect(names).toContain("material__addLine");
      expect(names).toContain("material__markPurchased");
      expect(names).toContain("material__removeLine");
    }
  });

  it("adding + ticking run straight through; removing a line trips the confirm gate", () => {
    expect(needsConsent(REGISTRY["material.addLine"], "agent", false)).toBe(false);
    expect(needsConsent(REGISTRY["material.markPurchased"], "agent", false)).toBe(false);
    expect(REGISTRY["material.removeLine"].confirm).toBe("destructive");
    expect(needsConsent(REGISTRY["material.removeLine"], "agent", false)).toBe(true);
    expect(needsConsent(REGISTRY["material.removeLine"], "agent", true)).toBe(false);
  });

  it("addLine takes a job name where an id belongs, defaults quantity 1 / unit ea, and needs a description", () => {
    const schema = REGISTRY["material.addLine"].input;
    const ok = schema.safeParse({ job_id: "Waldow", description: "single-gang bell box" });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.quantity).toBe(1);
      expect(ok.data.unit).toBe("ea");
    }
    expect(schema.safeParse({ job_id: "Waldow" }).success).toBe(false);
    expect(schema.safeParse({ job_id: "Waldow", description: "   " }).success).toBe(false);
    expect(schema.safeParse({ job_id: "Waldow", description: "bit", quantity: 0 }).success).toBe(false);
  });

  it("the addLine read-back names the line and the job in the user's words, never a uuid", () => {
    const parsed = REGISTRY["material.addLine"].input.parse({ job_id: "Waldow", description: "single-gang bell box" });
    expect(REGISTRY["material.addLine"].describe?.(parsed)).toBe("Add 1 ea single-gang bell box to the Waldow materials list.");
    const byId = REGISTRY["material.addLine"].input.parse({
      job_id: "8f1c3b2a-4d5e-4f60-9a7b-1c2d3e4f5a6b",
      description: "short extension bit",
      quantity: 2,
    });
    expect(REGISTRY["material.addLine"].describe?.(byId)).toBe("Add 2 ea short extension bit to that job's materials list.");
  });

  it("markPurchased / removeLine need the job plus a description fragment or an item_id", () => {
    for (const v of ["material.markPurchased", "material.removeLine"]) {
      const schema = REGISTRY[v].input;
      expect(schema.safeParse({ job_id: "Waldow", description: "bell box" }).success).toBe(true);
      expect(schema.safeParse({ job_id: "Waldow", item_id: "8f1c3b2a-4d5e-4f60-9a7b-1c2d3e4f5a6b" }).success).toBe(true);
      expect(schema.safeParse({ job_id: "Waldow" }).success).toBe(false); // which line?
      expect(schema.safeParse({ description: "bell box" }).success).toBe(false); // which job?
    }
    const m = REGISTRY["material.markPurchased"].input.parse({ job_id: "Waldow", description: "bell box" });
    expect(m.purchased).toBe(true); // ticking is the default; purchased:false un-ticks
    expect(REGISTRY["material.removeLine"].describe?.(m)).toContain("say yes to confirm");
  });

  it("the read side exists: list_material_items is a data tool that takes job_id or list_id", () => {
    const t = DATA_TOOLS.find((d) => d.name === "list_material_items");
    expect(t).toBeDefined();
    const props = (t?.input_schema as { properties?: Record<string, unknown> })?.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["job_id", "list_id", "to_buy_only"]));
  });
});

// TOOK FROM STOCK (Shop Stock, Phase 3): Nort FILLS the card, a person taps Take It. So stock.take is
// a READ in the registry, open to every role (the crew's own verb), offered to Nort through the
// read set and never the write set, and it takes no money in. list_shelf is its read, open to all.
describe("action registry — stock.take is a fill, never a take", () => {
  it("is a read open to every role, offered to a tech and to the office, and not a write power", () => {
    const a = REGISTRY["stock.take"];
    expect(a).toBeDefined();
    expect(a.auth).toBe("any");
    expect(a.effect).toBe("read");
    expect(a.confirm).toBeUndefined();
    expect(AGENT_WRITE_ALLOWED.has("stock.take")).toBe(false);
    for (const role of ["tech", "office", "owner"]) expect(agentWriteToolsForRole(role).tools.map((t) => t.name)).toContain("stock__take");
    expect(agentWriteToolsForRole("tech").resolve("stock__take")).toBe("stock.take");
  });

  it("takes a job, an item, a count and a unit: no money field, and the item and job are required", () => {
    const schema = REGISTRY["stock.take"].input as any;
    expect(Object.keys(schema.shape).sort()).toEqual(["item", "job_id", "qty", "unit"]);
    expect(schema.safeParse({ job_id: "Herringbone", item: "12/2", qty: 60 }).success).toBe(true);
    expect(schema.safeParse({ job_id: "Herringbone", item: "12/2" }).success).toBe(true); // the pad asks how many
    expect(schema.safeParse({ item: "12/2", qty: 60 }).success).toBe(false); // which job?
    expect(schema.safeParse({ job_id: "Herringbone", qty: 60 }).success).toBe(false); // which item?
    expect(REGISTRY["stock.take"].description).toMatch(/does NOT take anything/);
  });

  it("list_shelf is a data tool for everyone; inventory.adjust stays retired", () => {
    expect(DATA_TOOLS.find((d) => d.name === "list_shelf")).toBeDefined();
    expect(REGISTRY["inventory.adjust"]).toBeUndefined();
  });
});
