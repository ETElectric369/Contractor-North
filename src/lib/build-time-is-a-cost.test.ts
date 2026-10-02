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
 * THE TWO FAULT SIGNATURES, as named predicates so each one can be held to the historical line it
 * exists because of (below). A regex that has quietly stopped matching the bug is a tripwire that
 * passes forever, which is worse than no tripwire at all.
 */
const PRICES_OWNER_AT_ZERO = (l: string): boolean =>
  /(paid_by_draw|paidByDraw|isPaidByDraw\s*\(|isOwnerShift\s*\()/.test(l) &&
  /(\breturn\s+0\b|\?\s*0\s*:|:\s*0\s*[,;)]|=\s*0\s*;)/.test(l);

const REBUILDS_SHIFT_TEST = (l: string): boolean =>
  /isPaidByDraw\s*\([^)]*\)\s*\|\|/.test(l) || /paid_by_draw\s*===\s*true\s*\|\|/.test(l);

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

  /**
   * THE PREDICATE, HAND-WRITTEN AS A ZERO. This is 0286's own fault, named: payroll-math.ts answered
   * `if (paid_by_draw) return 0` BEFORE it read any rate, and labor-billing.ts wrote `owner ? 0 : …`,
   * so replacing the view changed nothing in the app. buildTimeRate is the expression now, and a reader
   * that turns the flag into a zero itself has written the costing rule again.
   *
   * ONLY A ZERO, NOT A SKIP. A bare `continue` on the flag is NOT this fault and must not be banned:
   * excluding an owner from a WAGE figure is correct and there are five such lines in owner-money alone
   * (crew mileage settled, the crew "hours with no pay rate" alarm, the Pay board's You Owe), plus two
   * that select owners IN to tally their hours. Banning those would force an argued exception per line
   * and teach the next engineer to add one. What is never right is pricing his hour at $0 by hand.
   */
  it("no reader prices an owner's hour at $0 on its own", () => {
    // THE SCANNER IS NOT VACUOUS: the two lines this rule exists because of still match it. If a
    // refactor softens the pattern, THIS fails before the scan starts passing for the wrong reason.
    expect(PRICES_OWNER_AT_ZERO("  if (e?.profiles?.paid_by_draw === true || e?.paid_by_draw === true) return 0;")).toBe(true);
    expect(PRICES_OWNER_AT_ZERO("    const rate = isPaidByDraw(e?.profiles) ? 0 : payRateForEntry(e, fallbackRate);")).toBe(true);
    // And the five wage-side skips it must NOT match.
    expect(PRICES_OWNER_AT_ZERO("    if (person?.paidByDraw) continue;")).toBe(false);
    expect(PRICES_OWNER_AT_ZERO("    if (!pid || !person?.paidByDraw) continue;")).toBe(false);
    expect(scan(PRICES_OWNER_AT_ZERO).hits).toEqual([]);
  }, 30_000);

  /**
   * THE SHIFT TEST, HAND-WRITTEN. labor-billing.ts used to open with
   * `const owner = isPaidByDraw(e?.profiles) || e?.paid_by_draw === true;` and then zero him on the next
   * line - two lines, so no single-line scan could see the fault whole. `isOwnerShift` is that
   * expression now, in the owner module, and a reader that rebuilds the two-sided test is one edit away
   * from rebuilding the zero beside it. Asking "is this person on the Pay board" off the engine's own
   * person record (`person.paidByDraw`) is a different, wage-side question and is untouched.
   */
  it("no reader rebuilds the two-sided 'is this an owner's shift' test", () => {
    expect(REBUILDS_SHIFT_TEST("  const owner = isPaidByDraw(e?.profiles) || e?.paid_by_draw === true;")).toBe(true);
    expect(REBUILDS_SHIFT_TEST("  const isOwner = person?.paidByDraw === true;")).toBe(false);
    expect(scan(REBUILDS_SHIFT_TEST).hits).toEqual([]);
  }, 30_000);

  /**
   * THE RATE, READ FROM THE WRONG COLUMN. cost_rate is the owner's; bill_rate is the CUSTOMER'S PRICE.
   * A reader that costs his hours at bill_rate rebuilds 0286's exact defect - his cost equal to his
   * price, every hour netting $0, all-time job profit reading -$1,085 against a real +$35,847. A
   * reader that costs them at hourly_rate reads 0 (the view) or, in a deploy window, his old $125.
   */
  it("no reader costs an hour at the bill rate", () => {
    const { hits } = scan(
      (l) =>
        /\bbill_?[Rr]ate\b/.test(l) &&
        /\b(cost|costOf|costRate|cost_rate|laborCost|buildTime|payRate)\b/.test(l) &&
        // Naming both in one condition is how a GUARD is written (the Team page warns when cost >= bill).
        !/[<>]=?|!==|===/.test(l),
    );
    expect(hits).toEqual([]);
  }, 30_000);

  /**
   * THE HOURS, TURNED INTO MONEY BY HAND. `hours * rate` anywhere outside the owner modules is a second
   * costing rule: it cannot know that an owner's rate is cost_rate, that office hours are not a job
   * cost, or that a missing rate must be REPORTED rather than silently multiplied by zero.
   */
  it("no reader multiplies hours by a rate to get a cost", () => {
    const { hits } = scan((l) => /\bhours?\b[^\n]{0,24}\*[^\n]{0,24}\b(cost_?rate|costRate)\b/i.test(l));
    expect(hits).toEqual([]);
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
