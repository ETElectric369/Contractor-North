import { describe, it, expect } from "vitest";
import {
  isMissingShelf,
  jobMaterialCost,
  jobMaterialCostByJob,
  jobMaterialCostFrom,
  readJobShelfNet,
  shelfNetByJob,
  splitJobMaterialCost,
} from "@/lib/job-cost";

/** job_shelf_net, faked: the rows it would return, or an error. Records the filters asked for. */
function fakeShelf(result: { data: any[] | null; error?: any }, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(`from:${table}`);
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => (seen.push(`eq:${c}:${v}`), b),
        in: (c: string, v: unknown[]) => (seen.push(`in:${c}:${v.length}`), b),
        limit: () => b,
        then: (ok: any, err: any) => Promise.resolve({ data: result.data, error: result.error ?? null }).then(ok, err),
      };
      return b;
    },
  };
}

describe("jobMaterialCost: bills - off_shelf + from_shelf, to the cent", () => {
  it("with nothing on the shelf, a job costs exactly its bills (the Phase 1 identity)", () => {
    expect(jobMaterialCostFrom(477.4 + 199.48)).toBe(676.88);
    expect(jobMaterialCostFrom(676.88, { offShelf: 0, fromShelf: 0 })).toBe(676.88);
    expect(splitJobMaterialCost(676.88)).toEqual({ total: 676.88, tickets: 676.88, fromStock: 0, offShelf: 0, shelfTouched: false });
  });

  it("Herringbone puts both coils and the 14/2 on the shelf; another job takes 60 ft", () => {
    // J-011's two CED tickets: $477.40 + $199.48. Shelf: $180.17 + $180.17 + $121.64 = $481.98.
    const herringbone = splitJobMaterialCost(676.88, { offShelf: 481.98, fromShelf: 0 });
    expect(herringbone).toMatchObject({ total: 194.9, tickets: 194.9, fromStock: 0, shelfTouched: true });
    const other = splitJobMaterialCost(0, { offShelf: 0, fromShelf: 43.24 });
    expect(other).toMatchObject({ total: 43.24, tickets: 0, fromStock: 43.24, shelfTouched: true });
  });

  it("reads numeric columns that arrive as strings, and sums two rows for one job", () => {
    const m = shelfNetByJob([
      { job_id: "J", off_shelf: "180.17", from_shelf: "0.00" },
      { job_id: "J", off_shelf: "0.10", from_shelf: "43.24" },
      { job_id: null, off_shelf: "9", from_shelf: "9" },
    ]);
    expect(m.get("J")).toEqual({ offShelf: 180.27, fromShelf: 43.24 });
    expect(m.size).toBe(1);
  });
});

describe("readJobShelfNet: one view, and a lost read is never a job with no shelf", () => {
  it("scopes to one job, or to a list", async () => {
    const seen: string[] = [];
    await readJobShelfNet(fakeShelf({ data: [] }, seen), "J1");
    await readJobShelfNet(fakeShelf({ data: [] }, seen), ["J1", "J2"]);
    expect(seen).toEqual(["from:job_shelf_net", "eq:job_id:J1", "from:job_shelf_net", "in:job_id:2"]);
  });

  it("reads a database before 0303 as no lots (there cannot be a lot in a table that isn't there)", async () => {
    const missing = { code: "42P01", message: 'relation "public.job_shelf_net" does not exist' };
    const r = await readJobShelfNet(fakeShelf({ data: null, error: missing }), "J1");
    expect(r.error).toBeNull();
    expect(r.byJob.size).toBe(0);
    expect(isMissingShelf({ code: "PGRST205", message: "Could not find the table 'public.job_shelf_net' in the schema cache" })).toBe(true);
  });

  it("returns any other failure, and the job cost helpers refuse on it", async () => {
    const boom = { code: "57014", message: "canceling statement due to statement timeout" };
    const r = await readJobShelfNet(fakeShelf({ data: null, error: boom }), "J1");
    expect(r.error).toBe(boom);
    await expect(jobMaterialCost(fakeShelf({ data: null, error: boom }), "J1", 10)).rejects.toBe(boom);
    expect(isMissingShelf(boom)).toBe(false);
  });

  it("jobMaterialCostByJob covers a job that only took from the shelf", async () => {
    const db = fakeShelf({ data: [{ job_id: "B", off_shelf: "0", from_shelf: "43.24" }] });
    const out = await jobMaterialCostByJob(db, new Map([["A", 100]]));
    expect(out.get("A")).toMatchObject({ total: 100, shelfTouched: false });
    expect(out.get("B")).toMatchObject({ total: 43.24, fromStock: 43.24 });
  });
});
