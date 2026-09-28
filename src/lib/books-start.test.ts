import { describe, it, expect } from "vitest";
import { booksBeginOn, readBooksStart } from "@/app/(app)/bills/supplier-papers";

/**
 * THE DAY A COMPANY'S BOOKS BEGIN, READ ON ITS OWN (readBooksStart, NY-feeders 0366): the day it
 * named, else its earliest live bill, else the day the company was made (on its own clock). Every
 * read is pinned to the company it was handed (from the profile), never "the first organization the
 * session can see"; a failed read throws, so no caller draws the line in the wrong place.
 */
type Reply = { data: unknown; error: unknown };
function fake(replies: { org?: Reply; orgCreated?: Reply; bills?: Reply }) {
  const asked: { table: string; cols: string; filters: unknown[][] }[] = [];
  return {
    asked,
    from(table: string) {
      const q = { table, cols: "", filters: [] as unknown[][] };
      asked.push(q);
      const answer = (): Reply => {
        if (table === "organizations") return q.cols === "created_at" ? (replies.orgCreated ?? { data: null, error: null }) : (replies.org ?? { data: { settings: {} }, error: null });
        if (table === "bills") return replies.bills ?? { data: null, error: null };
        return { data: null, error: { message: `unrouted ${table}` } };
      };
      const chain: any = {
        select: (cols: string) => ((q.cols = cols), chain),
        maybeSingle: async () => answer(),
      };
      for (const m of ["eq", "is", "not", "order", "limit"]) chain[m] = (...a: unknown[]) => (q.filters.push([m, ...a]), chain);
      return chain;
    },
  };
}
const ORG = "org-1";

describe("readBooksStart", () => {
  it("the day the company named wins, and nothing else is read", async () => {
    const db = fake({ org: { data: { settings: { books_begin: "2026-06-08", timezone: "America/Los_Angeles" } }, error: null } });
    expect(await readBooksStart(db, ORG)).toBe("2026-06-08");
    expect(db.asked.map((a) => a.table)).toEqual(["organizations"]);
    expect(db.asked[0].filters).toContainEqual(["eq", "id", ORG]);
  });

  it("no day named: its earliest live bill (superseded ones left out)", async () => {
    const db = fake({ bills: { data: { bill_date: "2026-05-02" }, error: null } });
    expect(await readBooksStart(db, ORG)).toBe("2026-05-02");
    const bills = db.asked.find((a) => a.table === "bills")!;
    expect(bills.filters).toContainEqual(["eq", "org_id", ORG]);
    expect(bills.filters).toContainEqual(["is", "superseded_by_bill_id", null]);
    expect(bills.filters).toContainEqual(["order", "bill_date", { ascending: true }]);
    // The same answer booksBeginOn gives from the rows themselves.
    expect(booksBeginOn({}, [{ bill_date: "2026-07-01" }, { bill_date: "2026-05-02" }])).toBe("2026-05-02");
  });

  it("no day named and no bills: the day the company was made, on its own clock", async () => {
    // 03:30 UTC on Sep 2 is still Sep 1 in Los Angeles.
    const db = fake({
      org: { data: { settings: { timezone: "America/Los_Angeles" } }, error: null },
      orgCreated: { data: { created_at: "2026-09-02T03:30:00Z" }, error: null },
    });
    expect(await readBooksStart(db, ORG)).toBe("2026-09-01");
    const made = db.asked.filter((a) => a.table === "organizations").at(-1)!;
    expect(made.cols).toBe("created_at");
    expect(made.filters).toContainEqual(["eq", "id", ORG]);
    // Never "the first organization the session can see".
    expect(db.asked.some((a) => a.table === "organizations" && a.filters.some((f) => f[0] === "limit"))).toBe(false);
  });

  it("a failed read throws, whichever it was", async () => {
    await expect(readBooksStart(fake({ org: { data: null, error: { message: "timeout" } } }), ORG)).rejects.toMatchObject({ message: "timeout" });
    await expect(readBooksStart(fake({ bills: { data: null, error: { message: "bills down" } } }), ORG)).rejects.toMatchObject({ message: "bills down" });
    await expect(
      readBooksStart(fake({ orgCreated: { data: null, error: { message: "org down" } } }), ORG),
    ).rejects.toMatchObject({ message: "org down" });
  });

  it("no company row at all: null, never a made-up day", async () => {
    expect(await readBooksStart(fake({}), ORG)).toBeNull();
  });
});
