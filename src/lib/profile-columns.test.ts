import { describe, it, expect } from "vitest";
import { payRateMap, payRateMapRead } from "@/lib/profile-columns";

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
    { id: "erik", hourly_rate: 125, bill_rate: 125, commute_baseline_miles: null },
    { id: "brian", hourly_rate: 40, bill_rate: 85, commute_baseline_miles: 12 },
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
