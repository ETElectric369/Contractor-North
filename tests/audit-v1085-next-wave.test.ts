import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fakeDb, type Row } from "../src/test/fake-supabase";
import { takeOffFromQuote } from "../src/lib/estimate/take-off-from-quote";
import { syncQuoteMaterials } from "../src/lib/estimate/sync-job-materials";
import { NO_SHIELD, pendingShield, planLineSync, retitleDismissal, syncJobTasks, syncWords, type LineTask } from "../src/lib/estimate/sync-job-tasks";
import type { BornTask } from "../src/lib/estimate/born-with-tasks";
import { discountOverflow } from "../src/lib/invoice-math";
import { deleteCredit } from "../src/lib/billing/withdraw-credit";
import { expandTaskKit, taskFlags, type TaskKit } from "../src/lib/estimate/task-lines";
type TaskDetail = Parameters<typeof taskFlags>[0];

/**
 * THE NEXT WAVE after audit v1085's second verify round (Erik 2026-10-11: "go for the next wave"): the
 * findings that needed a migration (0393) or Erik's OK. Behavioural on the fake DB where the rule takes
 * the client it is given; a source pin where the door is a server action or a page. Names are stand-ins
 * ("Bayberry"), never a customer's.
 */
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const body = (t: string, fn: string): string => {
  const at = t.indexOf(fn);
  expect(at, `${fn} not found`).toBeGreaterThan(-1);
  const next = t.indexOf("\nexport ", at + fn.length);
  return t.slice(at, next === -1 ? undefined : next);
};
const ORG = "org-1";
const BOOK = [{ org_id: ORG, code: "STP", description: "Staples", supplier: "Northline Supply", buy_price: 4, unit: "box", archived: false, price_list_item_options: [] }];
const DUP = { code: "23505", message: 'duplicate key value violates unique constraint "material_items_list_source_key_uq"' };

describe("0393 — one row per part, a guarded Decline, a task dismissal door", () => {
  const sql = src("supabase/migrations/0393_one_row_per_part_a_guarded_decline_a_task_dismissal_door.sql");
  it("makes (list_id, source_key) UNIQUE where keyed and drops the 0390 twin", () => {
    expect(sql).toContain("create unique index if not exists material_items_list_source_key_uq");
    expect(sql).toContain("on public.material_list_items (list_id, source_key)");
    expect(sql).toContain("where source_key is not null;");
    expect(sql).toContain("drop index if exists public.material_items_list_source_key_idx;");
    expect(sql).toContain("indexname = 'material_items_list_source_key_uq' and indexdef like 'CREATE UNIQUE INDEX%'");
  });
  it("redefines decline_public_quote from the live 0089 body with the guarded flip and the re-read, and checks the catalog", () => {
    expect(sql).toContain("create or replace function public.decline_public_quote(p_token text)");
    expect(sql).toContain("if q.status = 'declined' then"); // 0089's idempotent answer, kept
    expect(sql).toContain("if q.status <> 'sent' then");
    expect(sql).toContain("update public.quotes set status = 'declined', declined_at = now() where id = q.id and status = 'sent';");
    expect(sql).toContain("if not found then");
    expect(sql).toContain("select * into q from public.quotes where id = q.id;");
    expect(sql).toContain("pg_get_functiondef('public.decline_public_quote(text)'::regprocedure)");
    expect(sql).not.toContain("grant execute on function public.decline_public_quote"); // replace keeps the grants
  });
  it("dismiss_task_key: this company's job, atomic, guarded on the KEY half, idempotent, not for anon", () => {
    expect(sql).toContain("create or replace function public.dismiss_task_key(p_job_id uuid, p_entry text)");
    expect(sql).toContain("k := split_part(p_entry, '#', 1);");
    expect(sql).toContain("set dismissed_task_keys = array_append(dismissed_task_keys, p_entry)");
    expect(sql).toContain("and org_id = public.auth_org_id()");
    expect(sql).toContain("where e = k or left(e, length(k) + 1) = k || '#'");
    expect(sql).toContain("revoke execute on function public.dismiss_task_key(uuid, text) from public, anon;");
    expect(sql).toContain("or length(p_entry) > 400 then"); // the door is open to the company: an entry is a key and a title, nothing longer
  });
  it("retitle_task_dismissal moves one entry in ONE statement (array_replace), staff only, this company's job", () => {
    expect(sql).toContain("create or replace function public.retitle_task_dismissal(p_job_id uuid, p_key text, p_from text, p_to text)");
    expect(sql).toContain("set dismissed_task_keys = array_replace(dismissed_task_keys, p_key || '#' || btrim(p_from), p_key || '#' || btrim(p_to))");
    expect(sql).toContain("and public.is_org_staff()");
    expect(sql).toContain("and (p_key || '#' || btrim(p_from)) = any(dismissed_task_keys);");
    expect(sql).toContain("revoke execute on function public.retitle_task_dismissal(uuid, text, text, text) from public, anon;");
    expect(sql).toContain("raise exception '0393: retitle_task_dismissal is missing';");
  });
});

describe("[11]/[24] two doors in the same second: a refused keyed batch writes only the keys the list does not hold", () => {
  const line = (quote_id: string, id: string, description: string, quantity: number): Row => ({ id, quote_id, org_id: ORG, description, quantity, unit: "ea", unit_price: 10, sort_order: 0, detail: null });
  const taskLine = (quote_id: string, id: string): Row => ({
    id, quote_id, org_id: ORG, description: "Set the switch", quantity: 1, unit: "ea", unit_price: 500, sort_order: 0,
    detail: { task_id: "t1", hours: 2, rate: 100, units: null, kit_id: null, materials: [{ code: "STP", name: "Staples", qty: 2, cost: 4, sell: 5 }, { code: null, name: "Bayberry clips", qty: 4, cost: null, sell: null }] },
  });
  const quote = (id: string, status: string, extra: Record<string, unknown> = {}): Row => ({ id, quote_number: id.toUpperCase(), job_id: "job-1", status, org_id: ORG, revises_quote_id: null, title: "Deck", customer_id: null, ...extra });
  const world = (t: Record<string, Row[]>, opts: Parameters<typeof fakeDb>[1] = {}) =>
    fakeDb({ material_lists: [], material_list_items: [], work_orders: [], quote_line_items: [], price_list_items: BOOK, organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }], customers: [], kits: [], ...t }, opts);
  /** The other door wrote the STP part between this door's read and its write: the FIRST keyed batch is refused and
   *  the winner's row planted (into the live table, as the database would hold it); the next write lands. */
  const otherDoorWroteStp = (live: { tables?: Record<string, Row[]> }) => {
    let refused = false;
    return (table: string, rows: Row[]) => {
      if (table !== "material_list_items" || refused || !rows.some((r) => r.source_key)) return undefined;
      refused = true;
      const listId = rows[0].list_id as string;
      live.tables!.material_list_items.push({ id: "winner", list_id: listId, org_id: ORG, source_key: "line:l1#STP", description: "Staples", part_number: "STP", quantity: 2, purchased: false, is_tool: false, sort_order: 0 });
      return DUP;
    };
  };

  it("the take-off on a FRESH list keeps its plain rows (their own write) and adds only the task part the other door did not", async () => {
    const live: { tables?: Record<string, Row[]> } = {};
    const db = world({ quotes: [quote("q1", "accepted")], quote_line_items: [line("q1", "p1", "Staples [STP]", 3), taskLine("q1", "l1")] }, { onInsert: otherDoorWroteStp(live) });
    live.tables = db.tables;
    const res = await takeOffFromQuote(db.sb, { quoteId: "q1", userId: "u", orgId: null });
    expect(res).toMatchObject({ ok: true, jobId: "job-1" });
    const got = db.tables.material_list_items.map((r) => [r.description, r.source_key ?? null]);
    expect(got).toContainEqual(["Staples", null]); // the plain line's row: never lost to the keyed batch's refusal
    expect(got).toContainEqual(["Staples", "line:l1#STP"]); // the other door's
    expect(got).toContainEqual(["Bayberry clips", "line:l1#bayberry-clips"]); // the missing key, written once
    expect(got.filter(([, k]) => k === "line:l1#STP")).toHaveLength(1);
  });
  it("the sync adds the part the other door did not, and says so by its count — never 'the other door wrote all of them'", async () => {
    const live: { tables?: Record<string, Row[]> } = {};
    const db = world({
      quotes: [quote("q1", "accepted")],
      material_lists: [{ id: "ml", quote_id: "q1", job_id: "job-1", org_id: ORG, created_at: "2026-10-01", dismissed_keys: [] }],
      quote_line_items: [taskLine("q1", "l1")],
    }, { onInsert: otherDoorWroteStp(live) });
    live.tables = db.tables;
    const res = await syncQuoteMaterials(db.sb, { quoteId: "q1", jobId: "job-1", orgId: null, userId: "u" });
    expect(res).toMatchObject({ inserted: 1, rekeyed: 0, removed: 0, kept: 0 });
    expect(res.error).toBeUndefined();
    expect(db.tables.material_list_items.map((r) => r.source_key).sort()).toEqual(["line:l1#STP", "line:l1#bayberry-clips"]);
  });
  it("any other refusal of the keyed batch is an error, said", async () => {
    const db = world({ quotes: [quote("q1", "accepted")], quote_line_items: [taskLine("q1", "l1")] }, { onInsert: (t, rows) => (t === "material_list_items" && rows.some((r) => r.source_key) ? { message: "timeout" } : undefined) });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q1", userId: "u", orgId: null });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("the task parts didn't save");
  });
  it("a visit's row already listed answers with the row that is there", () => {
    const fn = body(src("src/app/(app)/materials/actions.ts"), "async function insertMaterialLine(");
    expect(fn).toContain("if (error && item.source_key && isDuplicateKey(error)) {");
    expect(fn).toContain('.eq("list_id", listId).eq("source_key", item.source_key).maybeSingle();');
  });
});

describe("[8] a discount never takes the bill below $0 — from the positive side too", () => {
  it("the overflow rule: only a bill with a discount, only when the net is negative, one action", () => {
    expect(discountOverflow([{ line_kind: "labor", line_total: 100 }, { line_kind: "discount", line_total: -165 }])).toBe("That would take the bill below $0 — lower the discount first.");
    expect(discountOverflow([{ line_kind: "labor", line_total: 200 }, { line_kind: "discount", line_total: -165 }])).toBeNull();
    expect(discountOverflow([{ line_kind: "discount", line_total: -165 }])).toBe("That would take the bill below $0 — lower the discount first.");
    expect(discountOverflow([{ line_kind: "labor", line_total: 100 }, { line_kind: "other", line_total: -165 }])).toBeNull(); // no discount on it: another rule's business
    expect(discountOverflow([])).toBeNull();
  });
  it("the edit door judges the whole bill with the shrunk line in it; the delete door judges the bill without the line", () => {
    const actions = src("src/app/(app)/billing/actions.ts");
    const upd = body(actions, "export async function updateInvoiceItem(");
    expect(upd).toContain("} else if (was) {");
    expect(upd).toContain("const overflow = discountOverflow([...((others ?? []) as Array<{ line_kind?: string | null; line_total?: unknown }>), { line_kind: was.line_kind ?? null, line_total: qty * price }]);");
    expect(upd).toContain("if (overflow) return { ok: false, error: overflow };");
    const del = body(actions, "export async function deleteInvoiceItem(");
    expect(del).toContain('.select("id, line_kind, line_total").eq("invoice_id", invoiceId).neq("id", itemId);');
    expect(del).toContain("if (restErr) return { ok: false, error: dbError(restErr) };");
    expect(del.indexOf("if (overflow) return { ok: false, error: overflow };")).toBeLessThan(del.indexOf(".delete()"));
  });
});

describe("[13]/[32] Delete This Credit only where it can act", () => {
  it("deleteCredit's refusal on a credit still on an invoice names ONE action, on the invoice it sits on", async () => {
    const db = fakeDb({ customer_credits: [{ id: "cr-1", amount: 165, disposition: "credit", status: "open", invoice_id: "inv-1", stripe_refund_id: null }] });
    expect(await deleteCredit(db.sb, "cr-1")).toEqual({ ok: false, error: "That credit is on an invoice — open that invoice and press Take It Back." });
    expect(db.tables.customer_credits).toHaveLength(1);
  });
  it("the list says where each credit is (this invoice / the account / another invoice by number) and the card draws Delete only on the account", () => {
    const fn = body(src("src/app/(app)/billing/actions.ts"), "export async function listCustomerCreditsForInvoice(");
    expect(fn).toContain("onAccount: c.invoice_id == null,");
    expect(fn).toContain('onInvoice: c.invoice_id && c.invoice_id !== invoiceId ? (numbers.get(c.invoice_id) ?? "another invoice") : null,');
    expect(fn).toContain('.select("id, invoice_number").in("id", elsewhere)');
    const button = src("src/app/(app)/billing/[id]/credit-button.tsx");
    expect(button).toContain('{c.disposition === "credit" && c.onAccount && (');
    expect(button).not.toContain('{c.disposition === "credit" && !c.onThisInvoice && (');
    expect(button).toContain("? `on ${c.onInvoice}`");
    // Apply stays for a credit on another invoice: it MOVES the credit here (off a voided bill too — the only door that one has).
    expect(button).toContain("act(() => applyCustomerCredit(c.id, invoiceId))");
    expect(body(src("src/app/(app)/billing/actions.ts"), "export async function listCustomerCreditsForInvoice(")).toContain('if (invErr) reportError("listCustomerCreditsForInvoice:numbers", invErr, { invoiceId });');
    // The list and the page are re-read on EVERY outcome: a refusal can land after a move (Take It Back's credit is on the account, the bill did not recompute).
    expect(button).toContain('if (!res.ok) setError(res.error ?? "Could not save.");\n      else if (res.message) setSaid(res.message);\n      await loadCredits();');
  });
});

describe("[17] a linked-but-unaccepted estimate's tasks are shielded", () => {
  const wanted = (over: Partial<BornTask> & { source_key: string }): BornTask => ({ title: "Trench", sort_order: 0, ...over });
  const have = (over: Partial<LineTask> & { id: string }): LineTask => ({ source_key: `line:${over.id}`, title: "Trench", status: "open", notes: null, photo_path: null, ...over });
  it("the plan leaves an orphan alone when a pending estimate's line holds its key or its exact title: not removed, not tombstoned, SAID — and a claim by title still runs first", () => {
    const shield = { keys: new Set(["line:a1"]), titles: new Set(["Panel", "Permit"]) };
    const plan = planLineSync(
      [wanted({ source_key: "line:m1", title: "Meter" }), wanted({ source_key: "line:p2", title: "Permit", sort_order: 1 })],
      [have({ id: "a1" }), have({ id: "a2-old", title: "Panel", status: "done" }), have({ id: "x", title: "Old scope" }), have({ id: "p1", title: "Permit" })],
      new Set(),
      [],
      shield,
    );
    expect(plan.remove).toEqual(["x"]); // the bare orphan nobody shields still goes
    expect(plan.kept).toEqual([]);
    expect(plan.tombstone).toEqual([]);
    expect(plan.rekey).toEqual([{ id: "p1", source_key: "line:p2" }]); // the accepted set wants Permit again: the shielded orphan is the line's, never a second copy
    expect(plan.leftAlone).toEqual(["Trench", "Panel"]);
    expect(plan.insert.map((t) => t.source_key)).toEqual(["line:m1"]);
    expect(planLineSync([], [have({ id: "a1" })], new Set(), [], NO_SHIELD)).toMatchObject({ remove: ["a1"], leftAlone: [] });
  });
  const taskLine = (id: string, quote_id: string, description: string, sort_order: number): Row => ({ id, quote_id, description, sort_order, detail: { task_id: `t-${id}`, hours: 1, rate: 100, units: null, kit_id: null, materials: [] } });
  const task = (over: Record<string, unknown>) => ({ job_id: "j1", status: "open", notes: null, photo_path: null, parent_id: null, ...over });
  it("walk A back to Draft (lines re-id'd), accept B: A's open Trench and done Panel stay; accept A again: both re-keyed, nothing born twice", async () => {
    const db = fakeDb({
      quotes: [
        { id: "A", job_id: "j1", status: "draft", created_at: "2026-10-01", accepted_at: null },
        { id: "B", job_id: "j1", status: "accepted", created_at: "2026-10-02", accepted_at: "2026-10-02" },
      ],
      quote_line_items: [taskLine("a1n", "A", "Trench", 0), taskLine("a2n", "A", "Panel", 1), taskLine("b1", "B", "Meter", 0)],
      tasks: [task({ id: "t1", source_key: "line:a1", title: "Trench" }), task({ id: "t2", source_key: "line:a2", title: "Panel", status: "done" })],
      jobs: [{ id: "j1", planned_minutes: null, dismissed_task_keys: [] }],
    });
    const first = await syncJobTasks(db.sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(first).toMatchObject({ inserted: 1, removed: 0, kept: 0, keptNames: [], rekeyed: 0, leftAlone: ["Trench", "Panel"] });
    expect(syncWords(first)).toBe("The job's list follows the estimate: 1 task added · 2 left alone (Trench, Panel) — an estimate not yet accepted still has them.");
    expect(db.tables.tasks.map((t) => [t.id, t.source_key, t.status ?? "open"])).toEqual([["t1", "line:a1", "open"], ["t2", "line:a2", "done"], ["tasks-1", "line:b1", "open"]]);
    db.tables.quotes[0].status = "accepted";
    db.tables.quotes[0].accepted_at = "2026-10-03";
    const again = await syncJobTasks(db.sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(again).toMatchObject({ inserted: 0, rekeyed: 2, removed: 0 });
    expect(again.leftAlone).toBeUndefined();
    expect(db.tables.tasks.map((t) => [t.id, t.source_key])).toEqual([["t1", "line:a1n"], ["t2", "line:a2n"], ["tasks-1", "line:b1"]]);
  });
  it("the shield reads draft and sent estimates of the job only, and a failed read refuses the sync (fail closed)", async () => {
    const ok = fakeDb({
      quotes: [{ id: "A", job_id: "j1", status: "sent" }, { id: "D", job_id: "j1", status: "declined" }, { id: "S", job_id: "j1", status: "superseded" }],
      quote_line_items: [taskLine("a1", "A", "Trench", 0), taskLine("d1", "D", "Gone", 0), taskLine("s1", "S", "Old", 0)],
    });
    const shield = await pendingShield(ok.sb, { jobId: "j1", orgId: null });
    expect([...shield.keys]).toEqual(["line:a1"]);
    expect([...shield.titles]).toEqual(["Trench"]);
    const broken = fakeDb({ quotes: [{ id: "A", job_id: "j1", status: "draft" }], quote_line_items: [] });
    const realFrom = broken.sb.from;
    broken.sb.from = (table: string) => {
      if (table !== "quote_line_items") return realFrom(table);
      return { select: () => ({ in: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "timeout" } }), then: (r: (v: unknown) => void) => r({ data: null, error: { message: "timeout" } }) }) }) } as any;
    };
    const res = await syncJobTasks(broken.sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res.error).toBeTruthy();
    expect(res.inserted).toBe(0);
  });
});

describe("[18] a visit task's dismissal bars the line built from it, whatever the title; a rename moves a dismissal", () => {
  const wanted = (over: Partial<BornTask> & { source_key: string }): BornTask => ({ title: "Trench", sort_order: 0, ...over });
  it("dismissed task:T1 bars wanted line:L (task_id T1, title changed by the units box): left off, said, the dismissal MOVED", () => {
    const plan = planLineSync([wanted({ source_key: "line:L", title: "Footings ×9", task_id: "T1" })], [], new Set(["task:T1#Footings ×7"]));
    expect(plan.insert).toEqual([]);
    expect(plan.leftOff).toEqual(["Footings ×9"]);
    expect(plan.consumed).toEqual(["task:T1#Footings ×7"]);
    expect(plan.redismiss).toEqual(["line:L#Footings ×9"]);
    // Another task's id, same title drift: not barred.
    expect(planLineSync([wanted({ source_key: "line:L", title: "Footings ×9", task_id: "T2" })], [], new Set(["task:T1#Footings ×7"])).insert).toHaveLength(1);
  });
  it("retitleDismissal goes through the atomic door (retitle_task_dismissal, 0393) with the line's key and both titles; a no-op rename never calls it", async () => {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const db = fakeDb({}, { rpc: (fn, args) => (calls.push({ fn, args }), { data: true, error: null }) });
    expect(await retitleDismissal(db.sb, { jobId: "j1", lineId: "L", from: "Trench", to: "Trench ×2" })).toEqual({ moved: true });
    expect(calls).toEqual([{ fn: "retitle_task_dismissal", args: { p_job_id: "j1", p_key: "line:L", p_from: "Trench", p_to: "Trench ×2" } }]);
    expect(await retitleDismissal(db.sb, { jobId: "j1", lineId: "L", from: "Same", to: "Same" })).toEqual({ moved: false });
    expect(calls).toHaveLength(1);
    const none = fakeDb({}, { rpc: () => ({ data: false, error: null }) });
    expect(await retitleDismissal(none.sb, { jobId: "j1", lineId: "L", from: "Nothing", to: "Else" })).toEqual({ moved: false });
    const broken = fakeDb({}, { rpc: () => ({ data: null, error: { message: "timeout" } }) });
    expect((await retitleDismissal(broken.sb, { jobId: "j1", lineId: "L", from: "A", to: "B" })).error).toBeTruthy();
  });
  it("the estimate's rename door moves the dismissal when no task read as the line put it", () => {
    const fn = body(src("src/app/(app)/quotes/actions.ts"), "export async function updateQuoteItem(");
    expect(fn).toContain("const d = await retitleDismissal(supabase, { jobId, lineId: itemId, from: String(before.description ?? \"\"), to: String(clean.description) });");
    expect(fn).toContain('reportError("updateQuoteItem:retitleDismissal"');
  });
});

describe("[15] a task's dismissal goes through the atomic door", () => {
  it("deleteTask calls dismiss_task_key with the entry and reports a false or failed answer; no read-modify-write remains", async () => {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const reported: unknown[] = [];
    vi.doMock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reported.push(a) }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
    const client = {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      rpc: (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return Promise.resolve({ data: true, error: null });
      },
      from: (table: string) => {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          delete: () => chain,
          update: () => { throw new Error("jobs must not be written by hand"); },
          maybeSingle: async () => (table === "tasks" ? { data: { id: "t1", job_id: "j1", created_by: "u1", source_key: "line:L", title: "Trench" }, error: null } : { data: null, error: null }),
          then: (r: (v: unknown) => void) => r({ data: [{ id: "t1" }], error: null }),
        };
        return chain;
      },
    };
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => client }));
    const { deleteTask } = await import("../src/app/(app)/tasks/actions");
    expect(await deleteTask("t1")).toEqual({ ok: true });
    expect(calls).toEqual([{ fn: "dismiss_task_key", args: { p_job_id: "j1", p_entry: "line:L#Trench" } }]);
    expect(reported).toEqual([]);
    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/observe");
    vi.doUnmock("next/cache");
  });
});

describe("[5] a kit with no count asks; [31] an unlinked kit line names its part; [39] the switch hides the picker only; [40] the kit manager says so", () => {
  const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({ task_id: "t1", labor: [{ label: null, person_id: null, hours: 2, rate: 100, rate_from: "rule" }], units: null, kit_id: null, materials: [], ...over });
  it("taskFlags asks 'units?' on a kit task with no count, and not once a count is typed", () => {
    expect(taskFlags(detail({ kit_id: "k1", units: null }))).toBe("units?");
    expect(taskFlags(detail({ kit_id: "k1", units: 1 }))).toBeUndefined();
    expect(taskFlags(detail({ kit_id: null, units: null }))).toBeUndefined();
  });
  it("the Inspector shows the amber 'units?' chip beside a known kit's blank Units box, and the builder's box reads blank", () => {
    const inspector = src("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(inspector).toContain("const unitsAsking = !!kit && t.units === null;");
    expect(inspector).toContain("units?");
    expect(inspector).toContain('{t.units === null ? `From the kit, per ${kit?.unit || "unit"}` : `From the kit, for ×${t.units}${kit?.unit ? ` ${kit.unit}` : ""}`}');
    expect(src("src/app/(app)/quotes/task-breakdown.tsx")).toContain('value={d.units ?? 0} disabled={disabled} onValueChange={setUnits}');
  });
  it("an UNLINKED kit line that froze its book words drops the code lead; a hand-typed line with a dash keeps it", () => {
    const kit: TaskKit = {
      id: "k1", name: "Footing", labor_minutes: 60, unit: "footing",
      items: [
        { id: "i1", description: "C80 — Concrete, 60 lb", quantity: 2, unit: "bag", unit_price: 8, sort_order: 1, price_list_item_id: "pli-1", price_list_items: null },
        { id: "i2", description: "Rebar — #4", quantity: 1, unit: "ea", unit_price: 5, sort_order: 2 },
        { id: "i3", description: "RACO 936 — Box, 4 square", quantity: 1, unit: "ea", unit_price: 3, sort_order: 3, price_list_item_id: "pli-2", price_list_items: null },
      ],
    };
    const out = expandTaskKit({ id: "t", name: "Footings", hours: null, units: 1, kit_id: "k1", materials: [] }, kit, { orgDefaultPct: 0 });
    expect(out.materials.map((m) => m.name)).toEqual(["Concrete, 60 lb", "Rebar — #4", "Box, 4 square"]);
  });
  it("the Inspector takes kitsPicker: off hides the select and the units hint, a picked kit still names itself", () => {
    const inspector = src("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(inspector).toContain("kitsPicker = true,");
    expect(inspector).toContain("{readOnly || kitUnread || !kitsPicker ? (");
    expect(inspector).toContain("if (!((kitsPicker && taskKits.length > 0) || t.kit_id || showUnits)) return null;");
  });
  it("Edit Kit says a task kit leaves Add From Kit", () => {
    expect(src("src/app/(app)/price-list/kits-manager.tsx")).toContain("It will no longer appear in Add From Kit on estimates and invoices (clear the hours to bring it back).");
  });
});
