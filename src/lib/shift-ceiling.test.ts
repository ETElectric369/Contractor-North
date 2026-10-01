import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { eachAppSource, liveFunctionBody } from "@/lib/migration-body.test-util";
import { CEILING_REFUSAL, CEILING_REFUSAL_ASK_OFFICE, MAX_SHIFT_HOURS, MAX_SHIFT_PHRASE, PICK_WITHIN_CEILING, stopProblem } from "@/lib/long-shift";

/**
 * THE SHIFT CEILING IS SAID TWICE ON PURPOSE, AND THE TWO MUST SAY THE SAME NUMBER (W4).
 *
 * The app says the ceiling in plain words BEFORE somebody wastes the typing (the stop picker greys
 * out, the sheet says what a good time looks like), and the database is the boundary nothing gets
 * past (a crafted PostgREST PATCH never reaches app code). Both have to exist: merging them would
 * either make the refusal arrive only after the save, or leave the real boundary in JavaScript.
 *
 * What was missing is the thing that makes two copies safe — something that FAILS when they stop
 * agreeing. Nothing in the suite compared them. Moving `MAX_SHIFT_HOURS` to 20 and leaving the
 * database at 18 left the app offering a 19-hour stop that the database then threw out, and the
 * person reading "more than 18 hours" from a refusal that fired at 20.
 *
 *   the app's number      src/lib/long-shift.ts MAX_SHIFT_HOURS, and every sentence derived from it
 *                         (MAX_SHIFT_PHRASE) rather than typed again;
 *   the database's        three live functions, each the LAST migration that replaces it:
 *                         guard_time_entry_sanity (a saved span over the ceiling),
 *                         guard_paid_time_entry   (the puncher closing their own long shift),
 *                         close_stale_open_entry  (the next punch zero-closing a forgotten clock).
 *
 * This reads the migration FILES, not a live database, so it runs in the unit project on every
 * push with no credentials. The DB-catalog twin (timeclock/pay-column-guard.integration.test.ts)
 * holds the DEPLOYED function to the same number.
 */

/**
 * Where the database writes the ceiling, one per function, each anchored to the comparison it is
 * actually used in. An anchor that stops matching FAILS rather than passing quietly: a rewritten
 * guard has to come back here and re-point it, which is the whole point of the test.
 */
const DB_CEILINGS: { fn: string; what: string; anchor: RegExp }[] = [
  {
    fn: "guard_time_entry_sanity",
    what: "a saved shift longer than the ceiling is refused unless the system closed it and said why",
    anchor: /v_span\s*>\s*interval\s*'(\d+)\s*hours?'/,
  },
  {
    fn: "guard_paid_time_entry",
    what: "the person who punched cannot close their own shift longer than the ceiling",
    anchor: /new\.clock_out\s*-\s*new\.clock_in\s*>\s*interval\s*'(\d+)\s*hours?'/,
  },
  {
    fn: "close_stale_open_entry",
    what: "the next punch zero-closes a clock left running past the ceiling",
    anchor: /v_ceiling\s+constant\s+interval\s*:=\s*interval\s*'(\d+)\s*hours?'/,
  },
];

describe("the shift ceiling: the app's number and the database's never drift apart (W4)", () => {
  for (const c of DB_CEILINGS) {
    it(`${c.fn} refuses at ${MAX_SHIFT_HOURS} hours — ${c.what}`, () => {
      const live = liveFunctionBody(c.fn);
      expect(live, `no migration creates public.${c.fn}`).not.toBeNull();
      const m = c.anchor.exec(live!.body);
      expect(
        m,
        `public.${c.fn} (live in ${live!.file}) no longer writes its ceiling where this test looks. ` +
          `If the guard was rewritten, re-point DB_CEILINGS' anchor at the new comparison — do not delete it.`,
      ).not.toBeNull();
      expect(Number(m![1]), `${c.fn} in ${live!.file} vs MAX_SHIFT_HOURS in src/lib/long-shift.ts`).toBe(MAX_SHIFT_HOURS);
    });
  }

  it("every sentence a person reads quotes the app's own number", () => {
    const H = 3_600_000;
    const start = Date.parse("2001-01-01T16:00:00Z");
    const over = {
      startMs: start,
      stopMs: start + (MAX_SHIFT_HOURS + 1) * H,
      nowMs: start + (MAX_SHIFT_HOURS + 2) * H,
      lunchMin: 0,
    };
    // The refusal fires at the ceiling the constant names, and SAYS that number.
    for (const who of ["you", "he"] as const) {
      const said = stopProblem({ ...over, who });
      expect(said).toBe(CEILING_REFUSAL[who]);
      expect(said).toContain(MAX_SHIFT_PHRASE);
    }
    // A minute inside the ceiling is a real stop, so the sentence is never shown early.
    expect(stopProblem({ ...over, stopMs: start + MAX_SHIFT_HOURS * H - 60_000, who: "you" })).toBeNull();
    for (const sentence of [CEILING_REFUSAL_ASK_OFFICE, PICK_WITHIN_CEILING]) {
      expect(sentence).toContain(MAX_SHIFT_PHRASE);
    }
  });

  /**
   * A DELIBERATE BYPASS TRIPWIRE (not the proof the behaviour works — the cases above are that).
   * Every sentence that names the ceiling reads MAX_SHIFT_PHRASE. A new door that types the number
   * into its own string is exactly how the app came to tell people 18 while refusing at 20, so it
   * fails here instead of shipping.
   */
  it("no screen types the ceiling into a sentence of its own", () => {
    const quoted = new RegExp(`["'\`][^"'\`\\n]*\\b${MAX_SHIFT_HOURS} hours?\\b`);
    const offenders: string[] = [];
    eachAppSource((p, code) => {
      if (quoted.test(code)) offenders.push(p);
    }, [join("src", "lib", "long-shift.ts")]);
    expect(offenders, `these say the ceiling in their own words — use MAX_SHIFT_PHRASE: ${offenders.join(", ")}`).toEqual([]);
  });
});
