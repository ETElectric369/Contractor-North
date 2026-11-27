import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_DEADLINE_MS, CAPTURE_IMAGE_WAIT_MS, withDeadline } from "./bug-shot-copy";

/**
 * THE PICTURE NEVER HOLDS THE REPORT (cn-v1204). The bug button fetches the screenshot library when
 * it is tapped and lets it draw the page; neither had a clock, so on a weak signal, or with a
 * picture on the page that would not load, the button could spin with the panel never opening: a
 * person who could not report a problem at all. Now the capture has one deadline. Past it the panel
 * opens with no picture, and the panel only says a screenshot is attached when one is.
 */
afterEach(() => vi.useRealTimers());

describe("withDeadline", () => {
  it("hands back the work's own answer when it lands in time, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const got = withDeadline(Promise.resolve("picture"), 8000, "none");
    await expect(got).resolves.toBe("picture");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers `late` at the deadline when the work never settles, and not a moment before", async () => {
    vi.useFakeTimers();
    let answer: string | undefined;
    void withDeadline(new Promise<string>(() => {}), 8000, "none").then((v) => (answer = v));
    await vi.advanceTimersByTimeAsync(7999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBe("none");
  });

  it("answers `late` when the work fails, and never rejects", async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.reject(new Error("boom")), 8000, "none")).resolves.toBe("none");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a picture that lands after the deadline", async () => {
    vi.useFakeTimers();
    let land!: (v: string) => void;
    const slow = new Promise<string>((r) => (land = r));
    let answer: string | undefined;
    void withDeadline(slow, 8000, "none").then((v) => (answer = v));
    await vi.advanceTimersByTimeAsync(8000);
    land("picture");
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe("none");
  });
});

describe("the bug button's capture", () => {
  const reporter = readFileSync(join(process.cwd(), "src/components/bug-reporter.tsx"), "utf8");

  it("waits eight seconds at most, and a slow picture on the page costs that picture, not the capture", () => {
    expect(CAPTURE_DEADLINE_MS).toBe(8000);
    expect(CAPTURE_IMAGE_WAIT_MS).toBe(4000);
    expect(CAPTURE_IMAGE_WAIT_MS).toBeLessThan(CAPTURE_DEADLINE_MS);
  });

  it("runs the whole capture, the library's download included, under the one deadline", () => {
    expect(reporter).toContain("return withDeadline(drawScreen(), CAPTURE_DEADLINE_MS, NO_SHOT);");
    // The library is fetched INSIDE the work the deadline covers, never at the top of the file.
    expect(reporter).not.toMatch(/^import .*html2canvas-pro/m);
    const draw = reporter.slice(reporter.indexOf("async function drawScreen()"), reporter.indexOf("function captureScreen()"));
    expect(draw).toContain('(await import("html2canvas-pro")).default');
    expect(draw).toContain("imageTimeout: CAPTURE_IMAGE_WAIT_MS,");
    // openPanel still waits on captureScreen and nothing else before it opens the panel.
    expect(reporter).toContain("const shot = await captureScreen();");
  });

  it("says a screenshot is attached only when there is one, the file or the copy kept on the row", () => {
    expect(reporter).toContain("{collaborator || (!shotRef.current && !copyRef.current) ? (");
    expect(reporter).toContain('of this screen ✓, this page');
    expect(reporter).not.toContain('{shotRef.current ? " ✓" : ""}');
  });
});
