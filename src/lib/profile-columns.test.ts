import { describe, it, expect } from "vitest";
import { payRateMap, payRateMapRead, profilePayRead } from "@/lib/profile-columns";

/**
 * THE MIGRATION WINDOW (0286, and 0373 behind it). A push to main deploys before its migration is
 * applied, and a select naming a column the view has not got yet fails WHOLE. payRateMap drops the
 * error, so without the retry every caller would get an empty Map and price all crew labor at $0 with
 * no word said. Only undefined_column (42703) is tolerated; any other failure still refuses.
 *
 * ONE COLUMN BACK AT A TIME, and the order matters. The read asks for paid_by_draw AND cost_rate; a
 * database with 0286 but not 0373 has the first and not the second, and dropping straight to the bare
 * columns would lose the DRAW FLAG along with the cost rate. Without the flag the owner reads as crew
 * with no pay rate, which raises a false "hours with no rate" alarm about a wage he has never had. So
 * the ladder has three rungs: both, then the flag alone, then neither.
 */
type Rung = "both" | "flag_only" | "neither";

function fakeProfilePay(opts: { rung: Rung; failAll?: boolean }, selects: string[]) {
  const rows = [
    { id: "erik", org_id: "org-1", full_name: "Erik Taylor", hourly_rate: 125, bill_rate: 125, home_address: "1 Shop Rd", commute_baseline_miles: null, active: true },
    { id: "brian", org_id: "org-1", full_name: "Brian Taylor", hourly_rate: 40, bill_rate: 85, home_address: "2 Crew St", commute_baseline_miles: 12, active: true },
  ];
  const has = (col: string) =>
    opts.rung === "both" ? true : opts.rung === "flag_only" ? col === "paid_by_draw" : false;
  return {
    from: () => ({
      select: async (cols: string) => {
        selects.push(cols);
        if (opts.failAll) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        for (const col of ["cost_rate", "paid_by_draw"]) {
          if (cols.includes(col) && !has(col)) {
            return { data: null, error: { code: "42703", message: `column profile_pay.${col} does not exist` } };
          }
        }
        return {
          data: rows.map((r) => ({
            ...r,
            ...(has("paid_by_draw") ? { paid_by_draw: r.id === "erik" } : {}),
            ...(has("cost_rate") ? { cost_rate: r.id === "erik" ? 65 : null } : {}),
          })),
          error: null,
        };
      },
    }),
  };
}

describe("payRateMapRead across the 0286 and 0373 migration windows", () => {
  it("both columns: one read, the flag AND the build-time cost rate ride beside the rates", async () => {
    const selects: string[] = [];
    const { rates, problem } = await payRateMapRead(fakeProfilePay({ rung: "both" }, selects));
    expect(problem).toBeNull();
    expect(selects).toHaveLength(1);
    expect(rates.get("erik")).toEqual({ hourly_rate: 125, bill_rate: 125, commute_baseline_miles: null, paid_by_draw: true, cost_rate: 65 });
    expect(rates.get("brian")).toEqual({ hourly_rate: 40, bill_rate: 85, commute_baseline_miles: 12, paid_by_draw: false, cost_rate: null });
  });

  it("0286 applied, 0373 not: drops the cost rate and KEEPS the draw flag", async () => {
    const selects: string[] = [];
    const { rates, problem } = await payRateMapRead(fakeProfilePay({ rung: "flag_only" }, selects));
    expect(problem).toBeNull();
    expect(selects).toHaveLength(2);
    expect(selects[1]).toContain("paid_by_draw");
    expect(selects[1]).not.toContain("cost_rate");
    // THE POINT OF THE MIDDLE RUNG: he is still known to be the owner, so no caveat calls his hours
    // "hours with no pay rate". His build time simply is not costed yet, which is also true.
    expect(rates.get("erik")).toMatchObject({ paid_by_draw: true, cost_rate: null });
    expect(rates.get("brian")!.hourly_rate).toBe(40);
  });

  it("before 0286: re-reads without either column, so crew rates never drop silently to nothing", async () => {
    const selects: string[] = [];
    const rates = await payRateMap(fakeProfilePay({ rung: "neither" }, selects));
    expect(selects).toHaveLength(3);
    expect(selects[2]).not.toContain("paid_by_draw");
    expect(selects[2]).not.toContain("cost_rate");
    expect(rates.get("brian")!.hourly_rate).toBe(40);
    // The old view still costs the owner at his hourly_rate: the pre-0286 behaviour, not $0.
    expect(rates.get("erik")).toMatchObject({ hourly_rate: 125, paid_by_draw: false, cost_rate: null });
  });

  it("any other failure still refuses with the problem", async () => {
    const selects: string[] = [];
    const { rates, problem } = await payRateMapRead(fakeProfilePay({ rung: "both", failAll: true }, selects));
    expect(problem).toBe("the pay rates could not be read");
    expect(rates.size).toBe(0);
    expect(selects).toHaveLength(1);
  });
});

/**
 * THE ROSTER READ IS THE SAME LADDER, BECAUSE IT IS THE SAME DOOR (the fix for the /team defect).
 *
 * /team selected the full column list by hand, with no ladder and no error check. In the window
 * between a push and Erik applying 0373 - which is the state production is in, and for this branch an
 * OPEN-ENDED one, because ~/Developer/db/pending holds a different 0373 from another workflow - that
 * select fails WHOLE on `column "cost_rate" does not exist`. The page then rendered every rate at
 * $0.00, a false "No bill rate set" on every row, blank home addresses, a 0 commute baseline, and -
 * because isPaidByDraw(undefined) is false - NO Cost box on the owner's row, which is the one door the
 * whole feature needs him to find. A save in that state wrote the zeros back as nulls.
 *
 * So there is one function with the ladder behind it and no exported column list to select by hand.
 * The migration-window rungs are proved here against the roster read, not only the rates read.
 */
describe("profilePayRead - the roster read carries the same migration-window ladder", () => {
  it("both columns: one read, and the owner's cost rate is on his row", async () => {
    const selects: string[] = [];
    const { rows, problem } = await profilePayRead(fakeProfilePay({ rung: "both" }, selects));
    expect(problem).toBeNull();
    expect(selects).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "erik")).toMatchObject({ paid_by_draw: true, cost_rate: 65, bill_rate: 125 });
  });

  /**
   * THE DEFECT, BEHAVIOURALLY. 0286 applied and 0373 not. Before the fix the whole read failed and
   * /team got null: every rate $0, no Cost box, and the addresses gone. Now it steps back one column
   * and the page keeps every figure it is entitled to - the draw flag included, so the owner's row
   * still draws his Cost box with an empty value rather than a crew Pay box reading $0.
   */
  it("0286 applied, 0373 not: the roster still comes back WHOLE, minus only the cost rate", async () => {
    const selects: string[] = [];
    const { rows, problem } = await profilePayRead(fakeProfilePay({ rung: "flag_only" }, selects));
    expect(problem).toBeNull();
    expect(selects).toHaveLength(2);
    expect(selects[1]).toContain("paid_by_draw");
    expect(selects[1]).not.toContain("cost_rate");
    const erik = rows.find((r) => r.id === "erik")!;
    // The flag survives, so the Cost box is still the box his row draws.
    expect(erik.paid_by_draw).toBe(true);
    expect(erik.cost_rate ?? null).toBeNull();
    // And the figures a save would otherwise have nulled are all still here.
    expect(erik.bill_rate).toBe(125);
    const brian = rows.find((r) => r.id === "brian")!;
    expect(brian.bill_rate).toBe(85);
    expect(brian.hourly_rate).toBe(40);
    expect(brian.home_address).toBe("2 Crew St");
    expect(brian.commute_baseline_miles).toBe(12);
  });

  it("before 0286: back to the bare columns, and the roster is still readable", async () => {
    const selects: string[] = [];
    const { rows, problem } = await profilePayRead(fakeProfilePay({ rung: "neither" }, selects));
    expect(problem).toBeNull();
    expect(selects).toHaveLength(3);
    expect(selects[2]).not.toContain("paid_by_draw");
    expect(rows.find((r) => r.id === "brian")!.bill_rate).toBe(85);
  });

  /** NOTHING SILENT: a failure that is NOT a missing column comes back as a problem the page says
   *  out loud, instead of an empty list the page draws as a roster of $0.00 rates. */
  it("any other failure comes back as a problem, never as an empty roster", async () => {
    const selects: string[] = [];
    const { rows, problem } = await profilePayRead(fakeProfilePay({ rung: "both", failAll: true }, selects));
    expect(problem).toBe("the pay rates could not be read");
    expect(rows).toEqual([]);
    expect(selects).toHaveLength(1);
  });
});
