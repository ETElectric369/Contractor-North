import { describe, it, expect } from "vitest";
import { payRateMap, payRateMapRead } from "@/lib/profile-columns";

/**
 * THE MIGRATION WINDOW (0286). A push to main deploys before its migration is applied, and a select
 * naming paid_by_draw fails WHOLE on the old profile_pay view. payRateMap drops the error, so
 * without the retry every caller would get an empty Map and price all crew labor at $0 with no
 * word said. Only undefined_column (42703) is tolerated; any other failure still refuses.
 */
function fakeProfilePay(opts: { hasColumn: boolean; failAll?: boolean }, selects: string[]) {
  const rows = [
    { id: "erik", hourly_rate: 125, bill_rate: 125, commute_baseline_miles: null },
    { id: "brian", hourly_rate: 40, bill_rate: 85, commute_baseline_miles: 12 },
  ];
  return {
    from: () => ({
      select: async (cols: string) => {
        selects.push(cols);
        if (opts.failAll) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        if (!opts.hasColumn && cols.includes("paid_by_draw")) {
          return { data: null, error: { code: "42703", message: "column profile_pay.paid_by_draw does not exist" } };
        }
        return { data: rows.map((r) => (opts.hasColumn ? { ...r, paid_by_draw: r.id === "erik" } : r)), error: null };
      },
    }),
  };
}

describe("payRateMapRead across the 0286 migration window", () => {
  it("after 0286: one read, the flag rides beside the rates", async () => {
    const selects: string[] = [];
    const { rates, problem } = await payRateMapRead(fakeProfilePay({ hasColumn: true }, selects));
    expect(problem).toBeNull();
    expect(selects).toHaveLength(1);
    expect(rates.get("erik")!.paid_by_draw).toBe(true);
    expect(rates.get("brian")).toEqual({ hourly_rate: 40, bill_rate: 85, commute_baseline_miles: 12, paid_by_draw: false });
  });

  it("before 0286: re-reads without the column, so crew rates never drop silently to nothing", async () => {
    const selects: string[] = [];
    const rates = await payRateMap(fakeProfilePay({ hasColumn: false }, selects));
    expect(selects).toHaveLength(2);
    expect(selects[1]).not.toContain("paid_by_draw");
    expect(rates.get("brian")!.hourly_rate).toBe(40);
    // The old view still costs the owner at his hourly_rate: the pre-0286 behaviour, not $0.
    expect(rates.get("erik")).toMatchObject({ hourly_rate: 125, paid_by_draw: false });
  });

  it("any other failure still refuses with the problem", async () => {
    const selects: string[] = [];
    const { rates, problem } = await payRateMapRead(fakeProfilePay({ hasColumn: true, failAll: true }, selects));
    expect(problem).toBe("the pay rates could not be read");
    expect(rates.size).toBe(0);
    expect(selects).toHaveLength(1);
  });
});
