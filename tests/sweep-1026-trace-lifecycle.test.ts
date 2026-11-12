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
  /* Sweep 2026-11-11: two "trace turn 0" rows in one afternoon held nothing but "assistant mounted
   * (hidden)", "fence watch armed (hidden)" and "screen visible" — the shell had been woken in the
   * background and the page mounted dark. A page that loads in the dark is not news. */
  it("a page that mounts in the dark files nothing when the screen comes on", async () => {
    state = "hidden";
    const { trace } = await import("@/lib/nort/trace");
    trace("assistant mounted", "/planner");
    trace("fence watch", "armed");
    screen("visible");
    expect(reports).toEqual([]);
    screen("hidden");
    screen("visible");
    expect(reports).toEqual([]);
  });

  it("a fence reading that ran in the dark is still news, and the mount lines ride with it", async () => {
    state = "hidden";
    const { trace } = await import("@/lib/nort/trace");
    trace("assistant mounted", "/planner");
    trace("fence watch", "armed");
    trace("fence check", "may read anchor=yes");
    screen("visible");
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toMatch(/^trace turn 0 \(load [a-z0-9]+, flush 1\)$/);
    expect(reports[0].extra.lines).toContain("assistant mounted /planner (hidden)");
    expect(reports[0].extra.lines).toContain("fence watch armed (hidden)");
    expect(reports[0].extra.lines).toContain("fence check may read anchor=yes (hidden)");
  });

  it("only the two mount lines are quiet: the rule names them, and nothing a turn or a fence reading writes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/nort/trace.ts", "utf8");
    expect(src).toContain('const MOUNT_LINES = new Set(["assistant mounted", "fence watch"]);');
    expect(src).toContain("if (hidden && !SCREEN_LINES.has(stage) && !MOUNT_LINES.has(stage)) hiddenSeen = true;");
  });
});
