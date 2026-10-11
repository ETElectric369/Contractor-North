import { describe, it, expect } from "vitest";
import { fakeDb } from "@/test/fake-supabase";
import { isHisRow, materialsWords, partHalf, partsFromLines, planPartSync, syncJobMaterials, syncQuoteMaterials, type KeyedPart, type ListPartRow } from "./sync-job-materials";
import { keyParts, materialKey } from "./born-with-tasks";

/**
 * THE MATERIALS LIST FOLLOWS THE ESTIMATE (0390). An estimate's keyed rows are the parts of its task
 * lines; what he did to a row (bought it, called it a tool, counted it, deleted it) is his. The plan
 * is pure; the sync runs against the thenable fake so every write is seen to select what it wrote.
 * Names are stand-ins ("Bayberry"), never a customer's.
 */
const part = (over: Partial<KeyedPart> & { key: string; name: string }): KeyedPart => ({ code: null, qty: 1, cost: null, ...over });
const row = (over: Partial<ListPartRow> & { id: string; source_key: string }): ListPartRow => ({
  description: "x", part_number: null, quantity: 1, purchased: false, is_tool: false, ...over,
});

describe("materialKey / keyParts — a part's key is its task's key plus the part, with ordinals for repeats", () => {
  it("uses the book code when there is one (upper-cased), else a slug of the words; a repeat gets ~2", () => {
    expect(materialKey("line:l1", "r1", "Transfer switch")).toBe("line:l1#R1");
    expect(materialKey("line:l1", null, "Bayberry clips, 2 in.")).toBe("line:l1#bayberry-clips-2-in");
    expect(materialKey("task:t1", "", "")).toBe("task:t1#part");
    expect(keyParts("line:l1", [{ code: "R1", name: "a" }, { code: "r1", name: "b" }, { code: null, name: "Clips" }]).map((p) => p.key)).toEqual(["line:l1#R1", "line:l1#R1~2", "line:l1#clips"]);
    expect(partHalf("line:l1#R1~2")).toBe("R1");
  });
  it("partsFromLines keys a task line's named parts the way the take-off does — whatever the line's title", () => {
    const parts = partsFromLines([
      { id: "l1", description: "", sort_order: 0, detail: { task_id: "t", hours: 1, rate: 1, units: null, kit_id: null, materials: [{ code: "R1", name: "Switch", qty: 2, cost: 4, sell: 5 }, { code: null, name: "  ", qty: 1, cost: null, sell: null }] } },
      { id: "l2", description: "Plain", sort_order: 1, detail: null },
    ]);
    expect(parts).toEqual([{ key: "line:l1#R1", code: "R1", name: "Switch", qty: 2, cost: 4, taskId: "t" }]);
  });
});

describe("planPartSync — the plan", () => {
  const wanted = [part({ key: "line:a#R1", code: "R1", name: "Switch", qty: 2 }), part({ key: "line:a#bayberry-clips", name: "Bayberry clips", qty: null })];
  it("keeps a keyed row whose part is still on a task line, inserts the wanted parts nobody has", () => {
    const plan = planPartSync(wanted, [row({ id: "r1", source_key: "line:a#R1", quantity: 2 })]);
    expect(plan.rekey).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.insert.map((p) => p.key)).toEqual(["line:a#bayberry-clips"]);
    expect(plan.countsDiffer).toEqual([]);
  });
  it("a kept row whose count is not the estimate's is SAID by name, never rewritten", () => {
    const plan = planPartSync(wanted, [row({ id: "r1", source_key: "line:a#R1", description: "Switch", quantity: 5 }), row({ id: "r2", source_key: "line:a#bayberry-clips", quantity: 1 })]);
    expect(plan.countsDiffer).toEqual([{ description: "Switch", shows: 5, estimate: 2 }]); // a wanted "how many?" compares with nothing
  });
  it("re-keys an orphan by its '#part' half when the line got a new id (the builder's rewrite)", () => {
    const plan = planPartSync(wanted, [row({ id: "r1", source_key: "line:OLD#R1", quantity: 2 }), row({ id: "r2", source_key: "line:OLD#bayberry-clips" })]);
    expect(plan.rekey).toEqual([
      { id: "r1", source_key: "line:a#R1" },
      { id: "r2", source_key: "line:a#bayberry-clips" },
    ]);
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
  });
  it("two lines both need R1: the orphan with the EQUAL count claims the rebuilt line, not the first by position", () => {
    const w = [part({ key: "line:B2#R1", code: "R1", name: "Switch", qty: 10 })];
    const plan = planPartSync(w, [row({ id: "a", source_key: "line:A#R1", quantity: 2 }), row({ id: "b", source_key: "line:B#R1", quantity: 10 })]);
    expect(plan.rekey).toEqual([{ id: "b", source_key: "line:B2#R1" }]);
    expect(plan.remove.map((r) => r.id)).toEqual(["a"]);
  });
  it("a bought (or tool) orphan is re-keyed only onto an equal count — it must never make a new need read as already bought", () => {
    const w = [part({ key: "line:new#R1", code: "R1", name: "Switch", qty: 3 })];
    const bought = planPartSync(w, [row({ id: "b", source_key: "line:OLD#R1", quantity: 1, purchased: true, description: "Switch" })]);
    expect(bought.rekey).toEqual([]);
    expect(bought.kept.map((r) => r.id)).toEqual(["b"]);
    expect(bought.insert.map((p) => p.key)).toEqual(["line:new#R1"]);
    const same = planPartSync(w, [row({ id: "b", source_key: "line:OLD#R1", quantity: 3, purchased: true })]);
    expect(same.rekey).toEqual([{ id: "b", source_key: "line:new#R1" }]);
    // and a not-his orphan claims before a bought one when both could
    const both = planPartSync(w, [row({ id: "bought", source_key: "line:X#R1", quantity: 3, purchased: true }), row({ id: "open", source_key: "line:Y#R1", quantity: 3 })]);
    expect(both.rekey).toEqual([{ id: "open", source_key: "line:new#R1" }]);
    expect(both.kept.map((r) => r.id)).toEqual(["bought"]);
  });
  it("removes an orphan that is neither bought nor a tool; keeps one that is (said by name)", () => {
    const plan = planPartSync(
      [],
      [row({ id: "gone", source_key: "line:z#W1" }), row({ id: "bought", source_key: "line:z#W2", purchased: true, description: "Romex" }), row({ id: "tool", source_key: "line:z#W3", is_tool: true })],
    );
    expect(plan.remove.map((r) => r.id)).toEqual(["gone"]);
    expect(plan.kept.map((r) => r.id)).toEqual(["bought", "tool"]);
  });
  it("a dismissed key is never inserted and never re-keyed into", () => {
    const plan = planPartSync(wanted, [row({ id: "r1", source_key: "line:OLD#R1" })], new Set(["line:a#R1"]));
    expect(plan.insert.map((p) => p.key)).toEqual(["line:a#bayberry-clips"]);
    expect(plan.rekey).toEqual([]);
    expect(plan.remove.map((r) => r.id)).toEqual(["r1"]);
  });
  it("a dismissal under a line that is GONE still bars the same part on the rebuilt line, and is re-dismissed under the new key", () => {
    const plan = planPartSync(wanted, [], new Set(["line:OLD#R1"]));
    expect(plan.insert.map((p) => p.key)).toEqual(["line:a#bayberry-clips"]);
    expect(plan.redismiss).toEqual(["line:a#R1"]);
  });
  it("an unkeyed row that is not his (typed by hand, or taken off before 0390) under the same code or words becomes the line's — re-keyed, counted as matched, never inserted again", () => {
    const plan = planPartSync(wanted, [], new Set(), [
      { id: "h1", part_number: "r1", description: "Switch", quantity: 2 },
      { id: "h2", part_number: null, description: "Bayberry clips · how many?", quantity: 1 },
    ]);
    expect(plan.rekey).toEqual([{ id: "h1", source_key: "line:a#R1" }, { id: "h2", source_key: "line:a#bayberry-clips" }]);
    expect(plan.insert).toEqual([]);
    expect(plan.countsDiffer).toEqual([]);
  });
  it("isHisRow: bought or a tool", () => {
    expect(isHisRow({ purchased: false, is_tool: false })).toBe(false);
    expect(isHisRow({ purchased: true, is_tool: false })).toBe(true);
    expect(isHisRow({ purchased: null, is_tool: true })).toBe(true);
  });
});

const ORG = "org-1";
const BOOK = [{ org_id: ORG, code: "R1", description: "Transfer switch, 200A", supplier: "Northline Supply", buy_price: 400, unit: "ea", archived: false, price_list_item_options: [] }];
const taskLine = (id: string, materials: unknown[], sort_order = 0) => ({
  id, quote_id: "q-1", org_id: ORG, description: "Install", quantity: 1, unit: "ea", unit_price: 999, sort_order,
  detail: { task_id: `t-${id}`, hours: 2, rate: 100, units: null, kit_id: null, materials },
});
const world = (over: { lines?: Record<string, unknown>[]; rows?: Record<string, unknown>[]; dismissed?: string[]; noList?: boolean } = {}) =>
  fakeDb({
    quotes: [{ id: "q-1", quote_number: "Q-1", job_id: "job-1", status: "accepted", title: "Generator", customer_id: null, org_id: ORG, accepted_at: "2026-10-10", created_at: "2026-10-09" }],
    material_lists: over.noList ? [] : [{ id: "ml-1", quote_id: "q-1", job_id: "job-1", org_id: ORG, dismissed_keys: over.dismissed ?? [] }],
    quote_line_items: over.lines ?? [taskLine("l1", [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 500 }, { code: null, name: "Bayberry clips", qty: null, cost: null, sell: null }])],
    material_list_items: over.rows ?? [],
    price_list_items: BOOK,
    organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }],
    customers: [],
  });
const keyedRow = (id: string, source_key: string, over: Record<string, unknown> = {}) => ({ id, list_id: "ml-1", org_id: ORG, source_key, description: "x", part_number: null, quantity: 1, purchased: false, is_tool: false, sort_order: 0, ...over });
const WHO = { quoteId: "q-1", jobId: "job-1", orgId: ORG, userId: "u1" };

describe("planPartSync — the deferred items (cn-v1084)", () => {
  it("a visit's row claims the line built from its task (by id), any count — a differing count is said; one with no line is left alone", () => {
    const wanted = [part({ key: "line:a#R1", code: "R1", name: "Switch", qty: 3, taskId: "T1" })];
    const plan = planPartSync(wanted, [row({ id: "v", source_key: "task:T1#R1", quantity: 1, purchased: true }), row({ id: "w", source_key: "task:T2#W9" })]);
    expect(plan.rekey).toEqual([{ id: "v", source_key: "line:a#R1" }]);
    expect(plan.countsDiffer).toEqual([{ description: "x", shows: 1, estimate: 3 }]);
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.kept).toEqual([]);
    expect(plan.tombstone).toEqual([]);
  });
  it("a visit's row with no id match still claims by the part half like any orphan — but is never removed or kept as the estimate's", () => {
    const wanted = [part({ key: "line:a#R1", code: "R1", name: "Switch", qty: 2, taskId: "T1" })];
    const plan = planPartSync(wanted, [row({ id: "v", source_key: "task:OTHER#R1", quantity: 2 }), row({ id: "stay", source_key: "task:OTHER#Z9", quantity: 9 })]);
    expect(plan.rekey).toEqual([{ id: "v", source_key: "line:a#R1" }]);
    expect(plan.remove).toEqual([]);
    expect(plan.kept).toEqual([]);
  });
  it("a kept orphan (bought, or a tool) goes under the tombstone — said this once — and is the line's again when that line returns", () => {
    const plan = planPartSync([], [row({ id: "b", source_key: "line:gone#R1", purchased: true }), row({ id: "open", source_key: "line:gone#W9" })]);
    expect(plan.kept.map((r) => r.id)).toEqual(["b"]);
    expect(plan.tombstone).toEqual([{ id: "b", source_key: "gone:line:gone#R1" }]);
    expect(plan.remove.map((r) => r.id)).toEqual(["open"]);
    const back = planPartSync([part({ key: "line:gone#R1", code: "R1", name: "Switch", qty: 1 })], [row({ id: "b", source_key: "line:gone#R1", purchased: true, gone: true })]);
    expect(back.rekey).toEqual([{ id: "b", source_key: "line:gone#R1" }]);
    expect(back.insert).toEqual([]);
    expect(back.kept).toEqual([]);
    const still = planPartSync([], [row({ id: "b", source_key: "line:gone#R1", purchased: true, gone: true })]);
    expect(still).toMatchObject({ insert: [], rekey: [], remove: [], kept: [], tombstone: [] });
  });
  it("a row that is there claims BEFORE a dismissal bars; the bar is said (left off) and the dismissal MOVES — one entry per deletion across rebuilds", () => {
    const w = [part({ key: "line:NEW#R1", code: "R1", name: "Switch", qty: 2 })];
    const live = planPartSync(w, [row({ id: "r", source_key: "line:OLD#R1", quantity: 2 })], new Set(["line:GONE#R1"]));
    expect(live.rekey).toEqual([{ id: "r", source_key: "line:NEW#R1" }]);
    expect(live.leftOff).toEqual([]);
    expect(live.consumed).toEqual([]);
    const barred = planPartSync(w, [], new Set(["line:GONE#R1"]));
    expect(barred.insert).toEqual([]);
    expect(barred.leftOff).toEqual(["Switch"]);
    expect(barred.consumed).toEqual(["line:GONE#R1"]);
    expect(barred.redismiss).toEqual(["line:NEW#R1"]);
  });
});

describe("syncQuoteMaterials — the writes", () => {
  it("inserts the parts nobody has through the take-off's own row shape, keyed, after the last row; a hand row is never touched", async () => {
    const { sb, inserted, tables } = world({ rows: [{ id: "hand", list_id: "ml-1", org_id: ORG, source_key: null, description: "By hand", part_number: null, quantity: 3, purchased: false, is_tool: false, sort_order: 4 }] });
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ inserted: 2, rekeyed: 0, removed: 0, leftOff: [] });
    expect(res.error).toBeUndefined();
    expect(inserted.material_list_items).toEqual([
      { id: "material_list_items-1", list_id: "ml-1", org_id: ORG, description: "Transfer switch, 200A", part_number: "R1", quantity: 1, unit: "ea", vendor: "Northline Supply", est_cost: 400, source_key: "line:l1#R1", sort_order: 5 },
      { id: "material_list_items-2", list_id: "ml-1", org_id: ORG, description: "Bayberry clips · how many?", part_number: null, quantity: 1, unit: "ea", vendor: null, est_cost: null, source_key: "line:l1#bayberry-clips", sort_order: 6 },
    ]);
    expect(tables.material_list_items.find((r) => r.id === "hand")).toBeDefined();
  });
  it("re-keys the builder's new ids, removes a bare orphan (named), keeps a bought one (named)", async () => {
    const { sb, tables } = world({
      rows: [
        keyedRow("r1", "line:OLD#R1", { purchased: true, quantity: 1, description: "Switch" }),
        keyedRow("r2", "line:gone#W9", { description: "Old strap" }),
        keyedRow("r3", "line:gone2#W8", { purchased: true, description: "Romex" }),
      ],
    });
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ inserted: 1, rekeyed: 1, removed: 1, removedNames: ["Old strap"], kept: 1, keptNames: ["Romex"] });
    const byId = Object.fromEntries(tables.material_list_items.map((r) => [r.id, r]));
    expect(byId.r1.source_key).toBe("line:l1#R1");
    expect(byId.r1.purchased).toBe(true);
    expect(byId.r2).toBeUndefined();
    expect(byId.r3).toBeDefined();
  });
  it("a dismissed key is not born again; a dismissal under a gone line bars the rebuilt line's part (left off, said) and MOVES to its key", async () => {
    const { sb, inserted, tables } = world({ dismissed: ["line:OLD#R1"] });
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ inserted: 1, leftOff: ["Transfer switch, 200A"] });
    expect(inserted.material_list_items.map((r) => r.source_key)).toEqual(["line:l1#bayberry-clips"]);
    expect(tables.material_lists[0].dismissed_keys).toEqual(["line:l1#R1"]);
    expect(materialsWords(res)).toBe("The estimate's materials list follows too: 1 part added · 1 left off (Transfer switch, 200A) — deleted from the list before.");
  });
  it("a part already on the list by hand (same code, not bought) becomes the line's row — re-keyed, matched — instead of a second row", async () => {
    const { sb, inserted, tables } = world({ rows: [{ id: "hand", list_id: "ml-1", org_id: ORG, source_key: null, description: "A switch I typed", part_number: "R1", quantity: 1, purchased: false, is_tool: false, sort_order: 0 }] });
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ inserted: 1, rekeyed: 1 });
    expect(tables.material_list_items.find((r) => r.id === "hand")?.source_key).toBe("line:l1#R1");
    expect(inserted.material_list_items.map((r) => r.source_key)).toEqual(["line:l1#bayberry-clips"]);
  });
  it("no list for the estimate → nothing is made or written here", async () => {
    const { sb, inserted } = world({ noList: true });
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toEqual({ inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] });
    expect(inserted).toEqual({});
  });
  it("a visit's row ('task:<id>#part') is re-keyed to the line built from that task and counted as matched; a bought hand row never bars the estimate's part", async () => {
    // The fixture's line l1 remembers task "t-l1" (taskLine); the visit's R1 row carries that id.
    const { sb, inserted, tables } = world({
      rows: [
        keyedRow("v1", "task:t-l1#R1", { description: "Switch, from the visit", quantity: 1 }),
        keyedRow("v2", "task:t-l1#not-on-the-line", { description: "Stays the visit's" }),
        { id: "bought", list_id: "ml-1", org_id: ORG, source_key: null, description: "R1 already bought", part_number: "R1", quantity: 1, purchased: true, is_tool: false, sort_order: 0 },
      ],
    });
    const res = await syncQuoteMaterials(sb, WHO);
    expect(res).toMatchObject({ inserted: 1, rekeyed: 1, removed: 0, kept: 0, leftOff: [] });
    const byId = Object.fromEntries(tables.material_list_items.map((r) => [r.id, r]));
    expect(byId.v1.source_key).toBe("line:l1#R1");
    expect(byId.v2.source_key).toBe("task:t-l1#not-on-the-line"); // not the estimate's to touch
    expect(byId.bought.source_key).toBe(null); // bought: never stands in for the estimate's R1
    expect(inserted.material_list_items.map((r) => r.source_key)).toEqual(["line:l1#bayberry-clips"]);
  });
  it("a kept orphan is said once: it goes under the tombstone, the next sync says nothing, and the line finds it again if it returns", async () => {
    const { sb, tables } = world({ lines: [], rows: [keyedRow("b", "line:l1#R1", { purchased: true, description: "Romex" })] });
    const first = await syncQuoteMaterials(sb, WHO);
    expect(first).toMatchObject({ kept: 1, keptNames: ["Romex"] });
    expect(tables.material_list_items.find((r) => r.id === "b")?.source_key).toBe("gone:line:l1#R1");
    const again = await syncQuoteMaterials(sb, WHO);
    expect(again).toMatchObject({ kept: 0, keptNames: [], inserted: 0 });
    tables.quote_line_items.push(taskLine("l1", [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 500 }]));
    const back = await syncQuoteMaterials(sb, WHO);
    expect(back).toMatchObject({ rekeyed: 1, inserted: 0, kept: 0 });
    expect(tables.material_list_items).toHaveLength(1);
    expect(tables.material_list_items[0].source_key).toBe("line:l1#R1");
  });
  it("is idempotent", async () => {
    const { sb, tables } = world();
    await syncQuoteMaterials(sb, WHO);
    const again = await syncQuoteMaterials(sb, WHO);
    expect(again).toEqual({ inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] });
    expect(tables.material_list_items).toHaveLength(2);
  });
  it("syncJobMaterials walks the job's accepted estimates and adds the counts up; the words say what the list did", async () => {
    const { sb } = world();
    const res = await syncJobMaterials(sb, { jobId: "job-1", orgId: ORG, userId: "u1" });
    expect(res.inserted).toBe(2);
    expect(materialsWords(res)).toBe("The estimate's materials list follows too: 2 parts added.");
    expect(materialsWords({ inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] })).toBeNull();
    expect(
      materialsWords({ inserted: 1, rekeyed: 2, removed: 1, removedNames: ["Strap"], kept: 1, keptNames: ["Romex"], leftOff: ["Clip"], countsDiffer: [{ description: "Rebar", shows: 14, estimate: 18 }] }),
    ).toBe("The estimate's materials list follows too: 1 part added · 2 matched · 1 removed (Strap) · 1 kept (Romex) — bought, or a tool · 1 left off (Clip) — deleted from the list before · Rebar shows 14, the estimate says 18.");
  });
});
