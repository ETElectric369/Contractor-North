import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, type Row } from "@/test/fake-supabase";

// WON · PICK THE JOB, driven through the REAL door on the recording fake (cn-v1134; the describe at the
// bottom). The same mocks the For box's test uses (tests/field-1014-for-name), plus the sink.
const s = vi.hoisted(() => ({ db: null as null | ReturnType<typeof import("@/test/fake-supabase").fakeDb>, sb: null as any }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: s.sb, userId: "u1", orgId: "o1", role: "owner" })),
  requireMember: vi.fn(async () => ({ supabase: s.sb, userId: "u1", orgId: "o1", role: "owner" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.sb), createServiceClient: vi.fn(() => s.sb) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({
  notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })),
  createNotifications: vi.fn(async () => true),
  officeRecipients: vi.fn(async () => []),
  ringOffice: vi.fn(async () => {}),
}));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}), errorMessage: (e: unknown) => String(e) }));
import { linkAppointmentTo } from "@/app/(app)/appointments/actions";

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
    // The paperwork AFTER the birth: the linked-estimate catch-up above the insert runs its own copy
    // (a-job-follows-its-estimate), so look past the birth, not for the first mention.
    const paperwork = fn.indexOf("createWorkOrderFromQuote(", born);
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
  const finish = body(actions, "async function finishPublicAcceptance("); // internal since cn-v1133: acceptPublicQuote awaits it
  it("finishes the birth only on an accepted quote that already has its job, by token, soon after the tap", () => {
    expect(finish).toContain('.eq("public_token", token)');
    expect(finish).toContain('q.status !== "accepted"');
    expect(finish).toContain("!q.job_id");
    expect(finish).toMatch(/new Date\(q\.accepted_at\)\.getTime\(\) > FINISH_WINDOW_MS/);
    // The window lives in lib: a "use server" file exports only async functions (the skeptic's catch, 2026-10-10).
    expect(actions).not.toMatch(/export const FINISH_WINDOW_MS/);
    expect(actions).toContain('import { FINISH_WINDOW_MS } from "@/lib/estimate/finish-window"');
    expect(src("src/lib/estimate/finish-window.ts")).toMatch(/export const FINISH_WINDOW_MS = 10 \* 60_000/);
  });
  it("runs the same three rules the office's accept runs, each with the company's id — the tasks through the one sync rule, sized by the job's OTHER estimates", () => {
    expect(finish).toMatch(/estimateLines\(sb, \{ jobId, orgId: who\.orgId, except: q\.id \}\)/);
    expect(finish).toMatch(/syncJobTasks\(sb, \{\s*jobId,\s*orgId: who\.orgId,\s*createdBy: who\.userId,[\s\S]{0,400}?sizeBefore: before\.error \? undefined : before\.minutes,\s*tasksBefore: before\.error \? undefined : before\.taskMinutes,\s*\}\)/); // whole and per task line (0395, cn-v1131)
    expect(finish).not.toContain("bornWithTasks(");
    expect(finish).toMatch(/workOrderFromQuote\(sb, \{ quoteId: q\.id, orgId: who\.orgId, userId: who\.userId \}\)/);
    expect(finish).toMatch(/takeOffFromQuote\(sb, \{ quoteId: q\.id, orgId: who\.orgId, userId: who\.userId \}\)/);
  });
  it("ONE server call (cn-v1133): the RPC, then the finish AWAITED, then the office rung LAST and ALWAYS — so a closed tab loses none of it", () => {
    const door = body(actions, "export async function acceptPublicQuote(");
    const rpc = door.indexOf('rpc("accept_public_quote", { p_token: token })');
    const finishAt = door.indexOf("await finishPublicAcceptance(token)");
    const bell = door.indexOf("await notifyQuoteAccepted(token, listSaid);");
    expect(rpc).toBeGreaterThan(-1);
    expect(finishAt).toBeGreaterThan(rpc);
    expect(bell).toBeGreaterThan(finishAt);
    expect(door).toContain("const supabase = await createClient();"); // the token page's own client (cookie-bound anon): the RPC is keyed by the token
    expect(finish).toContain("return listSaid;"); // the finish never rings: the door does, after it
    expect(finish).toContain("closeVisitsBehindQuote(sb, { id: q.id, inquiry_id:"); // parity with the office door: the visit behind the estimate is won
    expect(finish).toContain("revises_quote_id: (q.revises_quote_id as string | null) ?? null }, { jobId, outcome: \"won\", orgId: who.orgId })"); // the service client: the company's id scopes it (S6)
    const page = src("src/app/q/[token]/accept.tsx");
    const accept = page.slice(page.indexOf("async function accept()"), page.indexOf("async function decline()"));
    expect(accept).toContain("await acceptPublicQuote(token)");
    expect(accept).not.toContain('rpc("accept_public_quote"'); // the RPC runs on the server now
    expect(page).toContain('{busy === "accept" ? "Accepting…" : `Accept this ${lower}`}');
    expect(page).not.toContain("finishPublicAcceptance");
    expect(page).not.toContain("notifyQuoteAccepted"); // one call from the page, the chain is server-side
  });
});

describe("Start The Job on a visit", () => {
  const fn = body(src("src/app/(app)/appointments/actions.ts"), "export async function createJobFromAppointment(");
  // THE ONE VISIT READ (cn-v1134): what the visit typed is read by lib/appointments/visit-work for this
  // door and for Won · Pick The Job alike — the estimate seed's read of the sheet, the kits, the take-off.
  const rule = src("src/lib/appointments/visit-work.ts");
  it("reads the visit's tasks through the one visit read, the way the estimate seed does, and births them through the one rule", () => {
    expect(fn).toContain('const work = await visitWork(supabase, appointmentId, "job");');
    expect(rule).toContain("tasksAnswered(");
    expect(rule).toContain("tasksFromVisit(");
    expect(fn).toContain("bornTasks(");
  });
  it("reads them BEFORE the job is sized, so the size, the drawn end and the segments agree (the skeptic's 20-hour job)", () => {
    const read = fn.indexOf("visitWork(");
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
    expect(rule).toContain("partsAsCaptureItems(");
    expect(rule).toContain("typedItems: [...items, ...partsAsCaptureItems(birth.parts)]");
    expect(fn).toContain("const typedItems = work.typedItems;");
    expect(fn).toContain("await addCaptureItemsToJobList(job.id, typedItems)");
  });
  it("says what could not be listed, and what could not be read", () => {
    expect(rule).toContain('reportError("visit-work:tasks"');
    expect(rule).toContain('reportError("visit-work:capture"');
    expect(fn).toContain("[absorbNote, ...work.notes, tasksNote, materialsNote]");
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
    // and the labor test comes AFTER it (a task named "Labor …" is a task) — inside plainLineOf, the one
    // reading of a plain line the sync shares (cn-v1087), which answers null for a task or a labor line.
    // 0390: the parts are keyed as they are listed (keyParts, ordinals for repeats); the task itself still never becomes a row.
    expect(rule).toMatch(/if \(task\) \{[\s\S]*for \(const m of keyParts\(`line:\$\{it\.id\}`, task\.materials[\s\S]*continue;\n\s*\}\n\s*const plain = plainLineOf\(it, findPl\);[^\n]*\n\s*if \(!plain\) continue;/);
    expect(rule).toMatch(/export function plainLineOf\([\s\S]*if \(coerceTaskDetail\(line\.detail\)\) return null;[\s\S]*labor[\s\S]*return null;/);
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

/**
 * WON · PICK THE JOB CARRIES THE VISIT'S WORK (cn-v1134). The ending card's attach door
 * (linkAppointmentTo, kind "job") linked an existing job and stamped the win, and left the tasks and
 * the take-off typed on the visit where nothing on the job read them. Driven through the REAL door on
 * the recording fake: the tasks land keyed with their minutes, the parts are listed keyed, the job's
 * own size is untouched, a second press births nothing twice, a failed sheet read is said and the
 * link still lands, a re-link moves the link only.
 */
const PB = { needs: [{ key: "tasks", label: "Tasks", ask: "Tasks?", slot: { type: "tasks" } }] };
const ANSWERS = {
  tasks: [
    { id: "t1", name: "Set the sub panel", hours: 3, units: null, kit_id: null, materials: [{ code: "SP100", words: "100A sub panel", qty: 1 }] },
    { id: "t2", name: "Run the feeder", hours: 2.5, units: null, kit_id: null, materials: [{ code: null, words: "feeder wire", qty: null }] },
    { id: "t3", name: "Label the panel", hours: null, units: null, kit_id: null, materials: [] },
  ],
};
const CAPTURE = {
  items: [
    { id: "c-1", description: "12-2 NM-B", quantity: 200, unit: "ft" },
    { id: "c-2", description: "4-inch boxes", quantity: null, unit: "ea", code: "BX4" },
  ],
};
const visit = (): Row => ({
  id: "a1",
  org_id: "o1",
  type: "inspection",
  status: "completed",
  title: "Inspection: Larkspur",
  location: "12 Larkspur Ln",
  city: null,
  state: null,
  zip: null,
  customer_id: null,
  inquiry_id: null,
  job_id: null,
  outcome: null,
  capture: CAPTURE,
});
const tables = (): Record<string, Row[]> => ({
  appointments: [visit()],
  appointment_answers: [{ id: "a1", inspection_answers: ANSWERS, inspection_template_id: "form-1" }],
  form_playbooks: [{ id: "form-1", schema: null, playbook: PB }],
  jobs: [
    { id: "job-55", org_id: "o1", job_number: "J-055", name: "12 Larkspur Ln", address: "12 Larkspur Ln", city: null, state: null, zip: null, customer_id: "cust-1", planned_minutes: null, inquiry_id: null },
    { id: "job-40", org_id: "o1", job_number: "J-040", name: "9 Snowbell Ct", address: "9 Snowbell Ct", city: null, state: null, zip: null, customer_id: "cust-2", planned_minutes: 120, inquiry_id: null },
  ],
  profiles: [{ id: "u1", role: "owner", org_id: "o1", full_name: "Office" }],
  tasks: [],
  material_lists: [],
  material_list_items: [],
  inquiries: [],
  customers: [],
  kits: [],
});
/** 0393's index, material_items_list_source_key_uq: a second row with a key already on the list is refused. */
const onInsert = (table: string, rows: Row[]) => {
  if (table !== "material_list_items") return undefined;
  const have = new Set((s.db!.tables.material_list_items ?? []).map((r) => `${r.list_id}|${r.source_key}`));
  for (const r of rows) if (r.source_key && have.has(`${r.list_id}|${r.source_key}`)) return { code: "23505", message: 'duplicate key value violates unique constraint "material_items_list_source_key_uq"' };
  return undefined;
};
const withAuth = (sb: any) => ({ ...sb, auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } });
/** The fake's client with every read of one table answering an error (a refused sheet). */
const refusing = (sb: any, table: string, error: { code?: string; message: string }) => ({
  ...sb,
  from: (t: string) => {
    if (t !== table) return sb.from(t);
    const b: any = new Proxy({}, { get: (_t, k) => (k === "then" ? (res: (v: unknown) => void) => Promise.resolve({ data: null, error }).then(res) : () => b) });
    return b;
  },
});
const plant = (t: Record<string, Row[]> = tables()) => {
  s.db = fakeDb(t, { onInsert });
  s.sb = withAuth(s.db.sb);
};

describe("Won · Pick The Job carries the visit's work onto the job it links (cn-v1134)", () => {
  beforeEach(() => plant());

  it("the tasks land keyed task:<id> with their own minutes, the parts are listed keyed, the job's planned_minutes is untouched, and the note counts what joined", async () => {
    const res = await linkAppointmentTo("a1", "job", "job-55");
    expect(res.ok).toBe(true);
    expect(res.note).toBe("3 tasks and 4 parts joined J-055 (12 Larkspur Ln).");
    expect(res.warning).toBeUndefined();
    const v = s.db!.tables.appointments[0];
    expect([v.job_id, v.outcome, v.customer_id]).toEqual(["job-55", "won", "cust-1"]);
    expect(s.db!.tables.tasks.map((t) => [t.source_key, t.title, t.planned_minutes, t.job_id, t.org_id, t.created_by])).toEqual([
      ["task:t1", "Set the sub panel", 180, "job-55", "o1", "u1"],
      ["task:t2", "Run the feeder", 150, "job-55", "o1", "u1"],
      ["task:t3", "Label the panel", null, "job-55", "o1", "u1"],
    ]);
    // NEVER the job's own size: its tasks carry their minutes (bornTasks is handed plannedMinutes null).
    expect(s.db!.tables.jobs.find((j) => j.id === "job-55")!.planned_minutes).toBeNull();
    expect(s.db!.tables.material_lists.map((l) => l.job_id)).toEqual(["job-55"]);
    const items = s.db!.tables.material_list_items;
    expect(items.map((i) => i.source_key)).toEqual(["capture:c-1", "capture:c-2", expect.stringMatching(/^task:t1#/), expect.stringMatching(/^task:t2#/)]);
    expect(items.map((i) => [i.description, i.quantity, i.part_number])).toEqual([
      ["12-2 NM-B", 200, null],
      ["4-inch boxes · how many?", 1, "BX4"],
      ["100A sub panel", 1, "SP100"],
      ["feeder wire · how many?", 1, null],
    ]);
  });

  it("a second press births nothing twice, lists nothing twice, and says the job already had it", async () => {
    await linkAppointmentTo("a1", "job", "job-55");
    const again = await linkAppointmentTo("a1", "job", "job-55");
    expect(again.ok).toBe(true);
    expect(again.note).toBe("J-055 already had the tasks and parts from this visit.");
    expect(again.warning).toBeUndefined();
    expect(s.db!.tables.tasks).toHaveLength(3);
    expect(s.db!.tables.material_list_items).toHaveLength(4);
    expect(s.db!.tables.material_lists).toHaveLength(1);
    expect(s.db!.tables.jobs.find((j) => j.id === "job-55")!.planned_minutes).toBeNull();
  });

  it("a failed sheet read is said as a warning, the link still lands, and the typed take-off still joins", async () => {
    s.sb = refusing(s.sb, "form_playbooks", { code: "42501", message: "refused" });
    const res = await linkAppointmentTo("a1", "job", "job-55");
    expect(res.ok).toBe(true);
    expect(s.db!.tables.appointments[0].job_id).toBe("job-55");
    expect(res.warning).toBe("The visit is linked; its tasks could not be read. Add them on the job.");
    expect(res.note).toBe("2 parts joined J-055 (12 Larkspur Ln).");
    expect(s.db!.tables.tasks).toHaveLength(0);
    expect(s.db!.tables.material_list_items.map((i) => i.source_key)).toEqual(["capture:c-1", "capture:c-2"]);
  });

  it("a re-link moves the link only: the job it had keeps the work, nothing lands on the new job", async () => {
    Object.assign(s.db!.tables.appointments[0], { job_id: "job-40", outcome: "won" });
    const res = await linkAppointmentTo("a1", "job", "job-55");
    expect(res.ok).toBe(true);
    expect(res.note).toBe("J-040 kept the tasks and parts from this visit.");
    expect(s.db!.tables.appointments[0].job_id).toBe("job-55");
    expect(s.db!.tables.tasks).toHaveLength(0);
    expect(s.db!.tables.material_list_items).toHaveLength(0);
    expect(s.db!.tables.material_lists).toHaveLength(0);
  });

  it("nothing typed on the visit: the job is as it was, and the door says so", async () => {
    plant({ ...tables(), appointments: [{ ...visit(), capture: null }], appointment_answers: [] });
    const res = await linkAppointmentTo("a1", "job", "job-55");
    expect(res.ok).toBe(true);
    expect(res.note).toBe("Nothing was typed on the visit, so J-055 is as it was.");
    expect(res.warning).toBeUndefined();
    expect(s.db!.tables.tasks).toHaveLength(0);
    expect(s.db!.tables.material_lists).toHaveLength(0);
  });

  it("the job born from this visit's estimate already carries a task by its words (under the LINE's key, any case) and its part by code: neither is doubled, the rest joins AFTER the job's last task", async () => {
    plant({
      ...tables(),
      tasks: [{ id: "tk1", org_id: "o1", job_id: "job-55", title: "set the SUB panel ", source_key: "line:ln1", sort_order: 4, planned_minutes: 180 }],
      material_lists: [{ id: "ml1", org_id: "o1", job_id: "job-55", name: "J-055", created_at: "2026-10-20" }],
      material_list_items: [{ id: "mi1", list_id: "ml1", org_id: "o1", description: "100A sub panel", part_number: "SP100", quantity: 1, source_key: "line:ln1#SP100", sort_order: 0 }],
    });
    const res = await linkAppointmentTo("a1", "job", "job-55");
    expect(res.ok).toBe(true);
    expect(res.note).toBe("2 tasks and 3 parts joined J-055 (12 Larkspur Ln).");
    expect(res.warning).toBeUndefined();
    expect(s.db!.tables.tasks.map((t) => [t.source_key, t.title, t.sort_order])).toEqual([
      ["line:ln1", "set the SUB panel ", 4],
      ["task:t2", "Run the feeder", 6],
      ["task:t3", "Label the panel", 7],
    ]);
    expect(s.db!.tables.material_list_items.map((i) => [i.source_key, i.description])).toEqual([
      ["line:ln1#SP100", "100A sub panel"],
      ["capture:c-1", "12-2 NM-B"],
      ["capture:c-2", "4-inch boxes · how many?"],
      [expect.stringMatching(/^task:t2#/), "feeder wire · how many?"],
    ]);
    // Pressed again: nothing new, and the door says the job already had it.
    const again = await linkAppointmentTo("a1", "job", "job-55");
    expect(again.note).toBe("J-055 already had the tasks and parts from this visit.");
    expect(s.db!.tables.tasks).toHaveLength(3);
    expect(s.db!.tables.material_list_items).toHaveLength(4);
  });

  it("a second press never revives what the office deleted: a dismissed task key (jobs.dismissed_task_keys) and a dismissed part key (the list's dismissed_keys) are left off, and said", async () => {
    await linkAppointmentTo("a1", "job", "job-55");
    // The office deletes the first task and its part: each delete door writes the key to its list.
    s.db!.tables.tasks = s.db!.tables.tasks.filter((t) => t.source_key !== "task:t1");
    s.db!.tables.jobs.find((j) => j.id === "job-55")!.dismissed_task_keys = ["task:t1#Set the sub panel"];
    const part = s.db!.tables.material_list_items.find((i) => String(i.source_key).startsWith("task:t1#"))!;
    s.db!.tables.material_list_items = s.db!.tables.material_list_items.filter((i) => i !== part);
    s.db!.tables.material_lists[0].dismissed_keys = [part.source_key];
    const again = await linkAppointmentTo("a1", "job", "job-55");
    expect(again.ok).toBe(true);
    expect(again.note).toBe("J-055 already had the tasks and parts from this visit. 1 task and 1 part left off — deleted from the job before.");
    expect(again.warning).toBeUndefined();
    expect(s.db!.tables.tasks.map((t) => t.source_key)).toEqual(["task:t2", "task:t3"]);
    expect(s.db!.tables.material_list_items.map((i) => i.source_key)).toEqual(["capture:c-1", "capture:c-2", expect.stringMatching(/^task:t2#/)]);
    // Only the deleted ones left: the door says so without "already had".
    s.db!.tables.tasks = [];
    s.db!.tables.jobs.find((j) => j.id === "job-55")!.dismissed_task_keys = ["task:t1#Set the sub panel", "task:t2", "task:t3"];
    s.db!.tables.material_list_items = [];
    s.db!.tables.material_lists[0].dismissed_keys = [part.source_key, "capture:c-1", "capture:c-2", "task:t2#feeder-wire"];
    const third = await linkAppointmentTo("a1", "job", "job-55");
    expect(third.note).toBe("J-055 left off 3 tasks and 4 parts from this visit — deleted from the job before.");
    expect(s.db!.tables.tasks).toHaveLength(0);
    expect(s.db!.tables.material_list_items).toHaveLength(0);
  });

  it("a failed birth lists the typed rows alone — a task's parts with no task are parts of nothing — and says what could not be listed", async () => {
    s.db = fakeDb(tables(), {
      onInsert: (table, rows) => (table === "tasks" ? { code: "42501", message: "permission denied for table tasks" } : onInsert(table, rows)),
    });
    s.sb = withAuth(s.db.sb);
    const res = await linkAppointmentTo("a1", "job", "job-55");
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/^The visit is linked; its tasks and their parts could not be listed \(.+\)\. Add them on the job\.$/);
    expect(res.note).toBe("2 parts joined J-055 (12 Larkspur Ln).");
    expect(s.db!.tables.tasks).toHaveLength(0);
    expect(s.db!.tables.material_list_items.map((i) => i.source_key)).toEqual(["capture:c-1", "capture:c-2"]);
  });

  it("the ending card's picker says the door's sentence (the note as a success toast; a failure stays until read)", () => {
    const picker = src("src/app/(app)/appointments/[id]/link-picker.tsx");
    expect(picker).toContain('if (done.res.note) toast(done.res.note, "success");');
    expect(picker).toContain('if (done.res.warning) toast(done.res.warning, "info", undefined, { sticky: true });');
    expect(src("src/app/(app)/appointments/[id]/visit-ending.tsx")).toContain('openLabel="Won · Pick The Job"');
  });

  it("the one list writer keys a typed row on its capture id, so a second press lists nothing twice", () => {
    const door = src("src/app/(app)/materials/actions.ts");
    const fn = door.slice(door.indexOf("export async function addCaptureItemsToJobList"), door.indexOf("export async function addMaterialItem("));
    expect(fn).toContain("source_key: i.source_key ?? (i.id ? `capture:${i.id}` : null),");
    expect(fn).toContain("if (line.kept) kept += 1;");
  });
});
