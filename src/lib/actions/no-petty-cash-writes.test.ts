import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY } from "./registry";
import { AGENT_WRITE_ALLOWED, agentWriteToolsForRole } from "./agent-tools";

/**
 * NORT STOPS WRITING PETTY CASH (W1-34). A cash purchase is a cost like any other (a paid bill on its
 * job), and a bank's ATM line is Cash Taken Out (Not A Cost). So the write left Nort's tools, the
 * registry and its entity together, and the prompt that sent a bought item to it names bill.create:
 * a tool the prompt names that no longer exists would be a door Nort walks into. Reading petty cash
 * (list_petty_cash) stays: every entry already written still counts.
 */
const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Nort writes no petty cash", () => {
  it("pettycash.add is in no registry, no allowlist and no tool an owner is offered", () => {
    expect(REGISTRY["pettycash.add"]).toBeUndefined();
    expect(AGENT_WRITE_ALLOWED.has("pettycash.add")).toBe(false);
    expect(agentWriteToolsForRole("owner").tools.map((t) => t.name)).not.toContain("pettycash__add");
    expect(existsSync(join(ROOT, "src/lib/actions/entities/pettyCash.ts"))).toBe(false);
    expect(src("src/lib/actions/registry.ts")).not.toMatch(/pettyCash/);
  });

  it("the chat prompt sends a bought item with a stated price to bill.create, paid, as Materials", () => {
    const route = src("src/app/api/chat/route.ts");
    expect(route).not.toContain("pettycash.add");
    expect(route.match(/bill\.create with the job_id, status paid, category Materials/g)).toHaveLength(2);
    // bill.create is a tool Nort really has (confirm-gated: money).
    expect(AGENT_WRITE_ALLOWED.has("bill.create")).toBe(true);
    expect(REGISTRY["bill.create"]?.confirm).toBe("financial");
  });

  it("reading petty cash stays (every entry already written still counts)", () => {
    expect(src("src/lib/assistant-tools.ts")).toContain('name: "list_petty_cash"');
    expect(src("src/app/api/chat/route.ts")).toContain('"list_petty_cash"');
  });
});
