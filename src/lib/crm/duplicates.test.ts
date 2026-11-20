import { describe, it, expect } from "vitest";
import { findCustomerMatch, findDuplicateGroups, findMatchingCustomerId, sureCustomerMatch, type DupCustomer } from "@/lib/crm/duplicates";

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

// cn-v1171: the same answer, with the reason and the name ON FILE, so a screen can ask in words.
describe("findCustomerMatch: the one matcher says who, and why", () => {
  const book: DupCustomer[] = [
    c("A", { name: "  Sam Tillery ", phone: "(530) 555-0145", email: "sam@x.com" }),
    c("B", { name: "Dana Rook", phone: "5305550111" }),
    c("C", { name: "Theo Vance" }),
    c("D", { name: "Theo Vance" }),
  ];

  it("a phone is one person, whatever was typed for the name: the name on file comes back", () => {
    expect(findCustomerMatch({ name: "Sam Tilery", phone: "530.555.0145" }, book)).toEqual({ id: "A", name: "Sam Tillery", reason: "phone" });
  });
  it("an email is one person", () => {
    expect(findCustomerMatch({ name: "Somebody Else", email: "SAM@X.COM" }, book)).toEqual({ id: "A", name: "Sam Tillery", reason: "email" });
  });
  it("a phone or an email on ANY record wins before a name is looked at", () => {
    expect(findCustomerMatch({ name: "Dana Rook", phone: "5305550145" }, book)?.id).toBe("A");
  });
  it("a name links only when it is the one such name in the book", () => {
    expect(findCustomerMatch({ name: "dana  rook" }, book)).toEqual({ id: "B", name: "Dana Rook", reason: "name" });
    expect(findCustomerMatch({ name: "Theo Vance" }, book)).toBeNull();
  });
  it("nothing to go on is nobody", () => {
    expect(findCustomerMatch({ name: "", phone: "0145", email: "" }, book)).toBeNull();
    expect(findCustomerMatch({ name: "Casey Loam", phone: "5305559999" }, book)).toBeNull();
  });
  it("findMatchingCustomerId is the sure match's id and nothing else", () => {
    for (const typed of [{ name: "Sam Tilery", phone: "530.555.0145" }, { name: "Theo Vance" }, { name: "dana rook" }, { name: "Casey Loam" }, { name: "Dana Rook", phone: "5305557777" }]) {
      expect(findMatchingCustomerId(typed, book)).toBe(sureCustomerMatch(typed, book)?.id ?? null);
    }
  });
});

// Skeptic #74: the same name with another phone is very likely another person. A screen that asks
// still shows it; a door that acts without asking must not take it.
describe("a name that the phone or the email contradicts", () => {
  const book: DupCustomer[] = [
    c("A", { name: "Sam Tillery", phone: "(530) 555-0145", email: "sam@x.com" }),
    c("B", { name: "Dana Rook" }),
    c("C", { name: "Casey Loam", email: "casey@x.com" }),
  ];

  it("another phone under the same name: the ask sees the hit marked, the silent doors see nobody", () => {
    const typed = { name: "Sam Tillery", phone: "530-555-0199" };
    expect(findCustomerMatch(typed, book)).toEqual({ id: "A", name: "Sam Tillery", reason: "name", disagrees: true });
    expect(sureCustomerMatch(typed, book)).toBeNull();
    expect(findMatchingCustomerId(typed, book)).toBeNull();
  });
  it("another email under the same name is the same doubt", () => {
    const typed = { name: "casey loam", email: "other@x.com" };
    expect(findCustomerMatch(typed, book)?.disagrees).toBe(true);
    expect(sureCustomerMatch(typed, book)).toBeNull();
  });
  it("nothing to contradict is no doubt: one side has no phone and no email", () => {
    // Typed with a phone, on file with none.
    expect(sureCustomerMatch({ name: "Dana Rook", phone: "5305550111" }, book)).toEqual({ id: "B", name: "Dana Rook", reason: "name" });
    // Typed with nothing but the name, on file with both.
    expect(sureCustomerMatch({ name: "Sam Tillery" }, book)).toEqual({ id: "A", name: "Sam Tillery", reason: "name" });
    // A phone typed against a record that only holds an email: nothing to compare.
    expect(sureCustomerMatch({ name: "Casey Loam", phone: "5305550122" }, book)?.id).toBe("C");
  });
  it("a phone or an email that MATCHES is never in doubt, whatever the other one says", () => {
    expect(sureCustomerMatch({ name: "Sam Tillery", phone: "5305550145", email: "new@x.com" }, book)).toEqual({ id: "A", name: "Sam Tillery", reason: "phone" });
    expect(sureCustomerMatch({ name: "Sam Tillery", phone: "5305550199", email: "sam@x.com" }, book)).toEqual({ id: "A", name: "Sam Tillery", reason: "email" });
  });
  it("a phone too short to be one contradicts nothing", () => {
    expect(sureCustomerMatch({ name: "Sam Tillery", phone: "0199" }, book)?.id).toBe("A");
  });
});
