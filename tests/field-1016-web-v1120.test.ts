/**
 * cn-v1120 (2026-10-16): storage's refusal in plain words, and the 3D Scan door that stops offering
 * a file that can never go.
 *
 * Erik, the night the first whole-room model went up: the Inspector showed storage's own sentence
 * ("The object exceeded the maximum allowed size") and then offered to send the same file again —
 * a dead end, since the size never changes. Now the refusal names the file and its size, the door
 * drops the kept copy when the refusal is final, and a signal failure still keeps the file for
 * another tap.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { megabytes, uploadRefusal } from "@/lib/upload-words";
import { keptWords } from "@/lib/native-scan";
import { APP_VERSION } from "@/lib/version";
import { RELEASE_NOTES, versionNumber } from "@/lib/release-notes";

const read = (p: string) => readFileSync(p, "utf8");

describe("uploadRefusal: storage's sentence in plain words", () => {
  it("over the limit is FINAL and names the file and its size", () => {
    const e = { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" };
    expect(uploadRefusal(e, { what: "The 3D model", bytes: 61_924_578, action: "Scan a smaller area." })).toEqual({ sentence: "The 3D model is too big to send (62 MB). Scan a smaller area.", final: true });
    expect(uploadRefusal({ message: "Payload too large" }, { what: "plans.pdf", bytes: 7_480_000, action: "Send a smaller file." })).toEqual({ sentence: "plans.pdf is too big to send (7.5 MB). Send a smaller file.", final: true });
    // the code alone, should storage reword it
    expect(uploadRefusal({ statusCode: "413", message: "Something new" }, { what: "a.pdf", bytes: 10, action: "Send a smaller file." })).toMatchObject({ final: true });
    expect(uploadRefusal({ status: 413 }, { what: "a.pdf", bytes: 10, action: "Send a smaller file." })).toMatchObject({ final: true });
  });
  it("no signal is NOT final: the file waits for service", () => {
    const o = { bytes: 400_000, action: "Send a smaller file." };
    expect(uploadRefusal(new TypeError("Failed to fetch"), { what: "IMG_0412.jpeg", ...o })).toEqual({ sentence: "IMG_0412.jpeg didn't go: no signal. Try again where there's service.", final: false });
    expect(uploadRefusal(new TypeError("Load failed"), { what: "The 3D model", ...o })).toMatchObject({ final: false });
  });
  it("anything else is said as it came, and nothing at all is Upload failed.", () => {
    const o = { what: "a.pdf", bytes: 10, action: "Send a smaller file." };
    expect(uploadRefusal(new Error("new row violates row-level security policy"), o)).toEqual({ sentence: "new row violates row-level security policy", final: false });
    expect(uploadRefusal(null, o)).toEqual({ sentence: "Upload failed.", final: false });
    expect(uploadRefusal({ message: "   " }, o)).toEqual({ sentence: "Upload failed.", final: false });
  });
  it("megabytes: whole over ten, one decimal under", () => {
    expect(megabytes(61_924_578)).toBe(62);
    expect(megabytes(7_480_000)).toBe(7.5);
    expect(megabytes(400_000)).toBe(0.4);
    expect(megabytes(-5)).toBe(0);
  });
});

describe("the Inspector's two upload roads say it in plain words", () => {
  const src = read("src/app/(app)/appointments/[id]/inspector.tsx");
  it("both catches go through uploadRefusal with the file on its way up, named from before its prep and forgotten once it is up", () => {
    expect(src).toContain('import { uploadRefusal } from "@/lib/upload-words";');
    expect(src).toContain('const r = uploadRefusal(e, { what: model ? "The 3D model" : sending?.name ?? "The file", bytes: sending?.size ?? 0, action: model ? "Scan a smaller area." : "Send a smaller file." });');
    expect(src).toContain("uploadFinalRef.current = r.final;");
    expect(src).toContain("setError(r.sentence);");
    expect(src).toContain('setError(uploadRefusal(err, { what: sending?.name ?? "The file", bytes: sending?.size ?? 0, action: "Send a smaller file." }).sentence);');
    expect(src.split("sending = raw;").length - 1).toBe(2);
    expect(src.split("sending = file;").length - 1).toBe(2);
    expect(src).toContain("sending = null; // every file is up");
    expect(src).not.toContain('setError((e as { message?: string })?.message ?? "Upload failed.");');
    expect(src).not.toContain('setError(err instanceof Error ? err.message : "Upload failed.");');
  });
  it("3D Scan: a final refusal drops the kept copy and says scan smaller; a signal failure keeps it for one more tap", () => {
    expect(src).toContain("const uploadFinalRef = useRef(false);");
    expect(src).toContain("uploadFinalRef.current = false;");
    const door = src.slice(src.indexOf("async function scan3dInto("), src.indexOf("async function fileOnJob("));
    expect(door).toContain("if (uploadFinalRef.current) {");
    // (cn-v1123: the keep goes through keep(), which moves the ref AND the Discard button's state)
    expect(door).toContain("keep(null);\n          await discardScan(path);\n          return;");
    expect(door).not.toContain("Scan a smaller area."); // upload() said the action; the door only drops the copy
    expect(door).toContain("keep({ model, path, taskId, landed: null });");
    expect(door).toContain("keptWords(false)");
    expect(keptWords(false)).toContain("tap 3D Scan again to send it without scanning.");
    // the final branch returns before the keep
    expect(door.indexOf("if (uploadFinalRef.current) {")).toBeLessThan(door.indexOf("keep({ model, path, taskId, landed: null });"));
  });
});

describe("the page's model cap reads as it is", () => {
  it("the comment no longer calls a room a few MB", () => {
    const src = read("src/lib/native-scan.ts");
    expect(src).not.toContain("a few to a few tens of MB");
    expect(src).toContain("a room painted whole is 40 to 130 MB");
    expect(src).toContain("export const MODEL_MAX_BYTES = 200_000_000;");
  });
  it("the release note is the top entry and says what 3D Scan gained", () => {
    expect(versionNumber(APP_VERSION)!).toBeGreaterThanOrEqual(1120);
    const note = RELEASE_NOTES.find((r) => r.version === "cn-v1120");
    expect(note?.line).toContain("3D Scan");
    expect(note?.line).toContain("a third of the size");
    expect(note?.line).toContain("too big to send");
  });
});
