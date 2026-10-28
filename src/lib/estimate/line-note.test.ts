import { describe, it, expect } from "vitest";
import { joinLineNote, splitLineNote } from "./line-note";

/**
 * THE NOTE UNDER A LINE (Add A Note; skeptic #43, S6). A line's description is its head on the first
 * line and the note on the lines after it. These two are THE rule: the editor's two boxes, the task
 * a job is born with, the kit a task becomes and the ×N suffix all read the head through here, so a
 * note can never leak into a task's title or a kit's name, and a count can never be written into
 * the note.
 */
describe("splitLineNote / joinLineNote", () => {
  it("the head is the first line, the note is the rest; a blank note puts the description back on one line", () => {
    expect(splitLineNote("Head\nA\nB")).toEqual({ head: "Head", note: "A\nB" });
    expect(splitLineNote("Head")).toEqual({ head: "Head", note: "" });
    expect(splitLineNote("")).toEqual({ head: "", note: "" });
    expect(joinLineNote("Head", "")).toBe("Head");
    expect(joinLineNote("Head", "   \n ")).toBe("Head");
    expect(joinLineNote("Head", "Note line")).toBe("Head\nNote line");
  });

  it("a newline cannot be typed into the head; a Windows line end does not ride on the head", () => {
    expect(joinLineNote("Head\nsneaky", "Note")).toBe("Head sneaky\nNote");
    expect(splitLineNote("Head\r\nNote").head).toBe("Head");
  });

  it("round trip, with a trailing newline mid-typing kept", () => {
    for (const d of ["Head\nNote", "Head\nA\nB\n", "Head"]) {
      const { head, note } = splitLineNote(d);
      expect(joinLineNote(head, note)).toBe(d);
    }
  });
});
