/**
 * Sweep 2026-10-26: the ops sink held 32 "trace turn 0" rows whose only lines were "screen hidden"
 * and "screen visible" — the phone locked and unlocked with the app open, no Nort turn at all. The
 * "screen hidden" line is written while the page is hidden, so it carried the (hidden) mark that
 * means "something ran dark", and every unlock flushed a row. The screen's own two lines are never
 * news; a stage of a turn that ran dark still is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const reports: Array<{ title: string; extra: Record<string, string> }> = [];
vi.mock("@/app/report-client-error", () => ({
  reportClientError: vi.fn(async (_where: string, title: string, extra: Record<string, string>) => {
    reports.push({ title, extra });
  }),
}));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => true }));

let listeners: Array<() => void> = [];
let state = "visible";
function stubDocument() {
  listeners = [];
  vi.stubGlobal("document", {
    get visibilityState() {
      return state;
    },
    addEventListener(_name: string, fn: () => void) {
      listeners.push(fn);
    },
    removeEventListener() {},
  });
}
function screen(next: "hidden" | "visible") {
  state = next;
  for (const l of listeners) l();
}

describe("trace: the screen's own lines never make a row", () => {
  beforeEach(() => {
    reports.length = 0;
    state = "visible";
    stubDocument();
    vi.resetModules();
  });

  it("lock and unlock with no turn files nothing, however many times", async () => {
    const { trace } = await import("@/lib/nort/trace");
    trace("assistant mounted", "/planner");
    for (let i = 0; i < 4; i++) {
      screen("hidden");
      screen("visible");
    }
    expect(reports).toEqual([]);
  });

  it("a route change while dark is still news", async () => {
    const { trace } = await import("@/lib/nort/trace");
    trace("assistant mounted", "/planner");
    screen("hidden");
    trace("assistant unmounted", "/planner");
    screen("visible");
    expect(reports).toHaveLength(1);
    expect(reports[0].extra.lines).toContain("assistant unmounted /planner (hidden)");
  });

  it("a stage of a turn that ran dark is filed when the screen comes back, under the turn's number", async () => {
    const { trace } = await import("@/lib/nort/trace");
    trace("turn", "1");
    screen("hidden");
    trace("say sent", "12 chars");
    screen("visible");
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toMatch(/^trace turn 1 \(load [a-z0-9]+, flush 1\)$/);
    expect(reports[0].extra.why).toBe("screen back");
    expect(reports[0].extra.lines).toContain("say sent 12 chars (hidden)");
    expect(reports[0].extra.lines).toContain("screen hidden (hidden)");
    screen("hidden");
    screen("visible");
    expect(reports).toHaveLength(1);
  });
});
