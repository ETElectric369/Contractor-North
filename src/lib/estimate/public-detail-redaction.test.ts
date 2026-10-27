import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHAT THE ANONYMOUS ESTIMATE PAGE IS HANDED (public_quote, 0386 → 0387 → 0395). The breakdown behind
 * a task line may reach the customer only when the format prints it — the estimate's own word, else
 * the company's — and then only his hours, the rate, the units, each labor row's label / hours / rate
 * and each part's name, count and sell. Never the company's cost, the task id, the kit id, a book
 * code or a person's id (a Team member's id is the company's). The function body is the boundary, so
 * the body is pinned, on the migration that holds it NOW.
 */
const body = readFileSync(join(process.cwd(), "supabase/migrations/0395_a_task_has_labor_rows.sql"), "utf8");
const fn = body.slice(body.indexOf("create or replace function public.public_quote"));
const detailBranch = fn.slice(fn.indexOf("'detail', case"), fn.indexOf("else null end"));
/** The SQL with its comments taken out: what the database runs, not what the header says about it. */
const code = fn.replace(/--[^\n]*/g, "");
/** Every KEY the detail branch builds: a quoted word in key position (followed by a comma), never a
 *  value read off a row (`->'hours'`) — so what ships is pinned by name, nested objects and all. */
const builtKeys = [...detailBranch.replace(/--[^\n]*/g, "").matchAll(/(?<!->)'([a-z_]+)'\s*,/g)].map((m) => m[1]);

describe("public_quote's detail (0395)", () => {
  it("rides only when the format is detailed: the estimate's own word, else the company's (the coalesce)", () => {
    expect(detailBranch).toContain("coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format'");
    expect(detailBranch).toContain("= 'detailed'");
  });

  it("ships the labor rows — label, hours, rate, in stored order — and never a person's id", () => {
    expect(detailBranch).toContain("'labor', coalesce((select jsonb_agg(jsonb_build_object(");
    expect(detailBranch).toContain("'label', l->'label', 'hours', l->'hours', 'rate', l->'rate'");
    expect(detailBranch).toContain("li.detail->'labor'");
    expect(builtKeys).toEqual(expect.arrayContaining(["labor", "label", "hours", "rate"]));
    expect(builtKeys).not.toContain("person_id");
    expect(detailBranch).not.toContain("person_id");
    expect(detailBranch).not.toContain("rate_from");
    expect(detailBranch).not.toContain("from_kit");
  });

  it("keeps hours, rate, units and the parts' name / qty / sell so an old line still reads — nothing the company keeps to itself", () => {
    for (const key of ["hours", "rate", "units", "materials", "name", "qty", "sell"]) expect(builtKeys).toContain(key);
    for (const secret of ["cost", "task_id", "kit_id", "code", "words", "person_id"]) expect(builtKeys).not.toContain(secret);
    expect(fn).not.toContain("'detail', li.detail"); // never the whole object
  });

  it("keeps the rows and the parts in their stored order", () => {
    expect(detailBranch.match(/with ordinality/g)).toHaveLength(2);
    expect(detailBranch.match(/order by ord/g)).toHaveLength(2);
  });

  it("the org projection is still the letterhead whitelist, never to_jsonb(o)", () => {
    expect(code).not.toContain("to_jsonb(o)");
    expect(code).toContain("'doc_style', o.settings->'doc_style'");
    expect(code).not.toContain("'settings', o.settings");
  });

  it("the columns the wave adds, and the grant the public door keeps", () => {
    expect(body).toContain("alter table public.quotes add column if not exists estimate_format text null check (estimate_format in ('tasks','detailed'));");
    expect(body).toContain("alter table public.tasks add column if not exists planned_minutes integer null;");
    expect(body).toContain("grant execute on function public.public_quote(text) to anon, authenticated;");
  });
});
