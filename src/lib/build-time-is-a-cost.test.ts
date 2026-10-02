import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { codeOnly, eachAppSource, liveFunctionBody, migrationFiles, migrationText } from "@/lib/migration-body.test-util";
import { buildTimeRate, isOwnerShift, tallyBuildTime } from "@/lib/build-time-cost";

/**
 * TWO RULES, EACH IN ONE PLACE, WITH A TRIPWIRE ON IT (0373).
 *
 * ── WHY A TRIPWIRE, AND NOT ONE OF THE OTHER TWO ───────────────────────────────────────────────────
 *
 * This project has three proven ways to make a rule impossible to bypass:
 *
 *   (1) A TYPED EXHAUSTIVE RECORD. Used, for the OTHER half of this change: the profit and loss's shape
 *       is PNL_SECTION_SHAPE and PNL_KIND_SHAPE (lib/analytics/pnl-shape.ts), so a section cannot be
 *       added without declaring whether it is subtracted and a kind cannot be added without declaring
 *       how it is drawn. That is pinned in profit-and-loss.test.ts, not here.
 *
 *   (2) AN APP RULE WITH A SQL TWIN. Also used: the app refuses writing a wage to an owner
 *       (settings/actions.ts) and 0373 adds refuse_wages_for_an_owner_rate so the database refuses it
 *       too. The twin is checked below, from the migration files, with no credentials.
 *
 *   (3) A TEST THAT FAILS IF A READER WRITES THE PREDICATE ITSELF. This one, and the fault it guards is
 *       not hypothetical - it is EXACTLY what happened to 0286. That migration said its rule lived at
 *       "the ONE door every reader already reads rates through", profile_pay, and then the app wrote the
 *       same rule again in TypeScript in a dozen places: payroll-math.ts returned 0 for anyone
 *       paid_by_draw BEFORE it read a rate at all, labor-billing zeroed him a second time and then
 *       `continue`d, and owner-money did it in six more. The consequence was that replacing the view
 *       changed NOTHING in the app, and nobody noticed for a week. A shared helper is not enough when a
 *       hand-written copy compiles fine.
 *
 * ── WHAT THESE ARE AND ARE NOT ─────────────────────────────────────────────────────────────────────
 *
 * BYPASS TRIPWIRES, not the proof. What the figures ARE is proved behaviourally in build-time-cost's own
 * cases below, in labor-billing.test.ts and in profit-and-loss.test.ts (which holds Net Profit to the
 * cent before and after the allocation). These answer only "did somebody write the rule again somewhere
 * else", which is the thing that has already happened once.
 *
 * Comments are stripped through codeOnly (migration-body.test-util), the FIXED stripper: the earlier
 * hand-rolled one treated every opener-looking pair of characters as a comment start, including the pair
 * inside a string like accept="image/*,application/pdf", and blanked up to 950 lines across eighteen
 * files - exactly the files this scans (owner-money.ts is over 1,800 lines, accountant-workbook.ts over
 * 1,200). A scanned-file count is asserted below so a stripper or a walker that goes blind FAILS rather
 * than passing quietly with nothing to look at.
 */

const ROOT = process.cwd();

/** The modules that own these rules. Everything else is a reader. */
const OWNERS = [
  "src/lib/build-time-cost.ts",
  // payRateForEntry is the PAYROLL answer ("what does this hour PAY") and legitimately short-circuits an
  // owner to 0: he is not on payroll. buildTimeRate calls it for crew. Its $0 for an owner is correct
  // and is the one copy of that expression allowed outside the owner module.
  "src/lib/payroll-math.ts",
  // isPaidByDraw is the one definition of the flag; profile-columns is where it is read off the view.
  "src/lib/profile-columns.ts",
];

/**
 * NAMED EXCEPTIONS, each with the reason it is not this rule. An exception has to be argued for in
 * writing, which is the point: a silent allowlist is how the next copy gets written.
 */
const NOT_THIS_RULE: { file: string; why: string }[] = [
  {
    file: "src/lib/owner-draw.ts",
    why: "builds the SENTENCES about the owner (registers, the Pay-board refusal). It reads the flag to pick words, never to price an hour",
  },
  {
    file: "src/app/(app)/timecards/edit-entry-button.tsx",
    why: "hides the per-shift Rate box on an owner's shift (0286's refuse_pay_rate_on_owner_entry twin). A wage question, not a cost one",
  },
  {
    file: "src/app/(app)/settings/member-rate.tsx",
    why: "chooses which BOX to draw - the crew's Pay box or the owner's Cost box. It prices nothing",
  },
];

/**
 * ── WHY THESE READ A WINDOW OF LINES AND NOT ONE LINE (2026-10-01, and this is the whole lesson) ───
 *
 * Every predicate in this file used to be a SINGLE-LINE regex, and the file's own prose named the gap
 * it left - "two lines, so no single-line scan could see the fault whole" - and then left it. Two
 * bypasses were planted in a throwaway worktree and all fourteen tests passed:
 *
 *   (1) A hand-written second costing rule: `if (!isOwnerShift(e)) continue;` then a line reading
 *       cost_rate off the row, then a line multiplying hours by it and pricing a missing rate at $0.
 *       That is EXACTLY the fault this file exists to guard, spread over four lines.
 *   (2) 0286's defect rebuilt: the same shape reading `bill_rate`, so the owner's hour costs his $125
 *       price, every hour nets $0, and all-time job profit reads -$1,085 against a real +$35,847.
 *
 * Neither was seen, because PRICES_OWNER_AT_ZERO needed the flag and the zero on ONE line, the bill-rate
 * test needed a cost word on the bill_rate line itself, and the hours-times-rate test needed the literal
 * token `cost_rate` within 24 characters of the `*` - so any local variable defeated it, and `\bhours?\b`
 * could not even match `hoursBetween`, the project's own hours helper that every costing path calls.
 *
 * So each fault signature is now tested over a WINDOW of consecutive code lines. A window rather than a
 * parsed function body on purpose: it is a dozen lines of string handling instead of a TypeScript
 * brace-walker, it cannot mis-parse, and every fault this file documents - the historical 0286 pair, both
 * planted functions, the one-sided copy - lives inside a handful of adjacent lines. Each predicate below
 * is pinned to the real faults as POSITIVE controls and to the lines it must NOT match as negative ones,
 * so a predicate that quietly stops matching fails here before the scan starts passing for the wrong
 * reason.
 */
const WINDOW = 12;

/** The owner's shift, however a reader asks: the flag off the row, the helper, or the engine's person. */
const NAMES_THE_OWNER_FLAG = /(paid_by_draw|paidByDraw|isPaidByDraw\s*\(|isOwnerShift\s*\()/;

/**
 * A RATE TURNED INTO MONEY BY HAND: a multiplication with hours on the left or a rate on the right.
 *
 * `hours?` on its own could not match `hoursBetween`, the project's own hours helper that every costing
 * path calls - the `s` is followed by a word character - so the old predicate was blind to the one shape
 * it most needed to see. No `\b` after an alternative that ends in `)`, either: a word boundary cannot
 * hold between two non-word characters, which is how the planted rebuild of 0286 slipped through.
 */
const MULTIPLIES_A_RATE =
  /\b(hours?|hrs|worked|hoursBetween|hundredths|minutes)\w*[^;\n]{0,80}\*|\*[^;\n]{0,80}\w*(rate|Rate)\b/;

/**
 * THE PREDICATE, HAND-WRITTEN AS A ZERO. 0286's own fault: payroll-math answered
 * `if (paid_by_draw) return 0` before it read any rate, and labor-billing wrote `owner ? 0 : …`, so
 * replacing the view changed nothing in the app. A reader that turns the flag into a zero rate has
 * written the costing rule again - over one line or over four.
 *
 * ONLY A ZERO WHERE A RATE BELONGS, NOT A SKIP. A bare `continue` on the flag is correct and there are
 * seven such lines in owner-money alone (crew mileage, the crew "no pay rate" alarm, the Pay board's You
 * Owe, plus two that select owners IN). Banning those would force an argued exception per line and teach
 * the next engineer to add one.
 */
const ZERO_WHERE_A_RATE_BELONGS = /(\breturn\s+0\b|\?\s*0\s*:|:\s*0\s*[,;)]|=\s*0\s*;|\?\s*[A-Za-z_$][\w$.?]*\s*:\s*0\b)/;

/** How many lines after the flag still count as what the flag GUARDS. Four, because the planted
 *  function put three lines between `if (!isOwnerShift(e)) continue;` and its `? r : 0`. */
const GUARDS = 4;

const PRICES_OWNER_AT_ZERO = (w: string): boolean => {
  const lines = w.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!NAMES_THE_OWNER_FLAG.test(lines[i])) continue;
    // WHAT THIS FLAG GUARDS, not the whole window. A zero anywhere within twelve lines of a correct
    // wage-side `continue` is not this fault - a bare `let owedCents = 0;` four statements away read as
    // one, in four places. The fault is a zero standing in for a rate RIGHT WHERE the flag is tested.
    const guarded = lines.slice(i, i + GUARDS).join("\n");
    if (!ZERO_WHERE_A_RATE_BELONGS.test(guarded)) continue;
    // And a zero alone is still not it: something here has to be about pricing - a rate named by any
    // spelling, or hours turned into money.
    if (/rate/i.test(guarded) || MULTIPLIES_A_RATE.test(guarded)) return true;
  }
  return false;
};

/**
 * THE SHIFT TEST, HAND-WRITTEN. labor-billing used to open with
 * `const owner = isPaidByDraw(e?.profiles) || e?.paid_by_draw === true;` and zero him on the NEXT line.
 * `isOwnerShift` is that expression now, and a reader that rebuilds it is one edit away from rebuilding
 * the zero beside it.
 *
 * AND THE ONE-SIDED COPY COUNTS TOO. `e?.profiles?.paid_by_draw === true && e.profile_id` omits
 * isOwnerShift's `|| e?.paid_by_draw === true` branch, so it DISAGREES with the engine on a row carrying
 * the flag at top level: ownerCost is non-zero while the list of owners is empty, and a job tile prints
 * a cost it cannot attribute to anybody. Two of those shipped undetected because the old predicate
 * required a `||`. Asking "is this person on the Pay board" off the engine's own person record
 * (`person.paidByDraw`) is a different, wage-side question and is untouched.
 */
const REBUILDS_SHIFT_TEST = (w: string): boolean =>
  /isPaidByDraw\s*\([^)]*\)\s*\|\|/.test(w) ||
  /paid_by_draw\s*===\s*true\s*\|\|/.test(w) ||
  /\?\.(profiles)\?\.paid_by_draw\s*===\s*true/.test(w);

/**
 * THE HOURS, TURNED INTO MONEY BY HAND, WHATEVER THE RATE IS CALLED.
 *
 * The old predicate needed the literal token `cost_rate` within 24 characters of the `*`, so renaming it
 * to a local `r` defeated it, and it had no positive control at all - alone among the four - so nothing
 * would ever have revealed that it matched nothing. This one keys on where the money LANDS instead: an
 * identifier that calls itself build time or an owner cost, receiving a multiplication. That is the one
 * shape a second costing rule cannot avoid, because the figure has to be called something.
 *
 * buildTimeCents is the one expression now, and it takes the multiplication with it.
 */
const COSTS_BUILD_TIME_BY_HAND = (w: string): boolean =>
  /\b\w*(buildTime|BuildTime|ownerCost|OwnerCost|laborCost|LaborCost)\w*\s*(\+?=)[^;\n]{0,120}\*/.test(w);

/**
 * THE RATE, READ FROM THE WRONG COLUMN. cost_rate is the owner's; bill_rate is the CUSTOMER'S PRICE. A
 * reader that costs an hour at bill_rate rebuilds 0286's exact defect - his cost equal to his price.
 * Window-scoped, so reading the column on one line and multiplying by it on the next is still the fault.
 */
const COSTS_AT_BILL_RATE = (w: string): boolean => {
  if (!/\bbill_?[Rr]ate\b/.test(w)) return false;
  // BILLING LEGITIMATELY MULTIPLIES A BILL RATE BY HOURS. That is a CHARGE, and it is labor-billing's
  // whole job. The fault is the same arithmetic landing in something that calls itself a cost.
  if (!MULTIPLIES_A_RATE.test(w)) return false;
  if (!/cost/i.test(w)) return false;
  // Naming both in one condition is how a GUARD is written (the Team page warns when cost >= bill).
  return !/[<>]=?/.test(w);
};

/**
 * Every app source, comments stripped, minus the owners and the argued exceptions.
 *
 * EVERY TEST THAT CALLS THIS CARRIES AN EXPLICIT 30s TIMEOUT. It walks and strips ~570 files, which is
 * comfortably under a second on a quiet machine and several seconds on a loaded one, and vitest's default
 * is 5s - so without one, the tripwire becomes a flake that fails for being slow rather than for finding
 * something, and the next engineer learns to ignore it. (The same default is already timing out
 * supplier-owed-one-place.test.ts under load; see the note in the handover.)
 */
function scan(test: (line: string, path: string) => boolean): { hits: string[]; files: number } {
  const hits: string[] = [];
  let files = 0;
  eachAppSource((path, code) => {
    const rel = path.slice(ROOT.length + 1);
    if (OWNERS.includes(rel)) return;
    if (NOT_THIS_RULE.some((e) => e.file === rel)) return;
    files += 1;
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (test(lines[i], rel)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
    }
  });
  return { hits, files };
}

/**
 * THE SAME WALK, A WINDOW AT A TIME: every run of WINDOW consecutive NON-BLANK code lines, joined.
 *
 * Blank lines are dropped before windowing, so a fault is not hidden by padding it out, and the window
 * is reported by the line its first statement sits on so a hit names somewhere to look.
 */
function scanWindows(test: (window: string, path: string) => boolean): { hits: string[]; files: number } {
  const hits: string[] = [];
  let files = 0;
  eachAppSource((path, code) => {
    const rel = path.slice(ROOT.length + 1);
    if (OWNERS.includes(rel)) return;
    if (NOT_THIS_RULE.some((e) => e.file === rel)) return;
    files += 1;
    const lines: { n: number; text: string }[] = [];
    code.split("\n").forEach((text, i) => {
      if (text.trim()) lines.push({ n: i + 1, text });
    });
    for (let i = 0; i < lines.length; i += 1) {
      const chunk = lines.slice(i, i + WINDOW);
      if (test(chunk.map((l) => l.text).join("\n"), rel)) {
        hits.push(`${rel}:${chunk[0].n}: ${chunk[0].text.trim().slice(0, 120)}`);
        // One hit per fault, not one per window that contains it: skip past this window.
        i += WINDOW - 1;
      }
    }
  });
  return { hits, files };
}

/**
 * THE TWO FUNCTIONS THAT WERE PLANTED AND NOT CAUGHT, kept as POSITIVE CONTROLS.
 *
 * These are verbatim what was appended to src/lib/analytics/time-breakdown.ts in a throwaway worktree,
 * where all fourteen tests passed. Every predicate that claims to guard this rule has to match them, or
 * it is the old tripwire wearing a new comment.
 */
const PLANTED_HAND_COSTING = [
  "function ownerCostByHand(entries: any[]): number {",
  "  let out = 0;",
  "  for (const e of entries) {",
  "    if (!isOwnerShift(e)) continue;",
  "    const r = Number(e?.profiles?.cost_rate);",
  "    const worked = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);",
  "    out += worked * (Number.isFinite(r) ? r : 0);",
  "  }",
  "  return out;",
  "}",
].join("\n");

const PLANTED_0286_REBUILT = [
  "function ownerCostAtHisPrice(entries: any[]): number {",
  "  let out = 0;",
  "  for (const e of entries) {",
  "    if (!isOwnerShift(e)) continue;",
  "    const r = Number(e?.profiles?.bill_rate ?? 0);",
  "    out += hoursBetween(e.clock_in, e.clock_out) * r;",
  "  }",
  "  return out;",
  "}",
].join("\n");

/** The two one-sided copies that shipped on this branch, before they were sent through isOwnerShift. */
const SHIPPED_ONE_SIDED = ".filter((e: any) => e?.profiles?.paid_by_draw === true && e.profile_id)";

/**
 * 0286'S OWN TWO FAULTS, as the windows they really were — not as bare lines.
 *
 * A window predicate has to be pinned to a window, and that is the honest form of these anyway: the
 * zero was never a line on its own, it was the first statement of a function whose whole job was to
 * return a rate. payroll-math.ts answered before it read any rate; labor-billing.ts zeroed him and then
 * `continue`d. Both compiled, both passed review, and between them they made replacing the view a
 * no-op that nobody noticed for a week.
 */
const HISTORICAL_PAYROLL_MATH = [
  "export function payRateForEntry(e: any, fallbackRate = 0): number {",
  "  if (e?.profiles?.paid_by_draw === true || e?.paid_by_draw === true) return 0;",
  "  const override = Number(e?.rate_override);",
  "  if (Number.isFinite(override) && override > 0) return override;",
  "  return Number(e?.profiles?.hourly_rate ?? fallbackRate) || 0;",
  "}",
].join("\n");

const HISTORICAL_LABOR_BILLING = [
  "for (const e of jobEntries) {",
  "    const rate = isPaidByDraw(e?.profiles) ? 0 : payRateForEntry(e, fallbackRate);",
  "    if (!rate) continue;",
  "    cost += hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) * rate;",
  "}",
].join("\n");

describe("what an hour of build time costs is written in exactly one place", () => {
  /**
   * THE SCANNER CAN SEE. A stripper that blinds itself, or a walker that stops early, makes every test
   * below pass by looking at nothing. The floor is well under the real count so ordinary growth never
   * trips it, and far above zero so a blinded scan does.
   */
  it("reads the whole app, so a blinded scan fails instead of passing", () => {
    const { files } = scan(() => false);
    expect(files).toBeGreaterThan(400);
    // And the stripper really is the fixed one: an opener inside a string is not a comment opener, so
    // the code after it is still visible. (The broken one blanked everything to the next close.)
    const tricky = codeOnly('const a = "image/*,application/pdf";\nconst findMe = 1;');
    expect(tricky).toContain("findMe");
  }, 30_000);

  /** AND IT SEES A WINDOW WHOLE. The planted function is four lines; a scanner whose window has
   *  collapsed to one line reads none of these faults, so this is the floor under every test below. */
  it("reads a window of consecutive lines, so a fault split over four of them is seen whole", () => {
    expect(WINDOW).toBeGreaterThanOrEqual(8);
    const { files } = scanWindows(() => false);
    expect(files).toBeGreaterThan(400);
    // A window really is joined: a predicate needing two different lines matches the planted function.
    expect(/isOwnerShift/.test(PLANTED_HAND_COSTING) && /cost_rate/.test(PLANTED_HAND_COSTING)).toBe(true);
  }, 30_000);

  /**
   * THE PREDICATE, HAND-WRITTEN AS A ZERO. 0286's own fault: payroll-math.ts answered
   * `if (paid_by_draw) return 0` BEFORE it read any rate, and labor-billing.ts wrote `owner ? 0 : …`,
   * so replacing the view changed nothing in the app. buildTimeRate is the expression now.
   */
  it("no reader prices an owner's hour at $0 on its own", () => {
    // NOT VACUOUS, the historical faults: both of 0286's own, as the windows they really were.
    expect(PRICES_OWNER_AT_ZERO(HISTORICAL_PAYROLL_MATH)).toBe(true);
    expect(PRICES_OWNER_AT_ZERO(HISTORICAL_LABOR_BILLING)).toBe(true);
    // NOT VACUOUS, THE PLANTED FUNCTION: four lines, a $0 for a missing rate, and it used to pass.
    expect(PRICES_OWNER_AT_ZERO(PLANTED_HAND_COSTING)).toBe(true);
    // And the wage-side skips it must NOT match: excluding an owner from a WAGE figure is correct.
    expect(PRICES_OWNER_AT_ZERO("    if (person?.paidByDraw) continue;")).toBe(false);
    expect(PRICES_OWNER_AT_ZERO("    if (!pid || !person?.paidByDraw) continue;")).toBe(false);
    expect(scanWindows(PRICES_OWNER_AT_ZERO).hits).toEqual([]);
  }, 30_000);

  /**
   * THE SHIFT TEST, HAND-WRITTEN OR HALF-WRITTEN. The two-sided copy is one edit from the zero beside
   * it; the ONE-SIDED copy is already wrong, because it disagrees with the engine on a row carrying the
   * flag at top level. Two of those shipped on this branch while this test passed.
   */
  it("no reader rebuilds the 'is this an owner's shift' test, on one side or both", () => {
    expect(REBUILDS_SHIFT_TEST("  const owner = isPaidByDraw(e?.profiles) || e?.paid_by_draw === true;")).toBe(true);
    // NOT VACUOUS: the shipped one-sided copies match now, which is why they had to be fixed.
    expect(REBUILDS_SHIFT_TEST(SHIPPED_ONE_SIDED)).toBe(true);
    // The wage-side question off the engine's own person record is a different thing and is untouched.
    expect(REBUILDS_SHIFT_TEST("  const isOwner = person?.paidByDraw === true;")).toBe(false);
    expect(scanWindows(REBUILDS_SHIFT_TEST).hits).toEqual([]);
  }, 30_000);

  /**
   * THE RATE, READ FROM THE WRONG COLUMN. cost_rate is the owner's; bill_rate is the CUSTOMER'S PRICE.
   * A reader that costs his hours at bill_rate rebuilds 0286's exact defect - his cost equal to his
   * price, every hour netting $0, all-time job profit reading -$1,085 against a real +$35,847.
   */
  it("no reader costs an hour at the bill rate", () => {
    // NOT VACUOUS: the planted rebuild of 0286 reads bill_rate on one line and multiplies on the next.
    expect(COSTS_AT_BILL_RATE(PLANTED_0286_REBUILT)).toBe(true);
    // A guard that names both is not this fault (the Team page warns when cost >= bill).
    expect(COSTS_AT_BILL_RATE("  if (Number(costRate) >= Number(billRate)) warn();")).toBe(false);
    // And PRICING work at the bill rate is billing's whole job, not a cost.
    expect(COSTS_AT_BILL_RATE("  const amount = round2(billedHours * billRate);")).toBe(false);
    expect(scanWindows(COSTS_AT_BILL_RATE).hits).toEqual([]);
  }, 30_000);

  /**
   * THE HOURS, TURNED INTO MONEY BY HAND. Keyed on where the money LANDS, so renaming the rate to a
   * local does not defeat it - which is how the old version of this test was defeated, and it had no
   * positive control, so nothing would have shown that it matched nothing at all.
   */
  it("no reader multiplies its way to a build-time cost", () => {
    // NOT VACUOUS: the engine's own line, as it was before buildTimeCents existed, still matches.
    expect(COSTS_BUILD_TIME_BY_HAND("    else a.ownerBuildTime += Math.round((hundredths / 100) * rate * 100);")).toBe(true);
    // And the shape the old 24-character predicate could not see: a renamed local.
    expect(COSTS_BUILD_TIME_BY_HAND("    ownerCost += worked * r;")).toBe(true);
    // Calling the one expression is not multiplying by hand.
    expect(COSTS_BUILD_TIME_BY_HAND("    a.ownerBuildTime += buildTimeCents(hundredths / 100, rate);")).toBe(false);
    expect(scanWindows(COSTS_BUILD_TIME_BY_HAND).hits).toEqual([]);
  }, 30_000);

  /**
   * THE RATE COLUMN ITSELF IS NAMED IN A SHORT LIST OF PLACES, AND NOWHERE ELSE.
   *
   * The strongest available form of this rule, and the one the review asked for: `cost_rate` is a new
   * column with exactly one legitimate arithmetic reader (buildTimeRate / tallyBuildTime), so a file
   * that names it at all is either storing it, drawing a box for it, handing it to the rule, or writing
   * the rule again. The first three are listed by name with the reason; the fourth is the fault. Unlike
   * a shape predicate this cannot be defeated by a local variable, a two-line split or a rename.
   *
   * `bill_rate` is deliberately NOT banned this way: it is the customer's price and sixteen files read
   * it for entirely correct reasons. Its fault is a shape, and COSTS_AT_BILL_RATE is that shape.
   */
  it("only a named list of files touches cost_rate at all", () => {
    const allowed = new Map<string, string>([
      ["src/app/(app)/settings/actions.ts", "STORES the figure (updateMemberRate). It writes a column and prices no hour"],
      ["src/app/(app)/settings/save-what-changed.ts", "decides which BOX a save carries. It reads no row and prices nothing"],
      ["src/app/(app)/team/page.tsx", "hands the stored figure to the box as a prop. It prices nothing"],
      ["src/lib/analytics/owner-money.ts", "the engine: it passes the person's rate INTO buildTimeRate and does no arithmetic of its own"],
    ]);
    const hits: string[] = [];
    eachAppSource((path, code) => {
      const rel = path.slice(ROOT.length + 1);
      if (OWNERS.includes(rel)) return;
      if (NOT_THIS_RULE.some((e) => e.file === rel)) return;
      if (allowed.has(rel)) return;
      if (/\b(cost_rate|costRate)\b/.test(code)) hits.push(rel);
    });
    expect(hits).toEqual([]);
    // NOT VACUOUS: the owner module really does name it, so the token is findable and the walk works.
    expect(/\bcost_rate\b/.test(readFileSync(`${ROOT}/src/lib/build-time-cost.ts`, "utf8"))).toBe(true);

    /**
     * AND NOBODY SELECTS IT BY HAND EITHER (the /team defect, 2026-10-01).
     *
     * profile_pay grows a column per migration, and a deployed app that names one before Erik applies
     * the migration gets `42703 column "cost_rate" does not exist` - which fails the select WHOLE, every
     * row dropped, not just the column. /team named the columns itself with no ladder and no error
     * check, so the page rendered a roster of $0.00 rates with no Cost box on the owner's row, and a
     * save wrote those zeros back as nulls over real stored data. The ladder lives behind
     * profilePayRead, and the column list is no longer exported, so there is nothing to select by hand.
     */
    const selects: string[] = [];
    eachAppSource((path, code) => {
      const rel = path.slice(ROOT.length + 1);
      if (rel === "src/lib/profile-columns.ts") return;
      for (const l of code.split("\n")) if (/\.select\([^)]*\bcost_rate\b/.test(l)) selects.push(rel);
    });
    expect(selects).toEqual([]);
  }, 30_000);

  /**
   * ── AND THE WORDS ON SCREEN SUBTRACT WHAT THE FIGURE SUBTRACTS ────────────────────────────────────
   *
   * No tripwire in this file could catch the fifth fault of this wave, because it was PROSE: /analytics'
   * card heading read "Job profitability (collected − crew pay − materials − bills − petty cash)" while
   * the figure beside it already included the owner's build time. Four cost terms named, five subtracted
   * - $2,600 apart on a job he worked 40 hours, on his main money screen, the day he sets a rate.
   *
   * So this scans RENDERED TEXT rather than code: any sentence that spells out a profit formula with
   * "collected" and a minus sign has to account for ALL the labour. Naming crew pay or crew labour
   * without naming build time, or all labour, is the fault - that is exactly the shape of all five
   * sentences this wave had to correct, in profit-line.tsx, job-profitability.ts, Nort and twice on the
   * job hub. Comments are stripped, so this is about what a person reads, not what a file explains.
   */
  it("no sentence states a profit formula that leaves out the owner's labour", () => {
    /** The cost terms such a sentence lists, IN WORDS. Two or more of them is prose spelling out a
     *  formula; `collected - jobRefunds` is arithmetic and names none of them, which is the difference. */
    const TERMS = [/crew (pay|labou?r)/i, /materials/i, /\bbills\b/i, /petty cash/i, /live orders/i, /build time/i];
    const SAYS_A_FORMULA = (l: string) =>
      (/collected\s*[-−]/.test(l) || /[-−]\s*crew (pay|labou?r)/i.test(l)) &&
      TERMS.filter((t) => t.test(l)).length >= 2;
    const ACCOUNTS_FOR_ALL_LABOUR = (l: string) => /build time|all labou?r|owner/i.test(l);
    const { hits } = scan((l) => SAYS_A_FORMULA(l) && !ACCOUNTS_FOR_ALL_LABOUR(l));
    expect(hits).toEqual([]);
    // NOT VACUOUS: the heading as it really shipped, and the job hub's two sentences, all match.
    for (const bad of [
      "Job profitability (collected − crew pay − materials − bills − petty cash)",
      "  // Now all three are collected - crew labor - materials - bills - petty cash.",
      "(collected - crew labor - live orders - bills - petty cash, the same as /analytics)",
    ]) {
      expect(SAYS_A_FORMULA(bad) && !ACCOUNTS_FOR_ALL_LABOUR(bad), bad).toBe(true);
    }
    // And the corrected shape passes, so the test is satisfiable by saying the true thing.
    expect(SAYS_A_FORMULA("collected − crew pay − build time − materials − bills − petty cash") && !ACCOUNTS_FOR_ALL_LABOUR("collected − crew pay − build time − materials − bills − petty cash")).toBe(false);
  }, 30_000);

  /**
   * ── THE RETIRED NAME IS NAMED ONLY AS A RETIRED NAME ──────────────────────────────────────────────
   *
   * Erik, 2026-10-01: "lets get rid of the terminology owners draw and use only net profit". PNL_WORDS
   * .netProfit is "Net Profit" now, and "Owner's Draw" names ONE thing: the equity line below it. But
   * three doc comments went on stating the old name AS the name - including the header of the money
   * engine itself, which told the next reader that `left` IS the draw - and a doc comment is what the
   * next engineer, and any model reading the file, takes as the truth.
   *
   * THE WRAP IS WHY A GREP MISSED THEM: all three wrapped as "Net Profit (Owner's" / " * Draw)", so the
   * phrase existed on no single line. This collapses the " * " continuations first, which is the whole
   * trick, and then allows the phrase ONLY in the two sentences that deliberately quote it as history.
   */
  it("nothing calls the bottom line by its retired name, except the two sentences about the history", () => {
    const hits: string[] = [];
    eachAppSource((path, code) => {
      const rel = path.slice(ROOT.length + 1);
      // The comments ARE the subject here, so this reads the file raw - but it joins wrapped block-comment
      // lines, because the wrap is exactly what hid three of these.
      const flat = readFileSync(path, "utf8").replace(/\n\s*\*\s?/g, " ");
      if (!/Net Profit \(Owner'?s\s*Draw\)/.test(flat)) return;
      // THE TWO DELIBERATE ONES, each naming the phrase as what the line USED to be called.
      const historical =
        rel === "src/app/(app)/analytics/left-for-card.tsx" || rel === "src/lib/analytics/profit-and-loss.ts";
      if (!historical) hits.push(rel);
      // And even those two have to be talking about the past, not using it as the name.
      else expect(flat, rel).toMatch(/(It said|written for) "Net Profit \(Owner'?s Draw\)"/);
      void code;
    });
    expect(hits).toEqual([]);
    // NOT VACUOUS: the two historical files really do contain the phrase, so the scan can see it.
    const seen = ["src/app/(app)/analytics/left-for-card.tsx", "src/lib/analytics/profit-and-loss.ts"].filter((f) =>
      /Net Profit \(Owner'?s\s*Draw\)/.test(readFileSync(`${ROOT}/${f}`, "utf8").replace(/\n\s*\*\s?/g, " ")),
    );
    expect(seen).toHaveLength(2);
  }, 30_000);

  /**
   * THE ALLOCATION BASE IS ON-SITE HOURS, AND THE OFFICE HALF IS OVERHEAD. The split is a shift's
   * job_id, and the engine is the only place it is applied. A second reader deciding for itself which
   * of his hours are build time is how the two figures start disagreeing.
   */
  it("the engine's time read fetches job_id, so the on-site half can be told from the office half", () => {
    const code = codeOnly(readFileSync(`${ROOT}/src/lib/analytics/owner-money.ts`, "utf8"));
    const select = code.split("\n").find((l) => l.includes('.from("time_entries")') || l.includes("time_entries"));
    expect(select, "owner-money still reads time_entries").toBeTruthy();
    expect(code).toMatch(/\.select\("id, profile_id, job_id,/);
  }, 30_000);
});

describe("the wage refusal has a SQL twin, and 0286's refusals are untouched", () => {
  /** 0373's new trigger: the database refuses a wage write to an owner, not only the server action. */
  it("the database refuses a positive hourly_rate on an owner's row", () => {
    const fn = liveFunctionBody("refuse_wages_for_an_owner_rate");
    expect(fn, "refuse_wages_for_an_owner_rate is defined by a migration").toBeTruthy();
    const body = fn!.body;
    // Clearing is allowed; only setting or changing a positive wage is refused.
    expect(body).toMatch(/coalesce\(new\.hourly_rate, 0\)\s*<=\s*0/);
    expect(body).toMatch(/new\.role is distinct from 'owner'/);
    expect(body).toMatch(/raise exception/);
    // And it is actually attached to profiles, watching hourly_rate.
    const sql = migrationText("0373_build_time_is_a_cost_whoever_worked_it.sql");
    expect(sql).toMatch(/create trigger refuse_wages_for_an_owner_rate\s+before insert or update of hourly_rate on public\.profiles/);
  });

  /**
   * 0286'S WAGE DOORS ARE NOT WEAKENED, and nothing in this wave may weaken them. A sole proprietor is
   * never an employee of his own sole proprietorship: no W-2, no pay period, no "owed". Costing an hour
   * and paying someone for it are different questions and the answer to the second is still no. If a
   * later migration drops one of these, this fails and names the file that did it.
   */
  it("no migration after 0286 drops the wage refusals", () => {
    for (const fn of ["refuse_wages_for_an_owner", "refuse_pay_rate_on_owner_entry"]) {
      const live = liveFunctionBody(fn);
      expect(live, `${fn} still has a live body`).toBeTruthy();
      expect(live!.body, `${fn} still raises`).toMatch(/raise exception/);
    }
    const dropped = migrationFiles()
      .filter((f) => f > "0286_")
      .filter((f) => /drop\s+trigger\s+(if\s+exists\s+)?refuse_(wages_for_an_owner|pay_rate_on_owner_entry)\b[^\n]*;\s*$/im.test(migrationText(f)))
      // 0286 itself and any migration that drops-then-recreates are fine; a bare drop is not.
      .filter((f) => !/create trigger refuse_(wages_for_an_owner|pay_rate_on_owner_entry)\b/i.test(migrationText(f)));
    expect(dropped).toEqual([]);
  }, 30_000);

  /** 0373 never replaces the view's hourly_rate rule: an owner still reads 0 there. Putting the cost
   *  rate in that column would print a wage on his own timeclock (which selects hourly_rate WITHOUT
   *  paid_by_draw and prints it as a gross) and would become his BILL rate when his bill rate is blank. */
  it("0373 keeps an owner's hourly_rate reading 0 and gives cost_rate its own column", () => {
    const sql = migrationText("0373_build_time_is_a_cost_whoever_worked_it.sql");
    expect(sql).toMatch(/case when p\.role = 'owner' then 0 else p\.hourly_rate end/);
    expect(sql).toMatch(/add column if not exists cost_rate numeric\(10,2\)/);
    // Read through unchanged: no case, no coalesce, so null reaches the app as null.
    expect(sql).toMatch(/\n\s*p\.cost_rate\n/);
    expect(sql).not.toMatch(/coalesce\(p\.cost_rate/);
    // And nothing is backfilled: the rate is a thing Erik SETS.
    expect(sql).not.toMatch(/update public\.profiles\s+set cost_rate/i);
  });
});

describe("buildTimeRate — the one rule, behaviourally", () => {
  // A time_entries row as a reader gets it, rates already merged onto `profiles` (attachRates). `any`
  // because that is what the readers hand these functions: a database row, not a narrowed shape.
  const shift = (over: Record<string, unknown> = {}): any => ({
    job_id: "j1",
    status: "closed",
    clock_in: "2026-09-01T15:00:00Z",
    clock_out: "2026-09-01T23:00:00Z",
    lunch_minutes: 0,
    profile_id: "p1",
    ...over,
  });

  it("a crew hour costs what payroll pays it", () => {
    expect(buildTimeRate(shift({ profiles: { hourly_rate: 40 } })).rate).toBe(40);
    expect(buildTimeRate(shift({ rate_override: 55, profiles: { hourly_rate: 40 } })).from).toBe("shift_rate");
  });

  it("an owner's hour costs his COST rate, never his pay column and never an override", () => {
    const owner = shift({ profiles: { paid_by_draw: true, hourly_rate: 0, cost_rate: 65 } });
    expect(isOwnerShift(owner)).toBe(true);
    expect(buildTimeRate(owner)).toEqual({ rate: 65, owner: true, from: "cost_rate" });
    // A leftover override on his shift is a wage by another name, and 0286's trigger refuses a new one.
    const withOverride = shift({ rate_override: 125, profiles: { paid_by_draw: true, hourly_rate: 0, cost_rate: 65 } });
    expect(buildTimeRate(withOverride).rate).toBe(65);
  });

  it("no cost rate set is NOT $0: it comes back as unset, and the hours are reported", () => {
    const owner = shift({ profiles: { paid_by_draw: true, hourly_rate: 0, cost_rate: null } });
    expect(buildTimeRate(owner)).toEqual({ rate: null, owner: true, from: "unset" });
    const t = tallyBuildTime([owner], { jobId: "j1" });
    expect(t.ownerHours).toBe(8);
    expect(t.uncostedOwnerHours).toBe(8);
    expect(t.cost).toBe(0);
    // And it is NEVER the crew's "unrated hours" alarm: he has no wage to be missing.
    expect(t.unratedHours).toBe(0);
  });

  it("his hours and the crew's are costed side by side on one job", () => {
    const t = tallyBuildTime(
      [
        shift({ profile_id: "crew", profiles: { hourly_rate: 40 } }),
        shift({ profile_id: "erik", profiles: { paid_by_draw: true, hourly_rate: 0, cost_rate: 65, full_name: "Erik Taylor" } }),
      ],
      { jobId: "j1" },
    );
    expect(t.hours).toBe(16);
    expect(t.cost).toBe(8 * 40 + 8 * 65);
    expect(t.ownerHours).toBe(8);
    expect(t.ownerCost).toBe(8 * 65);
    expect(t.owners).toEqual([{ id: "erik", name: "Erik Taylor" }]);
  });

  it("a job's own hours only: another job's shift is costed to that job, not this one", () => {
    const rows = [
      shift({ job_id: "j1", profiles: { paid_by_draw: true, cost_rate: 65 } }),
      shift({ job_id: "j2", profiles: { paid_by_draw: true, cost_rate: 65 } }),
    ];
    expect(tallyBuildTime(rows, { jobId: "j1" }).ownerCost).toBe(8 * 65);
    expect(tallyBuildTime(rows, { jobId: "j2" }).ownerCost).toBe(8 * 65);
  });
});
