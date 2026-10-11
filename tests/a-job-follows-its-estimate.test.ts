import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A JOB FOLLOWS ITS ESTIMATE (the first of the four deferred items, 2026-10-10).
 *
 * An accepted estimate with a job stays editable, and an estimate already linked to a job can be
 * accepted again. Every door that changes what the job's tasks should be reaches the ONE rule in
 * lib/estimate/sync-job-tasks, reads the estimate's figure BEFORE its write (the size can only tell
 * "still the estimate's" from his that way), and says what the job's list did. These pins read the
 * source; the rule is tested in its own file.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const body = (text: string, fn: string): string => {
  const at = text.indexOf(fn);
  expect(at, `${fn} not found`).toBeGreaterThan(-1);
  const next = text.indexOf("\nexport ", at + fn.length);
  return text.slice(at, next === -1 ? undefined : next);
};
const actions = src("src/app/(app)/quotes/actions.ts");

describe("deleting a line on an accepted estimate", () => {
  const fn = body(actions, "export async function deleteQuoteItem(");
  it("reads the job and the estimate's figure BEFORE the delete (only for a TASK line), syncs AFTER it lands, and hands back what the list did", () => {
    const line = fn.indexOf('select("detail")');
    const before = fn.indexOf("jobBehindQuote(");
    const del = fn.indexOf(".delete()");
    const after = fn.indexOf("jobFollows(");
    expect(line).toBeGreaterThan(-1);
    expect(before).toBeGreaterThan(line);
    expect(fn).toContain("coerceTaskDetail(");
    expect(del).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(del);
    expect(fn).toContain("return { ok: true, ...follow }");
  });
});

describe("renaming a line on an accepted estimate", () => {
  const fn = body(actions, "export async function updateQuoteItem(");
  it("reads the line's old words and breakdown BEFORE the write, and renames the job's task only through the guarded rule", () => {
    const was = fn.indexOf('select("description, detail")');
    const write = fn.indexOf(".update(clean)");
    const retitle = fn.indexOf("retitleLineTask(");
    expect(was).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(was);
    expect(retitle).toBeGreaterThan(write);
    expect(fn).toContain("from: String(before.description ?? \"\")");
    expect(fn).toContain("coerceTaskDetail(before.detail)"); // only a TASK line has a task to rename
    expect(fn).toContain("jobOf("); // at ANY status: a rename during a walk-back must not be lost (the old-title guard protects his)
    expect(fn).not.toContain("acceptedJobOf(");
  });
});

describe("accepting an estimate that already has its job", () => {
  const status = body(actions, "export async function updateQuoteStatus(");
  const create = body(actions, "export async function createJobFromQuote(");
  it("reads the estimate's figure BEFORE the status write counts this estimate's lines, and hands it to Create Job", () => {
    const read = status.indexOf("estimateLines(");
    const write = status.indexOf(".update(patch)");
    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(read);
    expect(status).toContain("createJobFromQuote(id, linked ? { sizeBefore: linked.sizeBefore } : undefined)");
  });
  it("the news is said under the status, apart from a warning", () => {
    expect(status).toContain("if (jobRes?.said) said = jobRes.said;");
    expect(src("src/app/(app)/quotes/[id]/status-control.tsx")).toContain('if ("said" in res && res.said) setSaid(res.said);');
  });
  it("Create Job on a linked estimate catches the job up — the one rule, then the same two idempotent paperwork doors — instead of stopping", () => {
    const linked = create.indexOf("if (q.job_id) {");
    const birth = create.indexOf('from("jobs")');
    expect(linked).toBeGreaterThan(-1);
    const branch = create.slice(linked, birth);
    expect(branch).toContain('status !== "accepted") return { ok: true, id: q.job_id }'); // a sent/draft linked estimate: the old answer, no sync
    expect(create).toContain('.select("id, job_id, status,');
    expect(branch).toContain("jobFollows(supabase, { jobId: q.job_id, sizeBefore: opts?.sizeBefore }, ctx)");
    expect(branch).toContain("createWorkOrderFromQuote(quoteId)");
    expect(branch).toContain("createMaterialListFromQuote(quoteId)");
    expect(branch).toContain("return { ok: true, id: q.job_id, ...follow }");
    expect(create).not.toContain("if (q.job_id) return { ok: true, id: q.job_id };");
  });
});

describe("pinning an accepted estimate to a job", () => {
  const fn = body(actions, "export async function setQuoteJob(");
  it("reads the job's figure BEFORE the pin, syncs after it, and the pin itself is read back (silent-write law)", () => {
    const read = fn.indexOf("estimateLines(");
    const write = fn.indexOf(".update({ job_id: jobId");
    const after = fn.indexOf("jobFollows(");
    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(read);
    expect(after).toBeGreaterThan(write);
    expect(fn).toContain('.select("id")');
    expect(fn).toContain('"That estimate could not be found."');
    expect(fn).toContain('status === "accepted"'); // a draft pinned to a job births nothing yet
  });
});

describe("the one rule, and nothing silent", () => {
  it("every door goes through jobFollows, which reports a failure and revalidates the job and the schedule", () => {
    const fn = body(actions, "async function jobFollows(");
    expect(fn).toContain("syncJobTasks(");
    expect(fn).toContain('reportError("jobFollowsEstimate"');
    expect(fn).toContain("revalidatePath(`/jobs/${who.jobId}`)");
    expect(fn).toContain('revalidatePath("/schedule")');
    expect(fn).toContain("syncWords(res)");
  });
  it("the quote editor shows what the job's list did after a delete or a rename, and shows what it could not do as an error", () => {
    const editor = src("src/app/(app)/quotes/[id]/quote-items-editor.tsx");
    expect(editor).toContain("setSaid(res.said ?? null)");
    expect(editor).toContain("if (res.note) setError(res.note)");
    expect(editor).toContain("{said && !detailsOpen && ");
  });
  it("the rule's writes each select what they wrote", () => {
    const lines = src("src/lib/estimate/sync-job-tasks.ts").split("\n");
    const writes = lines.map((l, i) => (/\.(update|delete)\(/.test(l) ? i : -1)).filter((i) => i !== -1);
    expect(writes.length).toBe(4); // rekey, remove, size, retitle (the insert is bornTasks', pinned in its own file)
    for (const i of writes) expect(lines.slice(i, i + 7).join("\n"), `write at line ${i + 1}`).toContain('.select("id")');
    expect(lines.join("\n")).toContain("bornTasks(");
  });
  it("declining never runs the sync (deliberate: no churn, no photo loss on open tasks)", () => {
    const status = body(actions, "export async function updateQuoteStatus(");
    expect(status).toContain('if (status === "accepted") {\n    const { data: was }');
  });
  it("the size write is compare-and-set on the figure just read, and a lost race is his figure winning", () => {
    const rule = src("src/lib/estimate/sync-job-tasks.ts");
    expect(rule).toContain('uq = boxNow === null ? uq.is("planned_minutes", null) : uq.eq("planned_minutes", boxNow);');
    expect(rule).toContain("sizeStays: { box: boxNow, estimate: est.minutes }");
  });
  it("the orphan delete is conditional on open and unphotographed, and a re-key that loses to the customer's door is not a failure", () => {
    const rule = src("src/lib/estimate/sync-job-tasks.ts");
    expect(rule).toMatch(/\.delete\(\)[\s\S]{0,160}\.eq\("status", "open"\)[\s\S]{0,40}\.is\("photo_path", null\)/);
    expect(rule).toContain('(error as { code?: string }).code === "23505") continue;');
  });
});

describe("a task he deleted by hand stays gone", () => {
  const fn = body(src("src/app/(app)/tasks/actions.ts"), "export async function deleteTask(");
  it("the delete door reads the task's key and writes it to jobs.dismissed_task_keys, read back; the sync reads that column", () => {
    expect(fn).toContain('select("id, job_id, created_by, source_key")');
    expect(fn).toContain('select("dismissed_task_keys")');
    expect(fn).toContain("dismissed_task_keys: [...had, key]");
    expect(fn).toContain('reportError("deleteTask:dismissKey"');
    const rule = src("src/lib/estimate/sync-job-tasks.ts");
    expect(rule).toContain('select("planned_minutes, dismissed_task_keys")');
    expect(rule).toContain("planLineSync(wanted, have, dismissed)");
  });
});

describe("the buy list follows too (0390)", () => {
  it("jobFollows runs the tasks rule, then the materials rule, and says both", () => {
    const fn = body(actions, "async function jobFollows(");
    const tasks = fn.indexOf("syncJobTasks(");
    const mats = fn.indexOf("syncJobMaterials(");
    expect(tasks).toBeGreaterThan(-1);
    expect(mats).toBeGreaterThan(tasks);
    expect(fn).toContain("materialsWords(mats)");
    expect(fn).toContain('reportError("jobFollowsEstimate:materials"');
    expect(fn).toContain('revalidatePath("/materials")');
  });
  it("the customer's own Accept link syncs the buy list after the take-off", () => {
    const finish = body(src("src/app/q/[token]/actions.ts"), "export async function finishPublicAcceptance(");
    const takeOff = finish.indexOf("takeOffFromQuote(");
    const mats = finish.indexOf("syncJobMaterials(");
    expect(mats).toBeGreaterThan(takeOff);
    expect(finish).toContain('reportError("finishPublicAcceptance:materialsSync"');
  });
  it("a part he deletes by hand stays gone: the delete door reads the key first and dismisses it through the crew-safe door (0390)", () => {
    const fn = body(src("src/app/(app)/materials/actions.ts"), "export async function deleteMaterialItem(");
    const read = fn.indexOf('select("source_key")');
    const del = fn.indexOf(".delete()");
    expect(read).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(read);
    expect(fn).toContain('rpc("dismiss_material_key", { p_list_id: listId, p_key: key })');
    expect(fn).toContain('reportError("deleteMaterialItem:dismissKey"');
    const sql = src("supabase/migrations/0390_a_part_remembers_its_line.sql");
    expect(sql).toContain("create or replace function public.dismiss_material_key(p_list_id uuid, p_key text)");
    expect(sql).toContain("security definer");
    expect(sql).toContain("and (public.is_org_staff() or job_id is not null)");
    expect(sql).toContain("revoke execute on function public.dismiss_material_key(uuid, text) from public, anon;");
  });
  it("a visit's parts carry their key onto the list, through the one insert", () => {
    const born = src("src/lib/estimate/born-with-tasks.ts");
    expect(born).toContain("source_key: keys.get(p) ?? materialKey(p.source_key, p.code, p.name)"); // keyParts' ordinals, the same as the take-off
    const mats = src("src/app/(app)/materials/actions.ts");
    expect(mats).toContain("source_key: i.source_key ?? null");
    expect(mats).toContain("...(item.source_key ? { source_key: item.source_key } : {})");
  });
  it("the take-off and the sync write one row shape, from one book lookup", () => {
    const takeOff = src("src/lib/estimate/take-off-from-quote.ts");
    expect(takeOff).toContain("export function taskPartRow(");
    expect(takeOff).toContain("export async function readPriceBook(");
    expect(takeOff).toContain("keyParts(`line:${it.id}`, task.materials.filter((x) => x.name.trim()))"); // ordinals for repeats, the same helper the sync uses
    const sync = src("src/lib/estimate/sync-job-materials.ts");
    expect(sync).toContain("taskPartRow(listId, who.orgId,");
    expect(sync).toContain("readPriceBook(sb, who.orgId)");
    expect(sync).toContain('.eq("purchased", false).eq("is_tool", false), who.orgId).select("id")'); // the conditional, org-scoped remove
  });
});
