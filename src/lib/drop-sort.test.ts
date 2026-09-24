import { describe, expect, it } from "vitest";
import { describeLeftBehind, matchesAccept, sortDrop } from "./drop-sort";

/**
 * A MIXED DROP NAMES WHAT IT LEFT BEHIND (dropbox plan, Phase 0). DropTarget used to hand the
 * fitting files over and say nothing about the rest, and a one-file door dropped every file after
 * the first without a word.
 */

const f = (name: string, type: string) => ({ name, type });
const ACCEPT = "application/pdf,.pdf,image/*,.heic,.heif";

describe("matchesAccept", () => {
  it("by exact type, by family, and by extension", () => {
    expect(matchesAccept(f("a.pdf", "application/pdf"), ACCEPT)).toBe(true);
    expect(matchesAccept(f("IMG_1.JPG", "image/jpeg"), ACCEPT)).toBe(true);
    expect(matchesAccept(f("IMG_2.HEIC", ""), ACCEPT)).toBe(true); // Safari hands HEIC over with no type
    expect(matchesAccept(f("scan.PDF", ""), ACCEPT)).toBe(true);
    expect(matchesAccept(f("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), ACCEPT)).toBe(false);
  });
});

describe("sortDrop + describeLeftBehind", () => {
  it("three PDFs and a Word file: three go in, the Word file is NAMED", () => {
    const sorted = sortDrop(
      [f("a.pdf", "application/pdf"), f("b.pdf", "application/pdf"), f("plan.docx", "application/msword"), f("c.png", "image/png")],
      ACCEPT,
    );
    expect(sorted.take.map((x) => x.name)).toEqual(["a.pdf", "b.pdf", "c.png"]);
    expect(sorted.skipped.map((x) => x.name)).toEqual(["plan.docx"]);
    expect(describeLeftBehind(sorted)).toBe("plan.docx isn't a kind of file this takes, so it was left out.");
  });

  it("a one-file door names every file after the first instead of dropping it", () => {
    const sorted = sortDrop([f("one.pdf", "application/pdf"), f("two.pdf", "application/pdf"), f("three.pdf", "application/pdf")], "application/pdf", false);
    expect(sorted.take.map((x) => x.name)).toEqual(["one.pdf"]);
    expect(describeLeftBehind(sorted)).toBe(
      "This takes one file at a time, so two.pdf and three.pdf were left out. Drop them again after this one.",
    );
  });

  it("everything fits: nothing to say", () => {
    expect(describeLeftBehind(sortDrop([f("a.pdf", "application/pdf")], ACCEPT))).toBeNull();
  });

  it("nothing fits: every file is named", () => {
    const sorted = sortDrop([f("a.zip", "application/zip"), f("b.txt", "text/plain")], ACCEPT);
    expect(sorted.take).toEqual([]);
    expect(describeLeftBehind(sorted)).toBe("a.zip and b.txt aren't kinds of file this takes, so they were left out.");
  });

  it("a long list names three and counts the rest", () => {
    const many = ["a", "b", "c", "d", "e"].map((n) => f(`${n}.zip`, "application/zip"));
    expect(describeLeftBehind(sortDrop(many, ACCEPT))).toBe("a.zip, b.zip, c.zip and 2 more aren't kinds of file this takes, so they were left out.");
  });
});
