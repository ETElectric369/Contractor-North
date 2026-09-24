import { describe, it, expect } from "vitest";
import { fileKindFor, normalizePick, normalizeStretch, pickFilePath } from "./share-input";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";

describe("a stretch as the office types it", () => {
  it("takes a name and two real days", () => {
    expect(normalizeStretch({ label: "  Rough-in   start ", startsOn: "2026-07-14", endsOn: "2026-08-10" })).toEqual({
      ok: true,
      value: { label: "Rough-in start", starts_on: "2026-07-14", ends_on: "2026-08-10" },
    });
  });
  it("a one-day stretch needs no end", () => {
    expect(normalizeStretch({ label: "Fixtures", startsOn: "2026-09-24" })).toMatchObject({ ok: true, value: { starts_on: "2026-09-24", ends_on: "2026-09-24" } });
  });
  it("refuses in plain words: no name, a date that isn't one, an end before the start", () => {
    expect(normalizeStretch({ label: " ", startsOn: "2026-07-14" })).toMatchObject({ ok: false, error: expect.stringMatching(/name/) });
    expect(normalizeStretch({ label: "Trim", startsOn: "2026-02-30" })).toMatchObject({ ok: false, error: expect.stringMatching(/starts/) });
    expect(normalizeStretch({ label: "Trim", startsOn: "2026-09-23", endsOn: "2026-09-18" })).toMatchObject({ ok: false, error: expect.stringMatching(/ends before it starts/) });
  });
  it("an edit changes only what was sent, and checks the dates as the pair they become", () => {
    const cur = { label: "Trim", starts_on: "2026-09-18", ends_on: "2026-09-23" };
    expect(normalizeStretch({ label: "Trim Out" }, cur)).toEqual({ ok: true, value: { label: "Trim Out" } });
    expect(normalizeStretch({ startsOn: "2026-09-24" }, cur)).toMatchObject({ ok: false });
    expect(normalizeStretch({ endsOn: "2026-09-25" }, cur)).toEqual({ ok: true, value: { ends_on: "2026-09-25" } });
  });
});

describe("a pick as the office types it", () => {
  const where = { orgId: ORG, jobId: JOB, isNew: true };
  it("a new pick needs a category; the rest is optional and trimmed", () => {
    expect(normalizePick({ brand: "Leviton" }, where)).toMatchObject({ ok: false, error: expect.stringMatching(/kind of pick/) });
    expect(normalizePick({ category: "Faceplate Color", brand: " Leviton ", name: "Decora", colorHex: "f2efe6" }, where)).toEqual({
      ok: true,
      value: { category: "Faceplate Color", brand: "Leviton", name: "Decora", color_hex: "#F2EFE6" },
    });
  });
  it("reads only the fields it names: no org, job or removed_at rides along", () => {
    const sneaky = { category: "Tile", org_id: "x", job_id: "y", removed_at: null, buy_price: 9 } as unknown as Parameters<typeof normalizePick>[0];
    expect(normalizePick(sneaky, where)).toEqual({ ok: true, value: { category: "Tile" } });
  });
  it("a link must be https", () => {
    expect(normalizePick({ category: "Fixture", linkUrl: "http://example.com" }, where)).toMatchObject({ ok: false });
    expect(normalizePick({ category: "Fixture", linkUrl: "javascript:alert(1)" }, where)).toMatchObject({ ok: false });
    expect(normalizePick({ category: "Fixture", linkUrl: "https://example.com/spec" }, where)).toMatchObject({ ok: true, value: { link_url: "https://example.com/spec" } });
  });
  it("a file must be this job's pick file, a picture or a PDF", () => {
    const mine = pickFilePath(ORG, JOB, "swatch photo.JPG", 5);
    expect(mine).toBe(`${ORG}/picks/${JOB}/5-swatch_photo.JPG`);
    expect(normalizePick({ category: "Paint Color", filePath: mine }, where)).toMatchObject({ ok: true, value: { file_path: mine, file_kind: "image" } });
    expect(normalizePick({ category: "Paint Color", filePath: `${ORG}/${JOB}/receipt.jpg` }, where)).toMatchObject({ ok: false });
    expect(normalizePick({ category: "Paint Color", filePath: `${ORG}/picks/${JOB}/../x.jpg` }, where)).toMatchObject({ ok: false });
    expect(normalizePick({ category: "Paint Color", filePath: `${ORG}/picks/${JOB}/notes.txt` }, where)).toMatchObject({ ok: false });
    expect(normalizePick({ filePath: null }, { ...where, isNew: false })).toEqual({ ok: true, value: { file_path: null, file_kind: null } });
  });
  it("names what a file is", () => {
    expect(fileKindFor("a.pdf")).toBe("pdf");
    expect(fileKindFor("a.bin", "application/pdf")).toBe("pdf");
    expect(fileKindFor("IMG_0001.HEIC")).toBe("image");
    expect(fileKindFor("a.docx")).toBeNull();
  });
  it("a file name can't climb out of its folder", () => {
    expect(pickFilePath(ORG, JOB, "../../etc/passwd", 1)).toBe(`${ORG}/picks/${JOB}/1-._._etc_passwd`);
  });
});
