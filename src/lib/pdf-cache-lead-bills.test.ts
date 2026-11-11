import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A LEAD'S EDIT OR DELETE REACHES THE BILLS BORN FROM ITS ESTIMATES (cn-v1160). A bill made straight
 * from an estimate with no job prints the place the estimate prints, which for a lead's estimate is
 * the lead's address, so the stored copies a customer downloads of those bills go with the edit, as
 * the estimates' own copies do. Pinned against a stand-in for the service client that records what is
 * read and what is dropped: the bills are those whose estimate is one of the lead's, in this company
 * only; a failed read is reported and never thrown; no company, no fan-out. Every id is invented.
 */

type Read = { table: string; eqs: [string, unknown][]; ins: [string, unknown[]][]; del: boolean };
const st = vi.hoisted(() => ({
  reads: [] as Read[],
  quotes: [] as { id: string }[],
  bills: [] as { id: string }[],
  billsError: null as null | { message: string },
  reported: [] as string[],
}));

vi.mock("@/lib/observe", () => ({ reportError: (where: string) => st.reported.push(where) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createServiceClient: () => ({
    storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
    from: (table: string) => {
      const r: Read = { table, eqs: [], ins: [], del: false };
      st.reads.push(r);
      const chain: any = {
        select: () => chain,
        delete: () => ((r.del = true), chain),
        eq: (c: string, v: unknown) => (r.eqs.push([c, v]), chain),
        in: (c: string, v: unknown[]) => (r.ins.push([c, v]), chain),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
          const answer =
            table === "quotes" ? { data: st.quotes, error: null } : table === "invoices" ? { data: st.billsError ? null : st.bills, error: st.billsError } : { data: [], error: null };
          return Promise.resolve(answer).then(ok, bad);
        },
      };
      return chain;
    },
  }),
}));

import { bustBillsOfQuotes, bustLeadPdfs } from "./pdf-cache";

const ORG = "0a000000-0000-4000-8000-00000000c001";
const LEAD = "0e000000-0000-4000-8000-00000000a001";
/** The stored copies dropped, as "doc:id@org". */
const dropped = () => st.reads.filter((r) => r.table === "doc_pdf_cache" && r.del).map((r) => `${r.eqs.find((e) => e[0] === "doc")?.[1]}:${r.eqs.find((e) => e[0] === "doc_id")?.[1]}@${r.eqs.find((e) => e[0] === "org_id")?.[1]}`);

beforeEach(() => {
  st.reads = [];
  st.quotes = [{ id: "q-1" }, { id: "q-2" }];
  st.bills = [{ id: "inv-1" }];
  st.billsError = null;
  st.reported = [];
});

describe("a lead's edit drops the stored copies of its estimates AND of the bills born from them", () => {
  it("the estimates', then the bills' whose estimate is one of the lead's, each inside the company", async () => {
    await bustLeadPdfs(LEAD, ORG);
    expect(dropped()).toEqual([`quote:q-1@${ORG}`, `quote:q-2@${ORG}`, `invoice:inv-1@${ORG}`]);
    const bills = st.reads.find((r) => r.table === "invoices")!;
    expect(bills.ins).toEqual([["quote_id", ["q-1", "q-2"]]]);
    expect(bills.eqs).toEqual([["org_id", ORG]]);
  });

  it("a lead with no estimates asks for no bills", async () => {
    st.quotes = [];
    await bustLeadPdfs(LEAD, ORG);
    expect(st.reads.some((r) => r.table === "invoices")).toBe(false);
  });

  it("a bills read that fails is reported and costs nothing: the estimates' copies are still dropped, and nothing throws", async () => {
    st.billsError = { message: "timeout" };
    await expect(bustLeadPdfs(LEAD, ORG)).resolves.toBeUndefined();
    expect(dropped()).toEqual([`quote:q-1@${ORG}`, `quote:q-2@${ORG}`]);
    expect(st.reported).toEqual(["bustBillsOfQuotes"]);
  });

  it("with no company known there is no fan-out over the bills (the service role is never unscoped by a form's id)", async () => {
    await bustBillsOfQuotes(["q-1"], null);
    expect(st.reads).toEqual([]);
  });
});

describe("the lead's two doors use it", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/actions.ts"), "utf8");
  it("the delete drops the bills of the estimates it read before the row went, after the delete landed", () => {
    const del = src.slice(src.indexOf("export async function deleteInquiry("));
    const refused = del.indexOf("if (!gone?.length)");
    const bills = del.indexOf("await bustBillsOfQuotes(((itsQuotes ?? []) as { id: string }[]).map((q) => q.id), ctx.orgId);");
    expect(bills).toBeGreaterThan(refused);
  });
  it("the edit's bustLeadPdfs carries the bills itself", () => {
    const cache = readFileSync(join(process.cwd(), "src/lib/pdf-cache.ts"), "utf8");
    const fn = cache.slice(cache.indexOf("export async function bustLeadPdfs("), cache.indexOf("export async function bustBillsOfQuotes("));
    expect(fn).toContain("await bustBillsOfQuotes(quoteIds, org);");
  });
});
