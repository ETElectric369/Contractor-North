import { describe, it, expect } from "vitest";
import { COPY_MAX_CHARS, COPY_PREFIX, captureScale, cleanCopy, isCopyColumnMissing, isCopyRefused, pickCopy } from "./bug-shot-copy";

/**
 * A BUG REPORT'S PICTURE, IN THE ROW (cn-v1175, 0412). The owner: "if you cant open screenshots from
 * the bug reports then that needs to be fixed right?", and "now its a provisional tiny versions of
 * it, just sayin". The capture's size, the size loop and the server's check, as tables.
 */
const url = (chars: number) => COPY_PREFIX + "A".repeat(Math.max(0, chars - COPY_PREFIX.length));

describe("the capture is drawn big enough to read", () => {
  it.each([
    ["a phone", 390, 1],
    ["a narrow phone", 320, 1],
    ["a tablet", 768, 640 / 768],
    ["a small laptop", 1024, 0.625],
    ["a desktop", 1440, 0.6],
    ["a wide desktop", 2560, 0.6],
    ["no width", 0, 0.6],
    ["a negative width", -5, 0.6],
    ["not a number", Number.NaN, 0.6],
    ["infinity", Number.POSITIVE_INFINITY, 0.6],
  ])("%s (%d px) draws at %d", (_n, width, scale) => {
    expect(captureScale(width as number)).toBeCloseTo(scale as number, 6);
  });

  it("a 390-px phone is no longer 234 px wide", () => {
    expect(Math.round(390 * captureScale(390))).toBe(390);
  });
});

describe("the size loop: the capture's own width first, the first try under the cap wins, none and nothing is sent", () => {
  const sized = (size: (w: number, q: number) => number) => {
    const calls: string[] = [];
    const encode = (w: number, q: number) => {
      calls.push(`${w}@${q}`);
      return url(size(w, q));
    };
    return { calls, encode };
  };

  it.each([
    ["a phone capture, at its own width at once", 390, () => 120_000, ["390@0.6"], true],
    ["a desktop capture, at its own width, not cut to 640", 864, () => 250_000, ["864@0.6"], true],
    ["over at 0.6, under at 0.45, still its own width", 864, (_w: number, q: number) => (q === 0.6 ? 350_000 : 280_000), ["864@0.6", "864@0.45"], true],
    ["over at its own width both ways, under at 640", 1200, (w: number) => (w === 1200 ? 500_000 : 200_000), ["1200@0.6", "1200@0.45", "640@0.45"], true],
    ["under only at 480", 1200, (w: number) => (w === 480 ? 150_000 : 500_000), ["1200@0.6", "1200@0.45", "640@0.45", "480@0.4"], true],
    ["over at every try: none", 1200, () => 900_000, ["1200@0.6", "1200@0.45", "640@0.45", "480@0.4"], false],
    ["a capture narrower than a step draws each size once", 500, () => 900_000, ["500@0.6", "500@0.45", "480@0.4"], false],
    ["a capture narrower than every step", 300, () => 900_000, ["300@0.6", "300@0.45", "300@0.4"], false],
  ])("%s", (_name, width, size, calls, found) => {
    const s = sized(size as (w: number, q: number) => number);
    const got = pickCopy(width as number, s.encode);
    expect(s.calls).toEqual(calls);
    expect(got !== null).toBe(found);
    if (got) expect(got.length).toBeLessThanOrEqual(COPY_MAX_CHARS);
  });

  it.each([
    ["an encoder that throws", () => { throw new Error("tainted"); }],
    ["an encoder that answers null", () => null],
    ["a PNG", () => "data:image/png;base64,AAAA"],
    ["an empty data URL", () => "data:,"],
  ])("%s: no copy, no throw", (_n, encode) => {
    expect(pickCopy(800, encode as (w: number, q: number) => string | null)).toBeNull();
  });

  it("a capture with no width: no copy, nothing drawn", () => {
    let drew = false;
    expect(pickCopy(0, () => ((drew = true), url(100)))).toBeNull();
    expect(pickCopy(Number.NaN, () => ((drew = true), url(100)))).toBeNull();
    expect(drew).toBe(false);
  });
});

describe("the server's check: keep a JPEG data URL under the cap, drop anything else", () => {
  it.each([
    ["a JPEG data URL", url(5_000), true],
    ["exactly at the cap", url(COPY_MAX_CHARS), true],
    ["one over the cap", url(COPY_MAX_CHARS + 1), false],
    ["the prefix alone", COPY_PREFIX, false],
    ["a PNG", "data:image/png;base64,AAAA", false],
    ["a link", "https://example.test/a.jpg", false],
    ["a number", 42, false],
    ["nothing", undefined, false],
    ["null", null, false],
  ])("%s", (_n, v, kept) => {
    expect(cleanCopy(v)).toBe(kept ? v : null);
  });

  it("the cap and the prefix are 0412's", () => {
    expect(COPY_MAX_CHARS).toBe(300_000);
    expect(COPY_PREFIX).toBe("data:image/jpeg;base64,");
    expect(COPY_PREFIX.length).toBe(23);
  });
});

describe("before 0412 is applied, the report still files", () => {
  it.each([
    ["Postgres: undefined column", { code: "42703", message: 'column "screenshot_copy" of relation "bug_reports" does not exist' }, true],
    ["PostgREST: not in the schema cache", { code: "PGRST204", message: "Could not find the 'screenshot_copy' column of 'bug_reports' in the schema cache" }, true],
    ["the words alone", { message: "Could not find the 'screenshot_copy' column" }, true],
    ["a refused insert", { code: "42501", message: "new row violates row-level security policy" }, false],
    ["nothing", null, false],
  ])("%s", (_n, err, missing) => {
    expect(isCopyColumnMissing(err)).toBe(missing);
  });

  it("0412's check refusing the copy is told apart from any other check", () => {
    expect(isCopyRefused({ code: "23514", message: 'new row for relation "bug_reports" violates check constraint "bug_reports_screenshot_copy_shape"' })).toBe(true);
    expect(isCopyRefused({ code: "23514", message: 'violates check constraint "bug_reports_status_check"' })).toBe(false);
    expect(isCopyRefused({ code: "23505", message: "screenshot_copy" })).toBe(false);
  });
});
