import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveFunctionBody } from "@/lib/migration-body.test-util";
import { ESTIMATE_FORMATS } from "@/lib/doc-style";

/**
 * WHAT THE ANONYMOUS ESTIMATE PAGE IS HANDED (public_quote, 0386 → 0387 → 0395 → 0408). The breakdown
 * behind a task line may reach the customer only when the format prints one — the estimate's own
 * word, else the company's — and then only what that format prints:
 *
 *   tasks     nothing.
 *   detailed  his hours, the rate, the units, each labor row's label / hours / rate and each part's
 *             name, count and sell.
 *   grouped   (0408) the same labor, NO part at all — the list is the literal empty list, no part's
 *             name, count or price is read — and one figure, the parts' total for one of the task.
 *
 * Never, under any format: the company's cost, the task id, the kit id, a book code, a person's id
 * (a Team member's id is the company's) or a person's name (a labor row ships the label he typed
 * and nothing about who; the function reads no table of people). The function body is the boundary,
 * so the body is pinned, on the migration that holds it NOW.
 */
const FILE = "0408_one_materials_line_under_each_task.sql";
const body = readFileSync(join(process.cwd(), "supabase/migrations", FILE), "utf8");
/** A function's text, from its header to the `$$;` that closes it (never the self-check after it). */
const fnOf = (header: string) => {
  const at = body.indexOf(header);
  return body.slice(at, body.indexOf("$$;", at) + 3);
};
const fn = fnOf("create or replace function public.public_quote");
const totalFn = fnOf("create or replace function public.task_parts_total");
/** The SQL with its comments taken out: what the database runs, not what the header says about it. */
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
const code = strip(fn);
const detailBranch = fn.slice(fn.indexOf("'detail', case"), fn.indexOf("else null end"));
const DETAILED = "when jsonb_typeof(li.detail) = 'object' and fmt.word = 'detailed'";
const GROUPED = "when jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'";
/** The two arms, each from its own `when` to the next (comments out). */
const detailedArm = strip(detailBranch.slice(detailBranch.indexOf(DETAILED), detailBranch.indexOf(GROUPED)));
const groupedArm = strip(detailBranch.slice(detailBranch.indexOf(GROUPED)));
/** Every KEY a piece of SQL builds: a quoted word in key position (followed by a comma), never a
 *  value read off a row (`->'hours'`) — so what ships is pinned by name, nested objects and all. */
const keysOf = (sql: string) => [...sql.matchAll(/(?<!->)(?<!->>)'([a-z_]+)'\s*,/g)].map((m) => m[1]);
/** Every field a piece of SQL READS off a breakdown (`li.detail`), a labor row (`l`) or a part (`m`):
 *  `x->'field'` or `x->>'field'`, the alias standing on its own (never the tail of another name). */
const readsOf = (sql: string) => [...sql.matchAll(/(?<![a-z_.])(li\.detail|l|m)->>?'([a-z_]+)'/g)].map((m) => `${m[1]}.${m[2]}`);
/** What the company keeps to itself, as it is stored on a breakdown (line-map TaskDetail). */
const SECRETS = ["cost", "code", "words", "task_id", "kit_id", "person_id", "rate_from", "from_kit", "hours_from_kit"];

describe("public_quote's detail (0408)", () => {
  it("is pinned on the migration that holds the body now", () => {
    const live = liveFunctionBody("public_quote");
    expect(live, "no migration creates public.public_quote").not.toBeNull();
    expect(live!.file, "a later migration re-creates public_quote: re-point this test at it, do not delete it").toBe(FILE);
    expect(fn.startsWith("create or replace function public.public_quote(p_token text)\nreturns json language sql stable security definer set search_path = public as $$")).toBe(true);
    expect(detailBranch.length).toBeGreaterThan(1000);
    expect(detailedArm.length).toBeGreaterThan(400);
    expect(groupedArm.length).toBeGreaterThan(400);
  });

  it("the format is the estimate's own word, else the company's (the coalesce), resolved once and one of three", () => {
    expect(code.split("coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format'").length - 1).toBe(1);
    // Resolved beside the estimate, never inside a line: the detail branch only reads the answer.
    expect(detailBranch).not.toContain("q.estimate_format");
    expect(detailBranch).not.toContain("settings");
    expect(code).toContain("case when said.word in ('tasks', 'detailed', 'grouped') then said.word else 'tasks' end as word");
    const known = [...code.match(/when said\.word in \(([^)]*)\)/)![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(known).toEqual([...ESTIMATE_FORMATS]);
    // The page is told which: the resolved word, and only the word, joins the quote object.
    expect(code).toContain("'estimate_format', fmt.word),");
    expect(code.indexOf("'estimate_format', fmt.word),")).toBeLessThan(code.indexOf("'items', coalesce("));
  });

  it("a breakdown rides only under 'detailed' or 'grouped': 'tasks', or a line that is no task, ships none", () => {
    const whens = [...strip(detailBranch).matchAll(/^\s*when ([^\n]+)$/gm)].map((m) => m[1]);
    expect(whens).toEqual(["jsonb_typeof(li.detail) = 'object' and fmt.word = 'detailed'", "jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'"]);
    expect(fn).toContain("        else null end) order by li.sort_order)");
    expect(code.split("else null end").length - 1).toBe(1);
    expect(fn).not.toContain("'detail', li.detail"); // never the whole object
    expect(code).not.toMatch(/to_jsonb\(li|row_to_json\(li|li\.\*/);
  });

  it("ships the labor rows — label, hours, rate, in stored order — in both arms, and never a person's id", () => {
    for (const arm of [detailedArm, groupedArm]) {
      expect(arm).toContain("'labor', coalesce((select jsonb_agg(jsonb_build_object(");
      expect(arm).toContain("'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)");
      expect(arm).toContain("li.detail->'labor'");
      expect(arm).toContain("with ordinality as lab(l, ord)), '[]'::jsonb)");
      expect(readsOf(arm).filter((r) => r.startsWith("l."))).toEqual(["l.label", "l.hours", "l.rate"]);
    }
    // Who did the work: not an id, not a name. The function reads no table of people.
    for (const who of ["person_id", "rate_from", "from_kit", "full_name", "profiles", "employees", "team", "auth."]) {
      expect(code, who).not.toContain(who);
    }
    const tables = [...code.matchAll(/\bfrom public\.([a-z_]+)/g)].map((m) => m[1]).sort();
    expect([...new Set(tables)]).toEqual(["customers", "inquiries", "jobs", "organizations", "quote_line_items", "quotes"]);
  });

  it("'detailed' keeps hours, rate, units and the parts' name / qty / sell so an old line still reads — nothing the company keeps to itself", () => {
    expect(keysOf(detailedArm)).toEqual(["hours", "rate", "units", "labor", "label", "hours", "rate", "materials", "name", "qty", "sell"]);
    expect(readsOf(detailedArm)).toEqual([
      "li.detail.hours",
      "li.detail.rate",
      "li.detail.units",
      "l.label",
      "l.hours",
      "l.rate",
      "li.detail.labor",
      "li.detail.labor",
      "m.name",
      "m.qty",
      "m.sell",
      "li.detail.materials",
      "li.detail.materials",
    ]);
  });

  it("'grouped' ships the same labor, the literal empty list for the parts, and one figure — no part's name, count or price is selected", () => {
    expect(keysOf(groupedArm)).toEqual(["hours", "rate", "units", "labor", "label", "hours", "rate", "materials", "materials_total"]);
    // The parts list is not read at all: it is written as the empty list.
    expect(groupedArm).toContain("'materials', '[]'::jsonb,");
    expect(groupedArm).not.toContain("li.detail->'materials'");
    expect(groupedArm).not.toMatch(/\bm->/);
    expect(groupedArm).not.toMatch(/'(name|qty|sell)'/);
    expect(readsOf(groupedArm)).toEqual(["li.detail.hours", "li.detail.rate", "li.detail.units", "l.label", "l.hours", "l.rate", "li.detail.labor", "li.detail.labor"]);
    // The one figure: the parts' total for one of the task, null when there is nothing priced.
    expect(groupedArm).toContain("'materials_total', nullif(public.task_parts_total(li.detail), 0))");
    expect(code.split("public.task_parts_total(").length - 1).toBe(1);
  });

  it("the one figure cannot carry a part out: task_parts_total answers a number, from names it only tests and figures it only multiplies", () => {
    expect(totalFn).toContain("create or replace function public.task_parts_total(p_detail jsonb)\nreturns numeric\n");
    const t = strip(totalFn);
    // It reads `name` to ask whether a part has one, and its count and price; nothing else of a part.
    expect([...new Set(readsOf(t))].sort()).toEqual(["m.name", "m.qty", "m.sell"]);
    expect([...t.matchAll(/p_detail->>?'([a-z_]+)'/g)].map((m) => m[1])).toEqual(["materials", "materials"]);
    for (const secret of SECRETS) expect(t, secret).not.toContain(`'${secret}'`);
    // The name is only ever inside a test (is it a string, is it blank), never in what is returned.
    expect(t.slice(t.indexOf("select"), t.indexOf("from jsonb_array_elements("))).not.toContain("name");
    expect(t).not.toMatch(/\bfrom public\./);
    // Not callable from outside the database: only public_quote, which runs as its owner, reaches it.
    expect(body).toContain("revoke all on function public.task_parts_total(jsonb) from public, anon, authenticated;");
  });

  it("no cost, code, task id, kit id or person's id is built or read, under any format", () => {
    const built = keysOf(code);
    for (const secret of SECRETS) {
      expect(built, secret).not.toContain(secret);
      expect(code, secret).not.toContain(`'${secret}'`);
    }
    // Everything the two arms build, by name — and the branch is nothing but the two arms.
    expect([...new Set(keysOf(detailedArm + groupedArm))].sort()).toEqual(["hours", "label", "labor", "materials", "materials_total", "name", "qty", "rate", "sell", "units"]);
    expect(strip(detailBranch).replace(/\s+/g, " ").trim()).toBe(`'detail', case ${(detailedArm + groupedArm).replace(/\s+/g, " ").trim()}`);
    // Nor is a breakdown read anywhere else in the function.
    expect(code.split("li.detail").length - 1).toBe((detailedArm + groupedArm).split("li.detail").length - 1);
  });

  it("keeps the rows and the parts in their stored order", () => {
    expect(detailedArm.match(/with ordinality/g)).toHaveLength(2);
    expect(detailedArm.match(/order by ord/g)).toHaveLength(2);
    expect(groupedArm.match(/with ordinality/g)).toHaveLength(1);
    expect(groupedArm.match(/order by ord/g)).toHaveLength(1);
  });

  it("the org projection is still the letterhead whitelist, never to_jsonb(o)", () => {
    expect(code).not.toContain("to_jsonb(o)");
    expect(code).toContain("'doc_style', o.settings->'doc_style'");
    expect(code).not.toContain("'settings', o.settings");
  });

  it("the word the column takes, and the grant the public door keeps", () => {
    // 0395 added the column with its two words (applied, immutable); 0408 swaps the check for three.
    const m0395 = readFileSync(join(process.cwd(), "supabase/migrations/0395_a_task_has_labor_rows.sql"), "utf8");
    expect(m0395).toContain("alter table public.quotes add column if not exists estimate_format text null check (estimate_format in ('tasks','detailed'));");
    expect(m0395).toContain("alter table public.tasks add column if not exists planned_minutes integer null;");
    expect(body).toContain("add constraint quotes_estimate_format_check check (estimate_format in ('tasks','detailed','grouped'));");
    expect(body).toContain("grant execute on function public.public_quote(text) to anon, authenticated;");
  });
});
