import { describe, it, expect, vi, beforeEach } from "vitest";
import { ALL_ON, type FeatureKey, type FeatureMap } from "@/lib/features";

/**
 * THE YES ON A NORT CONFIRM CARD, AND THE SWITCHES (0352). The card was proposed while the chat
 * offered the tool; the Yes runs by the switches as they are when it is tapped. A feature switched
 * off in between (or Nort itself) is refused in the shared plain sentence, before anything runs, and
 * a switched-off feature's fields come off exactly as they do in the chat. No switches stored: the
 * Yes runs exactly what it ran before.
 */
let features: FeatureMap = ALL_ON;
vi.mock("@/lib/viewer-switches", async (orig) => ({
  ...(await orig<typeof import("@/lib/viewer-switches")>()),
  viewerSwitches: async () => ({ features, isOwner: true }),
}));
const executeAction = vi.fn(async (..._a: unknown[]) => ({ ok: true, speak: "Done — added." }) as Record<string, unknown>);
vi.mock("@/lib/actions/execute", () => ({ executeAction: (...a: unknown[]) => executeAction(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn() }));

const { confirmAgentAction } = await import("./actions");
const off = (...keys: FeatureKey[]): FeatureMap => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) });

beforeEach(() => {
  features = ALL_ON;
  executeAction.mockClear();
});

describe("confirmAgentAction and the switches", () => {
  it("everything on: runs the confirmed input as given", async () => {
    const input = { job_id: "j1", prelim_sent_at: "2026-09-26" };
    const res = await confirmAgentAction("lien.update", input);
    expect(res).toEqual({ ok: true, message: "Done — added." });
    expect(executeAction).toHaveBeenCalledWith("lien.update", input, { source: "agent", confirmed: true });
  });

  it("the tool's feature switched off since the card: refused in words, nothing runs", async () => {
    features = off("contracts");
    const res = await confirmAgentAction("lien.update", { job_id: "j1" });
    expect(res).toEqual({ ok: false, message: "Contracts & Lien Rights is off. The owner can turn it on in Settings, Features." });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("Nort switched off since the card: refused, nothing runs", async () => {
    features = off("nort");
    const res = await confirmAgentAction("task.create", { title: "x" });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("Nort is off. The owner can turn it on in Settings, Features.");
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("To-Do Extras off: the task runs without its priority and parent, and the Yes says so", async () => {
    features = off("todo_extras");
    const res = await confirmAgentAction("task.create", { title: "Pull wire", priority: 1, parent_id: "t0" });
    expect(executeAction).toHaveBeenCalledWith("task.create", { title: "Pull wire" }, { source: "agent", confirmed: true });
    expect(res.ok).toBe(true);
    expect(res.message).toBe(
      "Done — added. To-Do Extras is off, so this to-do was saved without a priority or a parent task. The owner can turn it on in Settings, Features.",
    );
  });
});
