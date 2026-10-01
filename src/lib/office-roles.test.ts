import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { eachAppSource, liveFunctionBody, migrationFiles, migrationText } from "@/lib/migration-body.test-util";
import { STAFF_ROLES, isStaffRole, roleCanRun } from "@/lib/actions/perms";
import type { UserRole } from "@/lib/types";

/**
 * WHO COUNTS AS OFFICE: ONE APP ANSWER, AND THE DATABASE PINNED TO IT (W2).
 *
 * Reproduced before the fix: adding a seat to UserRole and to STAFF_ROLES compiled clean and left
 * all 8,982 unit tests green, while five hand-written copies of ["owner", "admin", "office"] kept
 * the new seat out — it could not save setup, could not edit the playbook, saw no staff door in the
 * dock, and was never told about a new lead or a finished voice recording. That is the exact shape
 * of the bug this list already caused once: a green "Saved" on a labour rate and markups, with
 * nothing written, because the app let somebody through a door the database then refused.
 *
 * The app's five copies are now one typed Record (lib/actions/perms OFFICE_BY_ROLE), exhaustive
 * over UserRole, so a new seat does not compile until somebody says whether it is office.
 *
 * THE DATABASE KEEPS ITS OWN ANSWER AND MUST. is_org_staff() and is_staff() are what RLS calls, and
 * a crafted PostgREST request never passes through app code at all. The two are NOT merged — the
 * database must own the security boundary and the app must know enough to hide a door. They are
 * pinned to each other here instead: this file reads the live migration bodies and fails the moment
 * either side moves alone.
 */

/** The database's own staff predicates. Both must name exactly the app's list. */
const DB_HELPERS = ["is_org_staff", "is_staff"] as const;

describe("who counts as office: the app's answer and the database's never drift apart (W2)", () => {
  const want = [...STAFF_ROLES].sort();

  for (const fn of DB_HELPERS) {
    it(`public.${fn}() answers true for exactly the app's office roles`, () => {
      const live = liveFunctionBody(fn);
      expect(live, `no migration creates public.${fn}`).not.toBeNull();
      const m = /\brole\s+in\s*\(([^)]*)\)/i.exec(live!.body);
      expect(
        m,
        `public.${fn} (live in ${live!.file}) no longer names its roles where this test looks. ` +
          `If the helper was rewritten, re-point this test at the new predicate — do not delete it.`,
      ).not.toBeNull();
      const roles = [...m![1].matchAll(/'([^']*)'/g)].map((w) => w[1]).sort();
      expect(roles, `${fn} in ${live!.file} vs STAFF_ROLES in src/lib/actions/perms.ts`).toEqual(want);
    });
  }

  it("the two database helpers still answer identically (they are one rule written twice)", () => {
    // NOT merged here: making is_staff() call is_org_staff() is a migration, and Erik runs those.
    // Until he does, this holds them to the same words so a fix to one is not a fix to one only.
    const bodies = DB_HELPERS.map((fn) => liveFunctionBody(fn));
    const roleLists = bodies.map((b) => [...(/\brole\s+in\s*\(([^)]*)\)/i.exec(b!.body)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((w) => w[1]).sort());
    expect(roleLists[0]).toEqual(roleLists[1]);
    // And both still fail closed for a deactivated seat (0158 — deactivation is a DB boundary).
    for (const b of bodies) expect(b!.body, `${b!.file} lost its active check`).toMatch(/coalesce\(active, ?true\)/);
  });

  it("every seat the database can store is a seat the app has decided about", () => {
    // The enum is the set of roles a profile can actually hold. OFFICE_BY_ROLE is exhaustive over
    // UserRole, so this is what makes that exhaustiveness mean something: a role added to the
    // database that UserRole does not list would slip past the compiler.
    const init = migrationFiles().find((f) => f.startsWith("0001_"))!;
    const decl = /create type (?:public\.)?user_role as enum \(([^)]*)\)/i.exec(migrationText(init));
    expect(decl, `${init} no longer declares the user_role enum`).not.toBeNull();
    const stored = [...decl![1].matchAll(/'([^']*)'/g)].map((w) => w[1]);
    // Any later `alter type … add value` would widen it, so those are caught too.
    for (const f of migrationFiles()) {
      for (const m of migrationText(f).matchAll(/alter\s+type\s+(?:public\.)?user_role\s+add\s+value(?:\s+if\s+not\s+exists)?\s+'([^']*)'/gi)) {
        stored.push(m[1]);
      }
    }
    const decided: UserRole[] = ["owner", "admin", "office", "tech"];
    expect([...new Set(stored)].sort(), "a role the database can store that src/lib/types UserRole does not list").toEqual([...decided].sort());
    // And the app's office list is a subset of what can be stored — never a word nothing can hold.
    for (const r of STAFF_ROLES) expect(stored, `STAFF_ROLES names ${r}, which no profile can hold`).toContain(r);
  });

  it("the predicate fails closed, and a tech is never office", () => {
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
    expect(isStaffRole("")).toBe(false);
    expect(isStaffRole("tech")).toBe(false);
    expect(isStaffRole("Owner")).toBe(false); // the stored words are lower case
    expect(isStaffRole("bookkeeper")).toBe(false);
    for (const r of STAFF_ROLES) expect(isStaffRole(r)).toBe(true);
    // The action gate rides the same predicate, so "offered" and "allowed" cannot drift.
    for (const r of STAFF_ROLES) expect(roleCanRun(r, "staff")).toBe(true);
    expect(roleCanRun("tech", "staff")).toBe(false);
    expect(roleCanRun("office", "owner")).toBe(false);
  });

  /**
   * A DELIBERATE BYPASS TRIPWIRE (not the proof the behaviour works — the cases above are that).
   * Five copies grew back once. A sixth now fails here instead of shipping a door that admits a
   * different set of people from every other door.
   */
  it("no other file writes the office list out again", () => {
    const target = [...STAFF_ROLES].sort().join("|");
    const arrays = /\[\s*(?:"[^"\n]*"|'[^'\n]*')(?:\s*,\s*(?:"[^"\n]*"|'[^'\n]*'))*\s*,?\s*\]/g;
    const offenders: string[] = [];
    eachAppSource((p, code) => {
      for (const m of code.matchAll(arrays)) {
        const words = [...m[0].matchAll(/["']([^"']*)["']/g)].map((w) => w[1]).sort();
        if (words.join("|") === target) offenders.push(p);
      }
      // The other shape it came back in: role === "owner" || role === "admin" || role === "office".
      if (/===\s*"owner"[\s\S]{0,80}===\s*"admin"[\s\S]{0,80}===\s*"office"/.test(code)) offenders.push(`${p} (chained ===)`);
    }, [join("src", "lib", "actions", "perms.ts")]);
    expect(
      offenders,
      `these keep their own copy of who counts as office — call isStaffRole / STAFF_ROLES instead: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
