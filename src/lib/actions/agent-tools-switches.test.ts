import { describe, it, expect } from "vitest";
import {
  AGENT_READ_ALLOWED,
  AGENT_TOOL_FEATURE,
  AGENT_WRITE_ALLOWED,
  agentInputForSwitches,
  agentToolOff,
  agentWriteToolsForRole,
} from "./agent-tools";
import { ALL_ON, FEATURE_KEYS, featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";

/**
 * NORT'S WRITE TOOLS AND THE SWITCH BOARD (0352). A switched-off feature's write tools are not
 * offered; Nort off takes them all (the chat route refuses the turn before this, too). Reads stay,
 * and so do the tools that bill a record that already exists. No switches stored = the same tools
 * as before, name for name.
 */
const ROLES = ["owner", "admin", "office", "tech"];
const names = (role: string, f?: FeatureMap) => agentWriteToolsForRole(role, f).tools.map((t) => t.name);
const toolName = (action: string) => action.replace(/\./g, "__");
const off = (...keys: FeatureKey[]): FeatureMap => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) });

describe("agentWriteToolsForRole and the switches", () => {
  it("everything on offers exactly what it did before", () => {
    for (const role of ROLES) expect(names(role, ALL_ON)).toEqual(names(role));
  });

  it("every switch-owned tool is one Nort is offered at all", () => {
    for (const action of Object.keys(AGENT_TOOL_FEATURE))
      expect(AGENT_WRITE_ALLOWED.has(action) || AGENT_READ_ALLOWED.has(action), action).toBe(true);
  });

  for (const key of FEATURE_KEYS) {
    it(`${key} off takes exactly its own tools (and its sub-switches'), for every role`, () => {
      const features = off(key);
      for (const role of ROLES) {
        const before = names(role);
        const after = names(role, features);
        const expected = before.filter((n) => {
          const action = Object.keys(AGENT_TOOL_FEATURE).find((a) => toolName(a) === n);
          if (key === "nort") return false;
          return !action || featureOn(features, AGENT_TOOL_FEATURE[action]);
        });
        expect(after, `${role} with ${key} off`).toEqual(expected);
      }
    });
  }

  it("each switch-owned tool that the owner is offered really goes when its switch is off", () => {
    for (const [action, key] of Object.entries(AGENT_TOOL_FEATURE)) {
      if (!names("owner").includes(toolName(action))) continue;
      expect(names("owner", off(key)), `${action} with ${key} off`).not.toContain(toolName(action));
    }
    // The ones Erik's crew reaches for, spelled out.
    expect(names("owner", off("leads"))).not.toContain("inquiry__create");
    expect(names("tech", off("shop_stock"))).not.toContain("stock__take");
    expect(names("owner", off("panel_map"))).not.toContain("panel__suggest");
    expect(names("owner", off("licenses"))).not.toContain("safety__log");
  });

  it("Nort off: nothing at all", () => {
    for (const role of ROLES) expect(names(role, off("nort"))).toEqual([]);
  });

  it("a tool that bills an existing record stays when its feature is off", () => {
    const got = names("owner", off("estimates", "contracts"));
    expect(got).toContain("invoice__fromQuote");
    expect(got).toContain("payment__requestNext");
    expect(got).not.toContain("quote__create");
    expect(got).not.toContain("contract__generate");
    expect(got).not.toContain("payment__setSchedule");
  });

  it("the resolver follows the offer: a tool not offered resolves to nothing", () => {
    const { resolve } = agentWriteToolsForRole("owner", off("permits"));
    expect(resolve("permit__create")).toBeNull();
    expect(resolve("task__create")).toBe("task.create");
  });

  it("the write tools the round-1 review named each go with their own switch", () => {
    const own: [string, FeatureKey][] = [
      ["stock.take", "shop_stock"],
      ["permit.create", "permits"],
      ["compliance.create", "licenses"],
      ["safety.log", "safety_log"],
      ["form.submit", "safety_log"],
      ["contract.generate", "contracts"],
      ["lien.update", "contracts"],
      ["payment.setSchedule", "contracts"],
    ];
    for (const [action, key] of own) {
      expect(AGENT_TOOL_FEATURE[action], action).toBe(key);
      expect(agentToolOff(action, off(key)), action).toBe(key);
      expect(agentToolOff(action, ALL_ON), action).toBeNull();
    }
    // A sub-switch goes with its parent; Nort off outranks every tool's own switch.
    expect(agentToolOff("safety.log", off("licenses"))).toBe("safety_log");
    expect(agentToolOff("task.create", off("nort"))).toBe("nort");
    expect(agentToolOff("task.create", off("permits"))).toBeNull();
  });
});

describe("agentInputForSwitches: a switched-off feature's fields on a tool that stays", () => {
  const task = { title: "Order the panel", priority: 2, parent_id: "t-parent", due_date: "2026-10-01" };

  it("To-Do Extras on, or no switches stored: every field runs exactly as given", () => {
    for (const f of [undefined, ALL_ON]) {
      const r = agentInputForSwitches("task.create", task, f);
      expect(r.input).toBe(task);
      expect(r.dropped).toBeNull();
    }
  });

  it("To-Do Extras off: a Reminder's priority and parent task come off, the rest stays, and it is said in words", () => {
    const r = agentInputForSwitches("task.create", task, off("todo_extras"));
    expect(r.input).toEqual({ title: "Order the panel", due_date: "2026-10-01" });
    expect(r.dropped).toBe(
      "To-Do Extras is off, so this Reminder was saved without a priority or a parent task. The owner can turn it on in Settings, Features.",
    );
    // Only what was actually asked for is named; a normal priority (0) and no parent say nothing.
    expect(agentInputForSwitches("task.create", { title: "x", priority: 1 }, off("todo_extras")).dropped).toContain("without a priority.");
    const plain = agentInputForSwitches("task.create", { title: "x", priority: 0, parent_id: null }, off("todo_extras"));
    expect(plain.input).toEqual({ title: "x" });
    expect(plain.dropped).toBeNull();
  });

  it("To-Do Extras is the Reminders' switch (0358): a job's task passes untouched (task.create itself leaves a priority off a job's list and says so)", () => {
    const onJob = { title: "Hang the panel", job_id: "11111111-1111-1111-1111-111111111111", priority: 2 };
    for (const f of [off("todo_extras"), ALL_ON]) {
      const r = agentInputForSwitches("task.create", onJob, f);
      expect(r.input).toBe(onJob);
      expect(r.dropped).toBeNull();
    }
  });

  it("no other tool's input is touched by To-Do Extras (Sales Tax is refused by the quote tools themselves)", () => {
    const quote = { customer_id: null, title: "Panel", tax_rate: 0.0825, items: [] };
    expect(agentInputForSwitches("quote.create", quote, off("todo_extras", "sales_tax")).input).toBe(quote);
    const upd = { id: "t1", priority: 2 };
    expect(agentInputForSwitches("task.setDue", upd, off("todo_extras")).input).toBe(upd);
  });
});
