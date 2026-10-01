import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_DISAGREEMENTS,
  RECONCILE_ANSWERED_HERE,
  RECONCILE_KINDS,
  openKindsHere,
  reconcileBadge,
  reconcileRowsWaiting,
  type ReconcileKind,
  type ReconcileOpenCounts,
} from "@/lib/reconcile-kinds";

/**
 * THE TEETH ON /reconcile (cn-v1037).
 *
 * The kinds of disagreement are a CASE SPACE, so the pattern is a typed exhaustive Record: a sixth
 * kind does not compile until somebody writes down its words, its anchor, its two records and the
 * screen its button is on. These tests pin what a type cannot:
 *
 *   · that every kind really has all four, in his words and in Title Case;
 *   · that the badge is a ROLLUP over kinds and can never be a row count;
 *   · that a kind answered on ANOTHER screen can never get into the badge (Erik's law 2);
 *   · that zero draws nothing.
 */

const ALL = Object.keys(RECONCILE_KINDS) as ReconcileKind[];

const counts = (over: Partial<ReconcileOpenCounts> = {}): ReconcileOpenCounts => ({ ...NO_DISAGREEMENTS, ...over });

describe("every kind says what it is, what its two records are, and where its button lives", () => {
  it("each has a Title Case heading, an anchor, both sides of the sentence, a door and an order", () => {
    for (const k of ALL) {
      const def = RECONCILE_KINDS[k];
      expect(def.heading.length, k).toBeGreaterThan(8);
      // Title Case: every word of four letters or more starts with a capital (small joining words
      // like "and", "vs", "On" may be lower).
      for (const word of def.heading.split(/[\s,?]+/).filter((w) => w.length >= 4 && /^[A-Za-z]+$/.test(w))) {
        expect(word[0], `${k}: "${word}" in "${def.heading}"`).toBe(word[0].toUpperCase());
      }
      expect(def.anchor, k).toMatch(/^[a-z0-9-]+$/);
      // THE SENTENCE: two records, both named in words a person reads, never a bare number.
      expect(def.ours.length, k).toBeGreaterThan(12);
      expect(def.theirs.length, k).toBeGreaterThan(12);
      expect(def.ours, k).not.toBe(def.theirs);
      expect(typeof def.order, k).toBe("number");
    }
  });

  it("no two kinds share an anchor or a place in the order", () => {
    expect(new Set(ALL.map((k) => RECONCILE_KINDS[k].anchor)).size).toBe(ALL.length);
    expect(new Set(ALL.map((k) => RECONCILE_KINDS[k].order)).size).toBe(ALL.length);
  });

  /**
   * A KIND ANSWERED SOMEWHERE ELSE IS A LINK, AND A LINK CARRIES AN HREF. Erik's law 2: Reconcile
   * never becomes the only door to an action. A kind whose press belongs to the screen that owns the
   * record has to say which screen and where.
   */
  it("a kind not answered here names the screen that answers it, and a route to get there", () => {
    for (const k of ALL) {
      const door = RECONCILE_KINDS[k].answeredOn;
      if (door === "here") continue;
      expect(door.screen.length, k).toBeGreaterThan(2);
      expect(door.href, k).toMatch(/^\//);
    }
  });

  /** The written-out list and the doors cannot drift: a kind moved to another screen leaves the
   *  badge, and a kind brought back joins it, only by changing BOTH and failing this if not. */
  it("RECONCILE_ANSWERED_HERE is exactly the set of kinds whose door is here", () => {
    const fromDoors = ALL.filter((k) => RECONCILE_KINDS[k].answeredOn === "here").sort();
    expect([...RECONCILE_ANSWERED_HERE].sort()).toEqual(fromDoors);
  });

  it("the supplier gap is read-only: its door is the Suppliers card, which owns those figures", () => {
    expect(RECONCILE_KINDS["supplier-gap"].answeredOn).toEqual({ screen: "Suppliers", href: "/bills#suppliers" });
    expect(RECONCILE_ANSWERED_HERE).not.toContain("supplier-gap" as never);
  });
});

describe("the badge counts kinds, never rows", () => {
  it("zero draws nothing", () => {
    expect(reconcileBadge(NO_DISAGREEMENTS)).toBe(0);
    expect(openKindsHere(NO_DISAGREEMENTS)).toEqual([]);
    expect(reconcileRowsWaiting(NO_DISAGREEMENTS)).toBe(0);
  });

  /**
   * THE INVARIANT THIS EXISTS FOR. Twenty-six papers under five spellings is an undated, unbounded
   * set; the badge invariant (lib/action-items/types.ts) forbids counting one on chrome. Those
   * twenty-six ride inside ONE kind, so the dot moves by one — the same rollup the no-job hours line
   * uses.
   */
  it("a pile of one kind moves the badge by ONE, however big the pile", () => {
    expect(reconcileBadge(counts({ "supplier-names": 1 }))).toBe(1);
    expect(reconcileBadge(counts({ "supplier-names": 26 }))).toBe(1);
    expect(reconcileBadge(counts({ "supplier-names": 2600 }))).toBe(1);
    // And the rows are still countable in plain words, inside the page.
    expect(reconcileRowsWaiting(counts({ "supplier-names": 26 }))).toBe(26);
  });

  it("two kinds open is two, and it can never exceed the number of kinds answered here", () => {
    expect(reconcileBadge(counts({ "supplier-names": 4, "same-ticket-two-jobs": 9 }))).toBe(2);
    const everything = counts(Object.fromEntries(RECONCILE_ANSWERED_HERE.map((k) => [k, 500])) as ReconcileOpenCounts);
    expect(reconcileBadge(everything)).toBe(RECONCILE_ANSWERED_HERE.length);
    // Bounded by construction — this is what keeps it inside the badge invariant, not a cap.
    expect(reconcileBadge(everything)).toBeLessThanOrEqual(ALL.length);
    expect(reconcileBadge(everything)).toBeLessThanOrEqual(9);
  });

  it("a negative or absent count is not a badge", () => {
    expect(reconcileBadge(counts({ "supplier-names": -3 }))).toBe(0);
    expect(reconcileBadge({} as ReconcileOpenCounts)).toBe(0);
    expect(reconcileRowsWaiting(counts({ "supplier-names": -3 }))).toBe(0);
  });

  it("the open kinds come back in the Record's own page order", () => {
    const open = openKindsHere(counts({ "same-ticket-two-jobs": 1, "supplier-names": 1, "not-on-an-account": 1 }));
    expect(open).toEqual(["supplier-names", "not-on-an-account", "same-ticket-two-jobs"]);
    expect(open.map((k) => RECONCILE_KINDS[k].order)).toEqual([...open.map((k) => RECONCILE_KINDS[k].order)].sort((a, b) => a - b));
  });
});

/**
 * AND THE PAGE IS WHAT THE RECORD SAYS IT IS. A Record nobody renders from is documentation; this
 * keeps it load-bearing, so a kind cannot be declared and then drawn under words nobody wrote down.
 * (That each kind is actually DRAWN, under that heading, with its own count, is proved on the
 * rendered page in reconcile-page-doors.test.ts.)
 */
describe("the page is built from the Record", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const page = read("src/app/(app)/reconcile/page.tsx");

  it("the page reads which sections to draw off the Record, never off a hand-written list", () => {
    expect(page).toContain("openKindsHere(work.counts)");
    expect(page).toContain("RECONCILE_KINDS[");
    // No section is unconditional: each is behind the open-kinds list or its own rows. (A component
     // rendered flush at the page's own indent would be one drawn whatever the counts say.)
    expect(page).not.toMatch(/\n {6}<Supplier(MergeReview|CandidateReview|UnfiledSpellings)\b/);
    for (const k of RECONCILE_ANSWERED_HERE) {
      if (k === "same-ticket-two-jobs") continue; // its own rows are its gate, see below
      expect(page, k).toContain(`has("${k}")`);
    }
    // The duplicate picker draws while it has ROWS, not only while one is open: a pick he already
    // made keeps its row so he can change his mind. Its COUNT is still open-only, which is the law —
    // badges show open, sections do not hide an undo.
    expect(page).toContain("work.supersedeReady && work.duplicates.length > 0");
  });

  it("the anchors are the Record's, including the one the owning component renders itself", () => {
    // Three sections take their anchor straight from the Record.
    for (const k of ["supplier-names", "same-supplier-or-two", "not-on-an-account"] as const) {
      expect(page, k).toContain(`RECONCILE_KINDS["${k}"].anchor`);
    }
    // The duplicate picker carries its own id, because /bills' Needs You pointer has linked to it
    // since before this page existed. The Record must agree with it or that link lands on nothing.
    const dup = read("src/app/(app)/bills/supplier-duplicates.tsx");
    expect(dup).toContain(`id="${RECONCILE_KINDS["same-ticket-two-jobs"].anchor}"`);
    const bills = read("src/app/(app)/bills/page.tsx");
    expect(bills).toContain(`href="/reconcile#${RECONCILE_KINDS["same-ticket-two-jobs"].anchor}"`);
    // And the Suppliers card's File It link lands on the section that files a spelling.
    const card = read("src/app/(app)/bills/suppliers-card.tsx");
    expect(card).toContain(`href="/reconcile#${RECONCILE_KINDS["not-on-an-account"].anchor}"`);
  });
});
