import { describe, it, expect } from "vitest";
import { roleCanRun } from "./perms";

describe("roleCanRun — least-privilege gate (framework Pillar 2)", () => {
  it("'any' actions are open to any authenticated role", () => {
    for (const role of ["owner", "admin", "office", "tech", "field"]) {
      expect(roleCanRun(role, "any")).toBe(true);
    }
  });

  it("'staff' actions are owner/admin/office only", () => {
    expect(roleCanRun("owner", "staff")).toBe(true);
    expect(roleCanRun("admin", "staff")).toBe(true);
    expect(roleCanRun("office", "staff")).toBe(true);
    expect(roleCanRun("tech", "staff")).toBe(false);
    expect(roleCanRun("field", "staff")).toBe(false);
  });

  it("'owner' actions are owner only", () => {
    expect(roleCanRun("owner", "owner")).toBe(true);
    expect(roleCanRun("admin", "owner")).toBe(false);
    expect(roleCanRun("office", "owner")).toBe(false);
    expect(roleCanRun("tech", "owner")).toBe(false);
  });

  it("a null/unknown role can only run 'any' actions", () => {
    expect(roleCanRun(null, "any")).toBe(true);
    expect(roleCanRun(null, "staff")).toBe(false);
    expect(roleCanRun(null, "owner")).toBe(false);
    expect(roleCanRun(undefined, "staff")).toBe(false);
    expect(roleCanRun("bogus", "staff")).toBe(false);
  });
});
