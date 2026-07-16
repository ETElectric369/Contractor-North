import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

/** The `?next=` open-redirect guard used by the login/signup actions (collaborator invite
 *  links land on /login?mode=signup&…&next=/content and the form carries next through). */
describe("safeNextPath", () => {
  it("allows same-app relative paths", () => {
    expect(safeNextPath("/content")).toBe("/content");
    expect(safeNextPath("/content?org=abc-123")).toBe("/content?org=abc-123");
    expect(safeNextPath("/planner")).toBe("/planner");
  });

  it("rejects absolute and protocol-relative URLs (open redirect)", () => {
    expect(safeNextPath("https://evil.com/content")).toBeNull();
    expect(safeNextPath("http://evil.com")).toBeNull();
    expect(safeNextPath("//evil.com/content")).toBeNull();
  });

  it("rejects backslash tricks browsers normalize to //", () => {
    expect(safeNextPath("/\\evil.com")).toBeNull();
    expect(safeNextPath("\\/evil.com")).toBeNull();
  });

  it("rejects empty / missing / non-path junk", () => {
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath("content")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });
});
