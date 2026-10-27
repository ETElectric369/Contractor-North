import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveEstimateBehindVisit } from "./behind-visit";

/**
 * THE ESTIMATE A VISIT ALREADY BECAME (cn-v1132, S1), driven against a recording fake client: the
 * one answer /quotes/new?capture= redirects on, so a second open never births a twin.
 */
type Call = { table: string; select?: string; filters: unknown[][] };
function fake(answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const c: Call = { table, filters: [] };
    const b: any = {
      select: (cols: string) => ((c.select = cols), b),
      maybeSingle: async () => (calls.push(c), answer(c)),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => (calls.push(c), Promise.resolve(answer(c)).then(ok, err)),
    };
    for (const m of ["eq", "in", "is", "order", "limit", "neq", "not"]) b[m] = (...a: unknown[]) => (c.filters.push([m, ...a]), b);
    return b;
  };
  return { sb: { from } as never, calls };
}
const quote = (status: string | null) => (c: Call) => (c.table === "quotes" ? { data: { id: "q1", status }, error: null } : { data: [], error: null });

describe("liveEstimateBehindVisit", () => {
  it("no id behind the visit: null, and nothing is read", async () => {
    const f = fake(() => ({ data: null, error: null }));
    expect(await liveEstimateBehindVisit(f.sb, null)).toBeNull();
    expect(f.calls).toEqual([]);
  });
  it("a draft, sent or accepted estimate is OPENED; the read names its columns and the id", async () => {
    for (const status of ["draft", "sent", "accepted"]) {
      const f = fake(quote(status));
      expect(await liveEstimateBehindVisit(f.sb, "q1")).toBe("q1");
      expect(f.calls[0]).toMatchObject({ table: "quotes", select: "id, status", filters: [["eq", "id", "q1"]] });
    }
  });
  it("a declined or expired estimate is over: null, so Start The Estimate is honest", async () => {
    for (const status of ["declined", "expired"]) expect(await liveEstimateBehindVisit(fake(quote(status)).sb, "q1")).toBeNull();
  });
  it("a row this company cannot read is null (RLS: not ours, or gone)", async () => {
    expect(await liveEstimateBehindVisit(fake(() => ({ data: null, error: null })).sb, "q-theirs")).toBeNull();
  });
  it("a superseded estimate opens its standing revision; with none standing it opens itself", async () => {
    const withRevision = fake((c) => {
      if (c.table === "quotes" && c.select === "id, status") return { data: { id: "q1", status: "superseded" }, error: null };
      // revisionOf's read: the accepted revision of q1 (one row, newest accepted first).
      if (c.table === "quotes" && c.select === "id, quote_number, accepted_at, status") return { data: { id: "q2", quote_number: "E-002", status: "accepted" }, error: null };
      return { data: null, error: null };
    });
    expect(await liveEstimateBehindVisit(withRevision.sb, "q1")).toBe("q2");
    expect(withRevision.calls[1].filters).toContainEqual(["eq", "revises_quote_id", "q1"]);
    const alone = fake((c) => (c.table === "quotes" && c.select === "id, status" ? { data: { id: "q1", status: "superseded" }, error: null } : { data: null, error: null }));
    expect(await liveEstimateBehindVisit(alone.sb, "q1")).toBe("q1");
  });
  it("a failed read throws in dbError's words — an estimate is never started over a visit the page could not read", async () => {
    const f = fake(() => ({ data: null, error: { code: "XX000", message: "the reader tripped" } }));
    await expect(liveEstimateBehindVisit(f.sb, "q1")).rejects.toThrow("the reader tripped");
  });
  it("the new-estimate page asks before it renders, and redirects on the answer", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/quotes/new/page.tsx"), "utf8");
    const ask = page.indexOf("const standing = await liveEstimateBehindVisit(supabase, captureQuoteId((appt as any).capture));");
    const go = page.indexOf("if (standing) redirect(`/quotes/${standing}`);");
    const seed = page.indexOf("typedCapture = parseInspectorCapture((appt as any).capture);");
    expect(ask).toBeGreaterThan(-1);
    expect(go).toBeGreaterThan(ask);
    expect(seed).toBeGreaterThan(go);
  });
});
