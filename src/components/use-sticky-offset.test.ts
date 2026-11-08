import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachStickyOffset, stickTopPx, STICK_TOP_VAR, useStickyOffset } from "./use-sticky-offset";

/**
 * THE WEEK LINE'S HEIGHT AS A CSS VARIABLE (cn-v1151): the grid's day-header strip sticks under the
 * caller's own week line, at a `top` only the caller can measure. The hook writes that measurement onto an
 * ancestor with style.setProperty — no state, no render — and follows the line as it resizes.
 *
 * The unit project runs in plain Node (no DOM), so the hook's whole effect is tested through
 * attachStickyOffset with fake elements and a fake ResizeObserver; the hook itself is pinned as that
 * effect inside useLayoutEffect, reading the real observer only when there is one.
 */
describe("stickTopPx", () => {
  it.each([
    [30, "30px"],
    [41, "41px"],
    [0, "0px"],
    [-4, "0px"],
    [Number.NaN, "0px"],
  ])("%s → %s", (height, px) => {
    expect(stickTopPx(height)).toBe(px);
  });
});

describe("attachStickyOffset — the hook's effect, with a fake observer and no DOM", () => {
  const fakes = (height: number) => {
    const line = { offsetHeight: height };
    const vars = new Map<string, string>();
    const host = {
      style: {
        setProperty: (name: string, value: string) => void vars.set(name, value),
        removeProperty: (name: string) => void vars.delete(name),
      },
    };
    return { line: line as unknown as HTMLElement, host: host as unknown as HTMLElement, raw: line, vars };
  };
  class FakeResizeObserver {
    static made: FakeResizeObserver[] = [];
    observed: unknown[] = [];
    disconnected = false;
    constructor(public onResize: () => void) {
      FakeResizeObserver.made.push(this);
    }
    observe(target: unknown) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  it("sets --grid-stick-top to the line's height at once, watches the line, and follows a resize", () => {
    const { line, host, raw, vars } = fakes(30);
    const undo = attachStickyOffset(line, host, FakeResizeObserver);
    expect(vars.get(STICK_TOP_VAR)).toBe("30px");
    expect(STICK_TOP_VAR).toBe("--grid-stick-top");
    const watcher = FakeResizeObserver.made.at(-1)!;
    expect(watcher.observed).toEqual([line]);
    // The line wraps onto a second row on a narrow phone: the observer fires, the variable follows.
    raw.offsetHeight = 47;
    watcher.onResize();
    expect(vars.get(STICK_TOP_VAR)).toBe("47px");
    // Unmount: the observer is let go and the variable taken off the host.
    undo();
    expect(watcher.disconnected).toBe(true);
    expect(vars.has(STICK_TOP_VAR)).toBe(false);
  });

  it("with no ResizeObserver it measures once, and a line with no height is 0px", () => {
    const { line, host, vars } = fakes(28);
    const before = FakeResizeObserver.made.length;
    const undo = attachStickyOffset(line, host);
    expect(vars.get(STICK_TOP_VAR)).toBe("28px");
    expect(FakeResizeObserver.made.length).toBe(before);
    undo();
    expect(vars.size).toBe(0);
    const flat = fakes(0);
    attachStickyOffset(flat.line, flat.host);
    expect(flat.vars.get(STICK_TOP_VAR)).toBe("0px");
  });

  it("the hook is that effect inside useLayoutEffect, the real observer only when there is one, no state, SSR-safe", () => {
    // Importing it in plain Node (no window, no ResizeObserver) already worked, which is the SSR half.
    expect(typeof window).toBe("undefined");
    expect(typeof ResizeObserver).toBe("undefined");
    expect(typeof useStickyOffset).toBe("function");
    const src = readFileSync(join(process.cwd(), "src/components/use-sticky-offset.ts"), "utf8");
    const hook = src.slice(src.indexOf("export function useStickyOffset("));
    expect(hook).toContain("useLayoutEffect(() => {");
    expect(hook).toContain("if (!line || !host) return;");
    expect(hook).toContain('return attachStickyOffset(line, host, typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);');
    expect(src).not.toMatch(/useState|setState|useEffect\(/);
    // The one name, written here and read by the grid's strip.
    const grid = readFileSync(join(process.cwd(), "src/components/time-grid.tsx"), "utf8");
    expect(grid).toContain(`top: "var(${STICK_TOP_VAR}, 0px)"`);
  });
});
