import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COST_CLAIM_CHUNK, costClaimFilter, readClaimsOnCosts } from "./claims-on-costs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function fakeSupabase(answer: (filter: string, filters: string[]) => { data?: unknown[]; error?: unknown }) {
  const calls: { filter: string; filters: string[] }[] = [];
  const q: any = {
    filter: "",
    filters: [] as string[],
    select() {
      return q;
    },
    or(f: string) {
      q.filter = f;
      return q;
    },
    neq(col: string, v: string) {
      q.filters.push(`${col}!=${v}`);
      return q;
    },
    async limit() {
      const call = { filter: q.filter, filters: [...q.filters] };
      calls.push(call);
      q.filter = "";
      q.filters = [];
      return answer(call.filter, call.filters);
    },
  };
  return { supabase: { from: () => q } as any, calls };
}

describe("a cost's claims are read by the cost, org-wide", () => {
  it("asks for both claim shapes: the source_ids overlap and the keyed import key", () => {
    expect(costClaimFilter([A, B])).toBe(`source_ids.ov.{${A},${B}},import_key.in.("bill:${A}","bill:${B}")`);
    expect(costClaimFilter([A], ["bill", "po"])).toBe(`source_ids.ov.{${A}},import_key.in.("bill:${A}","po:${A}")`);
    expect(costClaimFilter([A], [])).toBe(`source_ids.ov.{${A}}`);
  });

  it("skips void always, and drafts only when told", async () => {
    const { supabase, calls } = fakeSupabase(() => ({ data: [{ import_key: `bill:${A}`, source_ids: null, invoices: { status: "sent" } }] }));
    const held = await readClaimsOnCosts(supabase, [A], { drafts: true });
    expect(held.rows).toHaveLength(1);
    expect(calls[0].filters).toEqual(["invoices.status!=void"]);
    await readClaimsOnCosts(supabase, [A], { drafts: false });
    expect(calls[1].filters).toEqual(["invoices.status!=void", "invoices.status!=draft"]);
  });

  it("chunks a long list, dedupes ids, and hands back a failed chunk's error", async () => {
    const ids = Array.from({ length: COST_CLAIM_CHUNK + 5 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const { supabase, calls } = fakeSupabase(() => ({ data: [{ import_key: null, source_ids: [ids[0]], invoices: { status: "sent" } }] }));
    const r = await readClaimsOnCosts(supabase, [...ids, ids[0], ""], { drafts: true });
    expect(calls).toHaveLength(2);
    expect(r.rows).toHaveLength(2);
    expect(r.error).toBeNull();
    const failing = fakeSupabase((f) => (f.includes(ids[0]) ? { error: { message: "refused" } } : { data: [] }));
    const bad = await readClaimsOnCosts(failing.supabase, ids, { drafts: true });
    expect(bad.error).toEqual({ message: "refused" });
    expect(bad.rows).toEqual([]);
  });

  it("the three screens read through it and none scopes a claim to the job any more", () => {
    for (const f of ["../app/(app)/bills/page.tsx", "../app/(app)/inventory/page.tsx", "../app/(app)/bills/supplier-actions.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, f).toContain("readClaimsOnCosts(");
      expect(src, f).not.toContain('.in("invoices.job_id"');
    }
  });
});
