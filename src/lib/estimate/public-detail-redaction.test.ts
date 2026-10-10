import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHAT THE ANONYMOUS ESTIMATE PAGE IS HANDED (public_quote, 0386 → 0387). The breakdown behind a
 * task line may reach the customer only when the company's format prints it, and then only his
 * hours, the rate, the units and each part's name, count and sell — never the company's cost, the
 * task id, the kit id or a book code. The function body is the boundary, so the body is pinned.
 */
const body = readFileSync(join(process.cwd(), "supabase/migrations/0387_public_quote_detail_follows_the_format.sql"), "utf8");
const fn = body.slice(body.indexOf("create or replace function public.public_quote"));
const detailBranch = fn.slice(fn.indexOf("'detail', case"), fn.indexOf("else null end"));

describe("public_quote's detail (0387)", () => {
  it("rides only when the company's format is detailed", () => {
    expect(detailBranch).toContain("o.settings->'doc_style'->>'estimate_format'");
    expect(detailBranch).toContain("= 'detailed'");
  });

  it("carries hours, rate, units and the parts' name / qty / sell — nothing the company keeps to itself", () => {
    for (const key of ["'hours'", "'rate'", "'units'", "'materials'", "'name'", "'qty'", "'sell'"]) expect(detailBranch).toContain(key);
    for (const secret of ["'cost'", "'task_id'", "'kit_id'", "'code'", "'words'"]) expect(detailBranch).not.toContain(secret);
    expect(fn).not.toContain("'detail', li.detail"); // never the whole object
  });

  it("keeps the parts in their stored order", () => {
    expect(detailBranch).toContain("with ordinality");
    expect(detailBranch).toContain("order by ord");
  });
});
