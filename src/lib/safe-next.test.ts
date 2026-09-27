import { describe, expect, it } from "vitest";
import { loginRedirectUrl, safeNextPath } from "./safe-next";

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

describe("loginRedirectUrl", () => {
  it("carries the whole destination, query included, in next", () => {
    const url = loginRedirectUrl(new URL("https://app.contractornorth.com/settings?tab=features"));
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/settings?tab=features");
    expect(url.searchParams.get("tab")).toBeNull();
    expect(safeNextPath(url.searchParams.get("next"))).toBe("/settings?tab=features");
  });

  it("keeps a plain path as it was", () => {
    const url = loginRedirectUrl(new URL("https://tahoedeck.com/foo/bar"));
    expect(url.toString()).toBe("https://tahoedeck.com/login?next=%2Ffoo%2Fbar");
  });
});
