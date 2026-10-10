import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY DOOR THAT MAKES A JOB FROM HIS TASKS BIRTHS THEM THE SAME WAY (W3, cn-v1075).
 *
 * Three doors make a job: the office's accept (createJobFromQuote), the customer's own Accept link
 * (accept_public_quote in SQL, finished by finishPublicAcceptance) and Start The Job on a visit
 * (createJobFromAppointment). Each must call the ONE rule in lib/estimate/born-with-tasks, and the
 * two estimate doors must reach the one take-off and the one work order rule — so a job is the same
 * job whichever door it came through ([[two-doors-one-thing]]). These pins read the source: the
 * rules themselves are tested in their own files.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const body = (text: string, fn: string): string => {
  const at = text.indexOf(fn);
  expect(at, `${fn} not found`).toBeGreaterThan(-1);
  const next = text.indexOf("\nexport ", at + fn.length);
  return text.slice(at, next === -1 ? undefined : next);
};

describe("the office's accept", () => {
  const fn = body(src("src/app/(app)/quotes/actions.ts"), "export async function createJobFromQuote(");
  it("births the tasks after the job is made and before the paperwork", () => {
    const insert = fn.indexOf('from("jobs")');
    const born = fn.indexOf("bornWithTasks(");
    const paperwork = fn.indexOf("createWorkOrderFromQuote(");
    expect(insert).toBeGreaterThan(-1);
    expect(born).toBeGreaterThan(insert);
    expect(paperwork).toBeGreaterThan(born);
    expect(fn).toContain("createMaterialListFromQuote(");
  });
  it("says what could not be listed instead of swallowing it", () => {
    expect(fn).toContain('reportError("createJobFromQuote:tasks"');
    expect(fn).toMatch(/note/);
  });
});

describe("the customer's own Accept link", () => {
  const actions = src("src/app/q/[token]/actions.ts");
  const finish = body(actions, "export async function finishPublicAcceptance(");
  it("finishes the birth only on an accepted quote that already has its job, by token", () => {
    expect(finish).toContain('.eq("public_token", token)');
    expect(finish).toContain('q.status !== "accepted"');
    expect(finish).toContain("!q.job_id");
  });
  it("runs the same three rules the office's accept runs, with the company's id", () => {
    for (const rule of ["bornWithTasks(", "workOrderFromQuote(", "takeOffFromQuote("]) expect(finish).toContain(rule);
    expect(finish).toContain("orgId: who.orgId");
  });
  it("the page calls it after the RPC and before the office is pinged", () => {
    const page = src("src/app/q/[token]/accept.tsx");
    const accept = page.slice(page.indexOf("async function accept()"), page.indexOf("async function decline()"));
    const rpc = accept.indexOf('rpc("accept_public_quote"');
    const finishAt = accept.indexOf("finishPublicAcceptance(token)");
    const notify = accept.indexOf("notifyQuoteAccepted(token)");
    expect(rpc).toBeGreaterThan(-1);
    expect(finishAt).toBeGreaterThan(rpc);
    expect(notify).toBeGreaterThan(finishAt);
  });
});

describe("Start The Job on a visit", () => {
  const fn = body(src("src/app/(app)/appointments/actions.ts"), "export async function createJobFromAppointment(");
  it("reads the visit's tasks the way the estimate seed does and births them through the one rule", () => {
    expect(fn).toContain("tasksAnswered(");
    expect(fn).toContain("tasksFromVisit(");
    expect(fn).toContain("bornTasks(");
  });
  it("its parts join the typed take-off on the job's one list", () => {
    expect(fn).toContain("partsAsCaptureItems(");
    expect(fn).toMatch(/typedItems = \[\.\.\.\(parseInspectorCapture[\s\S]*taskParts\]/);
  });
  it("says what could not be listed", () => {
    expect(fn).toContain('reportError("createJobFromAppointment:tasks"');
    expect(fn).toContain("[absorbNote, tasksNote, materialsNote]");
  });
});

describe("the two paperwork rules live in lib, and the signed-in doors are thin", () => {
  it("the take-off reads the line's breakdown and never maps a task line to a row", () => {
    const rule = src("src/lib/estimate/take-off-from-quote.ts");
    expect(rule).toContain('.select("id, description, quantity, unit, unit_price, sort_order, detail")');
    expect(rule).toContain("coerceTaskDetail(it.detail)");
    // the task branch pushes rows for the parts and then `continue`s past the plain-line mapping
    expect(rule).toMatch(/if \(task\) \{[\s\S]*for \(const m of task\.materials\)[\s\S]*continue;\n\s*\}/);
  });
  it("materials/actions.ts no longer owns the take-off", () => {
    const door = src("src/app/(app)/materials/actions.ts");
    expect(door).toContain("takeOffFromQuote(supabase, { quoteId, userId: user.id, orgId: null })");
    expect(door).not.toContain('from("price_list_items")');
  });
  it("work-orders/actions.ts no longer owns the work order", () => {
    const door = src("src/app/(app)/work-orders/actions.ts");
    expect(door).toContain("workOrderFromQuote(ctx.supabase, { quoteId, userId: ctx.userId, orgId: ctx.orgId })");
    expect(door).not.toContain("Scope from ${quote.quote_number}");
  });
  it("every write the birth makes selects what it wrote (the silent-write law)", () => {
    const rule = src("src/lib/estimate/born-with-tasks.ts");
    expect(rule).toContain('.insert(rows).select("id")');
    expect(rule).toContain('.is("planned_minutes", null)');
    expect(rule).toMatch(/await q\.select\("id"\)/);
  });
});
