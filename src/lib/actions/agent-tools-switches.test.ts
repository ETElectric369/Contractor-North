import { describe, it, expect } from "vitest";
import { AGENT_READ_ALLOWED, AGENT_TOOL_FEATURE, AGENT_WRITE_ALLOWED, agentWriteToolsForRole } from "./agent-tools";
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
});
