import { describe, it, expect } from "vitest";
import { findDuplicateGroups, findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";

const c = (id: string, o: Partial<DupCustomer> = {}): DupCustomer => ({
  id, name: null, company_name: null, email: null, phone: null, created_at: `2026-01-${id.padStart(2, "0")}`, ...o,
});

describe("findDuplicateGroups", () => {
  it("groups by identical phone (ignoring formatting)", () => {
    const g = findDuplicateGroups([c("1", { name: "Jim", phone: "(530) 555-1212" }), c("2", { name: "James", phone: "530-555-1212" }), c("3", { name: "Bob", phone: "5305559999" })]);
    expect(g.length).toBe(1);
    expect(g[0].members.map((m) => m.id).sort()).toEqual(["1", "2"]);
    expect(g[0].reason).toContain("phone");
  });

  it("groups by identical email (case-insensitive)", () => {
    const g = findDuplicateGroups([c("1", { email: "A@X.com" }), c("2", { email: "a@x.com" })]);
    expect(g[0].members.length).toBe(2);
    expect(g[0].reason).toContain("email");
  });

  it("groups by normalized name (punctuation/case/space)", () => {
    const g = findDuplicateGroups([c("1", { name: "O'Brien  Plumbing" }), c("2", { name: "obrien plumbing" })]);
    expect(g[0].members.length).toBe(2);
    expect(g[0].reason).toContain("name");
  });

  it("chains transitive matches into ONE group (phone→A,B ; email→B,C)", () => {
    const g = findDuplicateGroups([
      c("A", { name: "Al", phone: "5305551111" }),
      c("B", { name: "Al", phone: "5305551111", email: "al@x.com" }),
      c("C", { name: "Alfred", email: "al@x.com" }),
    ]);
    expect(g.length).toBe(1);
    expect(g[0].members.map((m) => m.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("does NOT group unrelated contacts or on blank/short signals", () => {
    const g = findDuplicateGroups([
      c("1", { name: "Alice", phone: "5305551111", email: "alice@x.com" }),
      c("2", { name: "Bob", phone: "5305552222", email: "bob@x.com" }),
      c("3", { name: "", phone: "123", email: "" }), // too-short phone, blank name/email
      c("4", { name: "", phone: "", email: "" }),
    ]);
    expect(g).toEqual([]);
  });

  it("sorts members oldest-first (a sensible default keeper) and biggest groups first", () => {
    const g = findDuplicateGroups([
      c("new", { name: "Dup", created_at: "2026-06-01" }),
      c("old", { name: "Dup", created_at: "2026-01-01" }),
      c("x1", { email: "p@q.com" }), c("x2", { email: "p@q.com" }),
    ]);
    expect(g[0].members[0].id).toBe("old"); // oldest first within a group
    expect(g.length).toBe(2);
  });
});

// The crosscheck run when a lead's estimate is ACCEPTED — link an existing customer, never duplicate.
describe("findMatchingCustomerId", () => {
  const book: DupCustomer[] = [
    c("A", { name: "Jane Doe", phone: "(530) 555-1212", email: "jane@x.com" }),
    c("B", { name: "Bob's Electric", phone: "5305559999" }),
  ];

  it("matches an existing customer by phone (ignoring formatting)", () => {
    expect(findMatchingCustomerId({ name: "J. Doe", phone: "530.555.1212" }, book)).toBe("A");
  });
  it("matches by email (case-insensitive), even when name/phone differ", () => {
    expect(findMatchingCustomerId({ name: "Totally Different", email: "JANE@X.COM" }, book)).toBe("A");
  });
  it("matches by normalized name when there's no phone/email", () => {
    expect(findMatchingCustomerId({ name: "bobs   electric" }, book)).toBe("B");
  });
  it("returns null for a genuinely new person (so a fresh Contact is created)", () => {
    expect(findMatchingCustomerId({ name: "New Person", phone: "5305550000", email: "new@x.com" }, book)).toBeNull();
  });
  it("does NOT match on a too-short (<7 digit) phone or blank signals", () => {
    expect(findMatchingCustomerId({ name: "", phone: "1212", email: "" }, book)).toBeNull();
    expect(findMatchingCustomerId({ name: null, phone: null, email: null }, book)).toBeNull();
  });
});
