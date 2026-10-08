import { describe, it, expect } from "vitest";
import { stampLeadWonByJob } from "./lead-won";

type Call = { table: string; patch: any; filters: [string, string, unknown][] };

function fake(fail: Partial<Record<string, boolean>> = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const c: Call = { table, patch: null, filters: [] };
      calls.push(c);
      const chain: any = {
        update: (patch: any) => ((c.patch = patch), chain),
        eq: (col: string, v: unknown) => (c.filters.push(["eq", col, v]), chain),
        is: (col: string, v: unknown) => (c.filters.push(["is", col, v]), chain),
        select: () => chain,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(fail[table] ? { data: null, error: { message: "refused" } } : { data: [{ id: "x" }], error: null }).then(res),
      };
      return chain;
    },
  };
  return { client: client as any, calls };
}

/** The lead stamp the attach door makes (cn-v1069): the job carries the lead only when it carries
 *  none, the lead is won only when nobody stamped it, both writes proven, a failure said. */
describe("stampLeadWonByJob", () => {
  it("a visit with no lead writes nothing", async () => {
    const { client, calls } = fake();
    expect(await stampLeadWonByJob(client, { jobId: "j1", inquiryId: null })).toEqual({});
    expect(calls).toEqual([]);
  });

  it("the job takes the lead where it has none; the lead is won where it was not yet", async () => {
    const { client, calls } = fake();
    expect(await stampLeadWonByJob(client, { jobId: "j1", inquiryId: "l1" })).toEqual({});
    expect(calls[0]).toMatchObject({ table: "jobs", patch: { inquiry_id: "l1" }, filters: [["eq", "id", "j1"], ["is", "inquiry_id", null]] });
    expect(calls[1].table).toBe("inquiries");
    expect(calls[1].patch).toMatchObject({ status: "won" });
    expect(calls[1].patch.converted_at).toMatch(/^\d{4}-/);
    expect(calls[1].filters).toEqual([["eq", "id", "l1"], ["is", "converted_at", null]]);
  });

  it("a refused write comes back as the sentence to show, never silently", async () => {
    const { client } = fake({ inquiries: true });
    expect(await stampLeadWonByJob(client, { jobId: "j1", inquiryId: "l1" })).toEqual({
      warning: "The lead behind this visit could not be marked won. Mark it on Leads.",
    });
  });
});
