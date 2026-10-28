import { describe, it, expect, vi } from "vitest";
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
  it("reads the line's old words, figure and breakdown BEFORE the write, and renames the job's task only through the guarded rule", () => {
    const was = fn.indexOf('select("description, quantity, unit_price, detail")'); // the figure too (cn-v1133): the syncs run only when it differs
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
    expect(status).toContain("createJobFromQuote(id, linked ? { sizeBefore: linked.sizeBefore, tasksBefore: linked.tasksBefore, partsBefore: linked.partsBefore } : undefined)");
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
    expect(branch).toContain("jobFollows(supabase, { jobId: q.job_id, sizeBefore, tasksBefore, partsBefore }, ctx)"); // the figure before: the caller's, or read before a revision's pin
    expect(branch).toContain("createWorkOrderFromQuote(quoteId)");
    expect(branch).toContain("createMaterialListFromQuote(quoteId)");
    // The paperwork FIRST (cn-v1084): the take-off may adopt a visit-born job's list and leave its task
    // parts to the materials sync, which must therefore run after it.
    expect(branch.indexOf("createMaterialListFromQuote(quoteId)")).toBeLessThan(branch.indexOf("jobFollows("));
    expect(branch).toContain("return { ok: true, id: q.job_id, ...(said ? { said } : {}), ...(note ? { note } : {}),"); // the paperwork's words + the superseded original (0391)
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
    expect(fn).toContain("syncWords(res, lead?.tasks)");
  });
  it("the estimate editor shows what the job's list did after a delete or a rename, and shows what it could not do as a note", () => {
    // The one editor (cn-v1132): the save model keeps the words per line (follow) and under the list
    // after a delete (said); the editor draws them beside the line. Driven in use-quote-writes.test.ts.
    const model = src("src/app/(app)/quotes/use-quote-writes.ts");
    expect(model).toContain("const words = { ...(res.said ? { said: res.said } : {}), ...(res.note ? { note: res.note } : {}) };");
    expect(model).toContain("said: res.said ?? (res.note ?? null),");
    const editor = src("src/app/(app)/quotes/estimate-editor.tsx");
    expect(editor).toContain('{follow?.said && <p className="mt-1 text-xs text-slate-500">{follow.said}</p>}');
    expect(editor).toContain('{follow?.note && <p className="mt-1 text-xs text-amber-700">{follow.note}</p>}');
    expect(editor).toContain('{state.said && <p className="mt-3 text-sm text-slate-500">{state.said}</p>}');
  });
  it("the rule's writes each select what they wrote", () => {
    const lines = src("src/lib/estimate/sync-job-tasks.ts").split("\n");
    const writes = lines.map((l, i) => (/\.(update|delete)\(/.test(l) ? i : -1)).filter((i) => i !== -1);
    expect(writes.length).toBe(7); // rekey, unkey, remove, redismiss, a task's minutes (0395), size, retitle (the insert is bornTasks'; the dismissal retitle is 0393's own RPC)
    for (const i of writes) expect(lines.slice(i, i + 7).join("\n"), `write at line ${i + 1}`).toContain('.select("id")');
    expect(lines.join("\n")).toContain("bornTasks(");
  });
  it("declining never runs the sync (deliberate: no churn, no photo loss on open tasks)", () => {
    const status = body(actions, "export async function updateQuoteStatus(");
    expect(status).toContain('if (status === "accepted") {\n    const jobId = (was'); // the figure is read only on the way to accepted
  });
  it("the size write is compare-and-set on the figure just read, and a lost race is his figure winning", () => {
    const rule = src("src/lib/estimate/sync-job-tasks.ts");
    expect(rule).toContain('uq = boxNow === null ? uq.is("planned_minutes", null) : uq.eq("planned_minutes", boxNow);');
    expect(rule).toContain("sizeStays: { box: boxNow, estimate: est.minutes }");
  });
  it("the orphan delete is conditional on open and unphotographed, and a re-key that loses to the customer's door is not a failure", () => {
    const rule = src("src/lib/estimate/sync-job-tasks.ts");
    expect(rule).toMatch(/\.delete\(\)[\s\S]{0,160}\.eq\("status", "open"\)[\s\S]{0,40}\.is\("photo_path", null\)/);
    expect(rule).toContain('(error as { code?: string }).code === "23505") {'); // a line orphan: the next pass cleans it up …
    expect(rule).toContain("if (title) twice.push(title);"); // … a visit's or hand task: on the list twice, SAID (cn-v1084)
  });
});

describe("a task he deleted by hand stays gone", () => {
  const fn = body(src("src/app/(app)/tasks/actions.ts"), "export async function deleteTask(");
  it("the delete door reads the task's key and dismisses it through the one atomic door (dismiss_task_key, 0393), answered; the sync reads that column", () => {
    expect(fn).toContain('select("id, job_id, created_by, source_key, title")');
    expect(fn).toContain('supabase.rpc("dismiss_task_key", { p_job_id: row.job_id, p_entry: entry })'); // "<key>#<title>" (cn-v1084): the title survives a rebuild
    expect(fn).toContain("dismissalEntry(key,");
    expect(fn).toContain('reportError("deleteTask:dismissKey"');
    const rule = src("src/lib/estimate/sync-job-tasks.ts");
    expect(rule).toContain('select("planned_minutes, dismissed_task_keys")');
    expect(rule).toContain("planLineSync(wanted, have, dismissed, others, shield)");
  });
});

describe("the buy list follows too (0390)", () => {
  it("jobFollows runs the tasks rule, then the materials rule, and says both", () => {
    const fn = body(actions, "async function jobFollows(");
    const tasks = fn.indexOf("syncJobTasks(");
    const mats = fn.indexOf("syncJobMaterials(");
    expect(tasks).toBeGreaterThan(-1);
    expect(mats).toBeGreaterThan(tasks);
    expect(fn).toContain("materialsWords(mats, lead?.materials)");
    expect(fn).toContain('reportError("jobFollowsEstimate:materials"');
    expect(fn).toContain('revalidatePath("/materials")');
  });
  it("the customer's own Accept link syncs the buy list after the take-off", () => {
    const finish = body(src("src/app/q/[token]/actions.ts"), "async function finishPublicAcceptance("); // internal since cn-v1133: acceptPublicQuote awaits it
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
    // cn-v1134: a row typed on site (no key of its own) rides under its capture id, so a second press lists nothing twice.
    expect(mats).toContain("source_key: i.source_key ?? (i.id ? `capture:${i.id}` : null),");
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

describe("the deferred items (cn-v1084)", () => {
  it("an estimate moved off a job: that job follows too, named, and the estimate's paperwork moves with it", () => {
    const fn = body(actions, "export async function setQuoteJob(");
    expect(fn).toContain('select("status, job_id")');
    expect(fn).toContain("if (accepted && from && from !== jobId) {");
    expect(fn).toContain("tasks: left.label ? `The job it left (${left.label}) follows too` : \"The job it left follows too\"");
    expect(fn).toContain('for (const [table, what] of [["work_orders", "work order"], ["material_lists", "materials list"]] as const)');
    expect(fn).toContain('.update({ job_id: jobId }).eq("quote_id", quoteId).select("id")');
    expect(fn).toContain('reportError("setQuoteJob:movePaperwork"');
    expect(fn).toContain("if (left) revalidatePath(`/jobs/${left.jobId}`);");
  });
  it("the take-off adopts the job's own list (no estimate holds it) instead of making a second, compare-and-set, and leaves its task parts to the sync", () => {
    const takeOff = src("src/lib/estimate/take-off-from-quote.ts");
    expect(takeOff).toContain('if (quote.job_id && status === "accepted") {'); // a draft never adopts
    expect(takeOff).toContain('.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle()'); // the canonical pick, as canonicalListIdForJob makes it
    expect(takeOff).toContain("if (canonical && (canonical.quote_id === null || fromOriginal)) {"); // or the list of the estimate it revises (0391)
    expect(takeOff).toContain('let tq = supabase.from("material_lists").update({ quote_id: quote.id }).eq("id", canonical.id);');
    expect(takeOff).toContain('tq = fromOriginal ? tq.eq("quote_id", canonical.quote_id as string) : tq.is("quote_id", null);'); // compare-and-set either way
    expect(takeOff).toContain('const { data: took, error: tErr } = await tq.select("id");');
    expect(takeOff).toContain('reportError("takeOffFromQuote:adopt"');
    expect(takeOff).toContain("if (adopted) continue;");
    // The Create Material List door runs the sync after an adoption, as the acceptance doors do.
    const door = body(src("src/app/(app)/materials/actions.ts"), "export async function createMaterialListFromQuote(");
    expect(door).toContain("if (res.adopted && res.jobId) {");
    expect(door).toContain("syncQuoteMaterials(supabase, { quoteId, jobId: res.jobId, orgId: null, userId: user.id })");
    expect(door).toContain('reportError("createMaterialListFromQuote:sync"');
  });
  it("the three plain kit pickers read through readTaskKits and say a failed read, each in the ops sink", () => {
    for (const [page, sink, extra] of [
      ["src/app/(app)/quotes/[id]/page.tsx", "quotes/[id]:kits", ""],
      ["src/app/(app)/billing/[id]/page.tsx", "billing/[id]:kits", ""],
      ["src/app/(app)/price-list/page.tsx", "price-list:kits", ', "category"'],
    ] as const) {
      const text = src(page);
      expect(text, page).toContain(`readTaskKits((sel) => supabase.from("kits").select(sel).order("name")${extra})`);
      expect(text, page).toContain(`reportError("${sink}"`);
      expect(text, page).toContain("plainKitsReadWords(");
      expect(text, page).toContain("Kits didn&apos;t load whole");
      expect(text, page).not.toContain("firstThatWorks(");
    }
    // Only where a picker is: a locked estimate and a non-draft invoice have none to be "off".
    expect(src("src/app/(app)/quotes/[id]/page.tsx")).toContain("const kitsNote = kitDoors && !lock ? plainKitsReadWords(kitsRead) : null;");
    expect(src("src/app/(app)/billing/[id]/page.tsx")).toContain("const kitsNote = kitDoors && isDraft ? plainKitsReadWords(kitsRead) : null;");
  });
  it("a visit's tasks and parts become the estimate's by the task id the line remembers; kept orphans are unkeyed", () => {
    const tasks = src("src/lib/estimate/sync-job-tasks.ts");
    expect(tasks).toContain("claim(t, (w) => !!w.task_id && `${VISIT_KEY}${w.task_id}` === t.source_key)");
    expect(tasks).toContain("tombstone: kept.map((t) => ({ id: t.id, source_key: `${GONE_KEY}${t.source_key}` }))");
    expect(tasks).toContain("for (const t of plan.tombstone) {");
    expect(tasks).toContain("const next = [...now.filter((e) => !consumed.has(e)), ...plan.redismiss.filter((e) => !now.includes(e))];"); // moved, never piled; re-read first
    const mats = src("src/lib/estimate/sync-job-materials.ts");
    expect(mats).toContain("p.taskId === t && partHalf(p.key) === partHalf(r.source_key)");
    expect(mats).toContain("tombstone: kept.map((r) => ({ id: r.id, source_key: `${GONE_KEY}${r.source_key}` }))");
    expect(mats).toContain("const hand: HandRow[] = all.filter((r) => {"); // unkeyed, not his, and not the estimate's own plain-line row (audit v1085)
    expect(mats).toContain("if (!isClaimableKey(r.source_key) || isHisRow(r)) return false;"); // a typed row's "capture:" key is no claim (cn-v1134)
    expect(mats).toContain("const next = [...now.filter((k) => !consumed.has(k)), ...plan.redismiss.filter((k) => !now.includes(k))];");
  });
});

/*
 * A TASK'S OWN MINUTES FOLLOW ITS LINE THROUGH THE REAL DOORS (0395; the skeptic's S5, cn-v1131).
 * jobBehindQuote, setQuoteJob, createJobFromQuote, updateQuoteStatus and the customer's own Accept
 * link each read the estimate's figure BEFORE their write and hand BOTH halves to the sync — the
 * whole (sizeBefore) and each task line's own (tasksBefore). Without the second a task holding the
 * figure its line said before could not follow a change of hours, and the sync said it "kept its
 * hours — set on the job" when nobody set anything. The case that reaches it: a REVISION accepted
 * over the original (the one door that changes an accepted line's hours), through the office's
 * status select and through the customer's link, against the thenable fake. The other sync callers
 * are mocked at their module seam; every read and write below is the real rule's.
 */
const ORG = "org-1";
const detail = (hours: number) => ({ task_id: "t-trench", labor: [{ label: null, person_id: null, hours, rate: 145, rate_from: "rule" }], units: null, kit_id: null, materials: [] });
const db = vi.hoisted(() => ({ current: null as any }));
const revisionAccepted = (over: { revisionStatus: "sent" | "accepted"; acceptedAt?: string | null }) =>
  fakeDb(
    {
    quotes: [
      { id: "q1", org_id: ORG, job_id: "j1", status: "accepted", quote_number: "E-001", revises_quote_id: null, created_at: "2026-10-01T10:00:00Z", accepted_at: "2026-10-01T12:00:00Z", customer_id: "c1", inquiry_id: null, public_token: "tok-1", created_by: "u1" },
      { id: "q2", org_id: ORG, job_id: "j1", status: over.revisionStatus, quote_number: "E-002", revises_quote_id: "q1", created_at: "2026-10-05T10:00:00Z", accepted_at: over.acceptedAt ?? null, customer_id: "c1", inquiry_id: null, public_token: "tok-2", created_by: "u1" },
    ],
    quote_line_items: [
      { id: "l1", org_id: ORG, quote_id: "q1", description: "Trench", sort_order: 0, detail: detail(2) }, // the original: 2 h
      { id: "l2", org_id: ORG, quote_id: "q2", description: "Trench", sort_order: 0, detail: detail(3) }, // the revision: 3 h
    ],
    // The task the original's acceptance gave birth to, still holding the original's 2 h.
    tasks: [{ id: "t1", org_id: ORG, job_id: "j1", source_key: "line:l1", title: "Trench", status: "open", notes: null, photo_path: null, parent_id: null, planned_minutes: 120 }],
    jobs: [{ id: "j1", org_id: ORG, planned_minutes: 120, dismissed_task_keys: [] }],
    appointments: [],
    },
    // The customer's door runs the RPC first (cn-v1133): the revision here is ALREADY accepted, so the SQL answers ok and the finish does the work.
    { rpc: (fn) => (fn === "accept_public_quote" ? { data: { ok: true }, error: null } : { data: null, error: { message: `no such function: ${fn}` } }) },
  );

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => db.current.sb), createServiceClient: vi.fn(() => db.current.sb) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: db.current.sb, userId: "u-office", orgId: ORG })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/push", async (importOriginal) => ({ ...(await importOriginal<object>()), orgStaffIds: vi.fn(async () => []), sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<object>()), createNotifications: vi.fn(async () => {}) }));
// The paperwork doors and the buy list are rules of their own, tested in their own files: here they answer ok and say nothing.
vi.mock("@/app/(app)/work-orders/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createWorkOrderFromQuote: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/materials/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createMaterialListFromQuote: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/estimate/sync-job-materials", async (importOriginal) => ({ ...(await importOriginal<object>()), syncJobMaterials: vi.fn(async () => ({})), materialsWords: () => null }));
vi.mock("@/lib/estimate/work-order-from-quote", async (importOriginal) => ({ ...(await importOriginal<object>()), workOrderFromQuote: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/estimate/take-off-from-quote", async (importOriginal) => ({ ...(await importOriginal<object>()), takeOffFromQuote: vi.fn(async () => ({ ok: true })), takeOffWords: () => null }));

const { fakeDb } = await import("@/test/fake-supabase");
const { updateQuoteStatus } = await import("@/app/(app)/quotes/actions");
const { acceptPublicQuote } = await import("@/app/q/[token]/actions");

describe("a task's minutes follow its line through the real doors (0395)", () => {
  it("the office accepts a revision: the task still holding the original's 2 h follows to the revision's 3 h, said as updated — never 'kept its hours'", async () => {
    db.current = revisionAccepted({ revisionStatus: "sent" });
    const res = await updateQuoteStatus("q2", "accepted");
    expect(res.ok).toBe(true);
    const said = String((res as { said?: string }).said ?? "");
    expect(said).toContain("1 matched");
    expect(said).toContain("1 task's hours updated");
    expect(said).toContain("the job's length is now 3 h");
    expect(said).not.toContain("kept its hours");
    const t = db.current.tables.tasks.find((r: any) => r.id === "t1");
    expect(t.planned_minutes).toBe(180);
    expect(t.source_key).toBe("line:l2"); // re-keyed to the revision's line by its exact title
    expect(db.current.tables.jobs[0].planned_minutes).toBe(180);
    expect(db.current.tables.quotes.find((q: any) => q.id === "q1").status).toBe("superseded");
  });

  it("the customer accepts the revision through the link: the same rule, the same figure before (the job's OTHER accepted estimates), the task follows", async () => {
    db.current = revisionAccepted({ revisionStatus: "accepted", acceptedAt: new Date().toISOString() });
    expect(await acceptPublicQuote("tok-2")).toEqual({ ok: true }); // the one server call: the RPC, then the finish AWAITED, then the bell
    const t = db.current.tables.tasks.find((r: any) => r.id === "t1");
    expect(t.planned_minutes).toBe(180);
    expect(t.source_key).toBe("line:l2");
    expect(db.current.tables.jobs[0].planned_minutes).toBe(180);
    expect(db.current.tables.quotes.find((q: any) => q.id === "q1").status).toBe("superseded");
  });

  it("every door hands the per-task figure through: jobBehindQuote, setQuoteJob (both jobs), createJobFromQuote, updateQuoteStatus, the link", () => {
    expect(actions).toContain("const figureBefore = (est: Awaited<ReturnType<typeof estimateLines>>): FigureBefore =>");
    expect(actions).toContain("est.error ? { sizeBefore: undefined, tasksBefore: undefined, partsBefore: undefined } : { sizeBefore: est.minutes, tasksBefore: est.taskMinutes, partsBefore: est.partCounts }");
    expect(actions).toContain("return { jobId, ...figureBefore(est) };"); // jobBehindQuote
    expect(actions).toContain("sizeBefore: who.sizeBefore, tasksBefore: who.tasksBefore"); // jobFollows → the tasks sync
    expect(actions).toContain("userId: ctx.userId, partsBefore: who.partsBefore"); // jobFollows → the materials sync (cn-v1133)
    expect(actions).toContain("pinned = figureBefore(est);");
    expect(actions).toContain("left = { jobId: from, ...figureBefore(est), label:");
    expect(actions).toContain("jobFollows(supabase, { jobId, ...pinned }, ctx)");
    expect(actions).toContain("jobFollows(supabase, { jobId: left.jobId, sizeBefore: left.sizeBefore, tasksBefore: left.tasksBefore, partsBefore: left.partsBefore }, ctx, {");
    expect(actions).toContain("({ sizeBefore, tasksBefore, partsBefore } = figureBefore(est));"); // a revision's pin inside createJobFromQuote
    expect(actions).toContain("linked = { jobId, ...figureBefore(est) };"); // updateQuoteStatus
    const link = src("src/app/q/[token]/actions.ts");
    expect(link).toContain("tasksBefore: before.error ? undefined : before.taskMinutes,");
    expect(link).toContain("partsBefore: before.error ? undefined : before.partCounts");
  });

  it("appending lines runs the same pair as a line edit (cn-v1133): the figure before the insert, the two rules after it", () => {
    const fn = body(actions, "export async function appendQuoteLines(");
    const before = fn.indexOf("jobBehindQuote(");
    const insert = fn.indexOf('.insert(rows).select("id")');
    const after = fn.indexOf("jobFollows(");
    expect(before).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(insert);
    expect(fn).toContain("return { ok: true, ids, ...follow };");
  });
});
