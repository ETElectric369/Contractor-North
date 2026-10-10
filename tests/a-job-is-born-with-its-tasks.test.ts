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
  it("finishes the birth only on an accepted quote that already has its job, by token, soon after the tap", () => {
    expect(finish).toContain('.eq("public_token", token)');
    expect(finish).toContain('q.status !== "accepted"');
    expect(finish).toContain("!q.job_id");
    expect(finish).toMatch(/new Date\(q\.accepted_at\)\.getTime\(\) > FINISH_WINDOW_MS/);
    expect(actions).toMatch(/export const FINISH_WINDOW_MS = 10 \* 60_000/);
  });
  it("runs the same three rules the office's accept runs, each with the company's id", () => {
    expect(finish).toMatch(/bornWithTasks\(sb, \{ jobId, quoteId: q\.id, orgId: who\.orgId, createdBy: who\.userId \}\)/);
    expect(finish).toMatch(/workOrderFromQuote\(sb, \{ quoteId: q\.id, orgId: who\.orgId, userId: who\.userId \}\)/);
    expect(finish).toMatch(/takeOffFromQuote\(sb, \{ quoteId: q\.id, orgId: who\.orgId, userId: who\.userId \}\)/);
  });
  it("rings the office LAST and ALWAYS, on the server, so a closed tab loses neither", () => {
    expect(finish).toMatch(/\} finally \{[\s\S]*await notifyQuoteAccepted\(token\);/);
    const page = src("src/app/q/[token]/accept.tsx");
    const accept = page.slice(page.indexOf("async function accept()"), page.indexOf("async function decline()"));
    const rpc = accept.indexOf('rpc("accept_public_quote"');
    const finishAt = accept.indexOf("finishPublicAcceptance(token)");
    expect(rpc).toBeGreaterThan(-1);
    expect(finishAt).toBeGreaterThan(rpc);
    expect(page).not.toContain("notifyQuoteAccepted"); // one call from the page, the chain is server-side
  });
});

describe("Start The Job on a visit", () => {
  const fn = body(src("src/app/(app)/appointments/actions.ts"), "export async function createJobFromAppointment(");
  it("reads the visit's tasks the way the estimate seed does and births them through the one rule", () => {
    expect(fn).toContain("tasksAnswered(");
    expect(fn).toContain("tasksFromVisit(");
    expect(fn).toContain("bornTasks(");
  });
  it("reads them BEFORE the job is sized, so the size, the drawn end and the segments agree (the skeptic's 20-hour job)", () => {
    const read = fn.indexOf("tasksAnswered(");
    const sized = fn.indexOf("const sized = ");
    const insert = fn.indexOf('from("jobs")');
    const born = fn.indexOf("bornTasks(");
    expect(read).toBeGreaterThan(-1);
    expect(sized).toBeGreaterThan(read);
    expect(insert).toBeGreaterThan(sized);
    expect(born).toBeGreaterThan(insert);
    expect(fn).toContain("planned_minutes ?? 0) || (visitBirth.plannedMinutes ?? 0)");
    expect(fn).toContain("const sizedDays = daysNeeded(sized)");
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

describe("what could not be listed is said, not sunk", () => {
  it("the office's accept turns the job's note into its warning", () => {
    const fn = body(src("src/app/(app)/quotes/actions.ts"), "export async function updateQuoteStatus(");
    expect(fn).toContain("else if (jobRes?.note) jobWarn = jobRes.note;");
  });
  it("the one list writer says 'how many?' for an uncounted row instead of a silent count of one", () => {
    const door = src("src/app/(app)/materials/actions.ts");
    const fn = door.slice(door.indexOf("export async function addCaptureItemsToJobList"), door.indexOf("export async function addMaterialItem("));
    expect(fn).toContain("description: i.quantity === null ? `${i.description}${HOW_MANY}` : i.description,");
  });
});

describe("the two paperwork rules live in lib, and the signed-in doors are thin", () => {
  it("the take-off reads the line's breakdown and never maps a task line to a row", () => {
    const rule = src("src/lib/estimate/take-off-from-quote.ts");
    expect(rule).toContain('.select("id, description, quantity, unit, unit_price, sort_order, detail")');
    expect(rule).toContain("coerceTaskDetail(it.detail)");
    // the task branch pushes rows for the parts and then `continue`s past the plain-line mapping,
    // and the labor test comes AFTER it (a task named "Labor …" is a task)
    expect(rule).toMatch(/if \(task\) \{[\s\S]*for \(const m of task\.materials\)[\s\S]*continue;\n\s*\}\n\s*if \(isLabor\(it\)\) continue;/);
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
