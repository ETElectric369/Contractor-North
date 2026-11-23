import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE FILE-DRAG STORE NEVER OUTLIVES THE DRAG (cn-v1186; the owner: "stuck", then "i didnt try to
 * drop anything there it did that on its own when i clicked on bills"). A drop on a DropTarget stops
 * its propagation, so a bubble-phase window listener never heard it and the store said "dragging" for
 * the life of the tab; Bills' page-wide layer then covered the page with nothing to dismiss it.
 *
 * No DOM library: a hand-made window records each listener with its options and lets the test fire it.
 */

type Listener = (e: any) => void;
type Registered = { type: string; fn: Listener; options: unknown };

let registered: Registered[] = [];

function fire(type: string, e: Record<string, unknown> = {}) {
  const event = { preventDefault: vi.fn(), ...e };
  for (const r of registered.filter((x) => x.type === type)) r.fn(event);
  return event;
}
const files = { dataTransfer: { types: ["Files"] } };
const text = { dataTransfer: { types: ["text/plain"] } };

async function freshStore() {
  vi.resetModules();
  const mod = await import("./drop-target");
  const told = vi.fn();
  mod.subscribeFileDrag(told);
  return { ...mod, told };
}

beforeEach(() => {
  vi.useFakeTimers();
  registered = [];
  (globalThis as any).window = {
    addEventListener: (type: string, fn: Listener, options: unknown) => registered.push({ type, fn, options }),
  };
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

describe("the window's file-drag store", () => {
  it("registers every window listener in the capture phase, once", async () => {
    const s = await freshStore();
    s.subscribeFileDrag(() => {});
    const types = registered.map((r) => r.type).sort();
    expect(types).toEqual(["dragend", "dragenter", "dragleave", "dragover", "dragstart", "drop", "keydown", "pointerdown"]);
    for (const r of registered) expect(r.options).toEqual({ capture: true });
  });

  it("a drag begun inside the page whose end was never heard is forgotten at the next pointer press", async () => {
    const s = await freshStore();
    fire("dragstart");
    fire("dragenter", files);
    expect(s.fileDragActive()).toBe(false);
    // No dragend ever comes (the dragged element left the page). A press means that drag is over.
    fire("pointerdown");
    fire("dragenter", files);
    expect(s.fileDragActive()).toBe(true);
  });

  it("a Files dragenter turns it on and tells the subscribers", async () => {
    const s = await freshStore();
    fire("dragenter", files);
    expect(s.fileDragActive()).toBe(true);
    expect(s.told).toHaveBeenCalledTimes(1);
  });

  it("a drag that carries no Files does nothing", async () => {
    const s = await freshStore();
    fire("dragenter", text);
    fire("dragover", text);
    expect(s.fileDragActive()).toBe(false);
    expect(s.told).not.toHaveBeenCalled();
  });

  it("a drop ends it only after the timer tick, so the layer under the cursor still takes the drop", async () => {
    const s = await freshStore();
    fire("dragenter", files);
    const drop = fire("drop", files);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(s.fileDragActive()).toBe(true);
    await Promise.resolve();
    expect(s.fileDragActive()).toBe(true);
    vi.advanceTimersByTime(0);
    expect(s.fileDragActive()).toBe(false);
  });

  it("dragend ends it after the tick as well", async () => {
    const s = await freshStore();
    fire("dragenter", files);
    fire("dragend");
    expect(s.fileDragActive()).toBe(true);
    vi.advanceTimersByTime(0);
    expect(s.fileDragActive()).toBe(false);
  });

  it("silence for 1,200 ms ends it; a dragover inside that time keeps it", async () => {
    const s = await freshStore();
    fire("dragenter", files);
    vi.advanceTimersByTime(800);
    fire("dragover", files);
    vi.advanceTimersByTime(800);
    expect(s.fileDragActive()).toBe(true);
    vi.advanceTimersByTime(1200);
    expect(s.fileDragActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a dragover heals a missed dragenter, and keeps the tab from opening the file", async () => {
    const s = await freshStore();
    const over = fire("dragover", files);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(s.fileDragActive()).toBe(true);
  });

  it("a drag begun inside the page never turns it on, and the next file drag still does", async () => {
    const s = await freshStore();
    fire("dragstart");
    fire("dragenter", files);
    const over = fire("dragover", files);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(s.fileDragActive()).toBe(false);
    fire("dragend");
    vi.advanceTimersByTime(0);
    fire("dragenter", files);
    expect(s.fileDragActive()).toBe(true);
  });

  it("Escape ends it", async () => {
    const s = await freshStore();
    fire("dragenter", files);
    const key = fire("keydown", { key: "Escape" });
    expect(s.fileDragActive()).toBe(false);
    expect(key.preventDefault).not.toHaveBeenCalled();
  });

  it("endFileDrag ends it and tells the subscribers once; idle, it tells nobody", async () => {
    const s = await freshStore();
    fire("dragenter", files);
    fire("dragenter", files);
    s.told.mockClear();
    s.endFileDrag();
    expect(s.fileDragActive()).toBe(false);
    expect(s.told).toHaveBeenCalledTimes(1);
    s.endFileDrag();
    expect(s.told).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is inert on the server", async () => {
    delete (globalThis as any).window;
    const s = await freshStore();
    expect(registered).toEqual([]);
    expect(s.fileDragActive()).toBe(false);
  });
});

describe("Bills' page-wide drop layer", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/bills/bills-drop.tsx"), "utf8");
  const layer = src.slice(src.indexOf("{dragging && ("), src.indexOf("Drop Papers Here"));
  it("a tap on it ends the drag", () => {
    expect(layer).toContain("onClick={endFileDrag}");
  });
  it("it never stops the drop from propagating", () => {
    expect(layer).not.toMatch(/stopPropagation/);
    expect(layer).toContain("snapFiles(");
  });
});
