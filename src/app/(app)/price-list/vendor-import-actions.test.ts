import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Add N Vendors and its Undo (vendor import, Phase 1), and the 0341 rule that a subcontractor never
 * carries prices on an item, driven through the REAL server actions against a small in-memory
 * database. The database keeps 0296's one-card-per-name rule (lower(btrim(name)) per org), stamps
 * created_at/updated_at the way Postgres does (an insert leaves them equal; 0296's touch trigger
 * moves updated_at on every update), and can be told it hasn't had 0341 yet.
 *
 * Every name is made up: a real customer's vendor list never goes in this repo (it is public).
 */

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** No 0341 yet: naming kind/trade/is_person/import_batch fails like PostgREST does. */
  noKinds: false,
  clock: 0,
  staff: true,
  orgId: "org-1",
  /** A card the reads can't see yet (it lands between the read and the insert). */
  hidden: null as string | null,
}));

const NEW_COLS = /\b(kind|trade|is_person|import_batch)\b/;
const stamp = () => `2026-09-25T20:00:${String(++db.clock).padStart(2, "0")}.000000+00:00`;

function uniqueViolation(table: string, rows: Row[]): { message: string } | null {
  if (table !== "price_list_vendors") return null;
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.org_id}|${String(r.name).trim().toLowerCase()}`;
    if (seen.has(k)) return { message: 'duplicate key value violates unique constraint "price_list_vendors_one_per_name"' };
    seen.add(k);
  }
  return null;
}

function fakeClient() {
  return {
    from(table: string) {
      let op: "select" | "insert" | "update" = "select";
      let payload: Row | Row[] | null = null;
      let cols = "*";
      let wantRows = false;
      const filters: ((r: Row) => boolean)[] = [];
      const missingColumn = () =>
        db.noKinds &&
        table === "price_list_vendors" &&
        (NEW_COLS.test(cols) || (payload && [payload].flat().some((p) => Object.keys(p).some((k) => NEW_COLS.test(k)))));
      const run = (): { data: any; error: any } => {
        const all = (db.tables[table] ??= []);
        if (missingColumn()) return { data: null, error: { code: "42703", message: "column price_list_vendors.kind does not exist" } };
        // RLS, as 0296 writes it: the org sees its own rows; only staff write.
        const mine = all.filter((r) => r.org_id === db.orgId && !(op === "select" && r.name === db.hidden));
        const hit = mine.filter((r) => filters.every((f) => f(r)));
        if (op === "select") return { data: hit.map((r) => ({ ...r })), error: null };
        if (!db.staff) return { data: wantRows ? [] : null, error: null };
        if (op === "insert") {
          const t = stamp();
          const rows = [payload as Row | Row[]].flat().map((p, i) => ({
            id: `${table}-${all.length + i + 1}`,
            org_id: db.orgId,
            archived: false,
            is_default: false,
            created_at: t,
            updated_at: t,
            ...p,
          }));
          const err = uniqueViolation(table, [...all, ...rows]);
          if (err) return { data: null, error: err };
          all.push(...rows);
          return { data: wantRows ? rows.map((r) => ({ ...r })) : null, error: null };
        }
        const t = stamp();
        const next = all.map((r) => (hit.includes(r) ? { ...r, ...(payload as Row), updated_at: t } : r));
        const err = uniqueViolation(table, next);
        if (err) return { data: null, error: err };
        for (const r of hit) Object.assign(r, payload, { updated_at: t });
        return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
      };
      const chain: any = {
        select(c?: string) {
          if (op === "select") cols = c ?? "*";
          wantRows = true;
          return chain;
        },
        insert(p: Row | Row[]) {
          op = "insert";
          payload = p;
          return chain;
        },
        update(p: Row) {
          op = "update";
          payload = p;
          return chain;
        },
        eq(col: string, v: unknown) {
          if (NEW_COLS.test(col)) cols += ` ${col}`;
          filters.push((r) => r[col] === v);
          return chain;
        },
        in(col: string, vs: unknown[]) {
          filters.push((r) => vs.includes(r[col]));
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const r = run();
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
        },
        then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
          try {
            resolve(run());
          } catch (e) {
            reject(e);
          }
        },
      };
      return chain;
    },
  };
}

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () =>
    db.staff ? { supabase: fakeClient(), orgId: db.orgId, userId: "user-1" } : { error: "Only the office can change the price list." },
  ),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

import { addVendorsBatch, saveVendorField, undoVendorImport } from "./vendor-actions";
import { addItemOption } from "./actions";

const BATCH = "11111111-2222-4333-8444-555555555555";
const vendors = () => (db.tables.price_list_vendors ?? []).filter((r) => r.org_id === "org-1");
const liveNames = () => vendors().filter((r) => !r.archived).map((r) => r.name).sort();

beforeEach(() => {
  db.noKinds = false;
  db.clock = 0;
  db.staff = true;
  db.orgId = "org-1";
  db.hidden = null;
  db.tables = {
    price_list_items: [{ id: "item-830", org_id: "org-1", code: "830", description: "Windows" }],
    price_list_item_options: [
      { id: "o-1", org_id: "org-1", item_id: "item-830", vendor: "Harbor Door Co", label: null, archived: false, is_default: false, buy_price: 100, sort_order: 1 },
    ],
    price_list_vendors: [
      { id: "v-live", org_id: "org-1", name: "Acme Supply", archived: false, kind: "supplier", created_at: "t0", updated_at: "t0" },
      { id: "v-arch", org_id: "org-1", name: "Lakeside Windows", archived: true, kind: "brand", phone: null, created_at: "t0", updated_at: "t1" },
      // Another company's card, with the same name as one on the list: invisible here, untouched.
      { id: "v-other", org_id: "org-2", name: "Granite Peak Plumbing", archived: false, kind: "subcontractor", import_batch: BATCH, created_at: "t0", updated_at: "t0" },
    ],
  };
});

describe("Add N Vendors: one press, checked on the server, whatever the preview said", () => {
  it("adds the new names in one insert, stamped with the batch, with kind, trade and the person flag", async () => {
    const res = await addVendorsBatch(
      [
        { name: "Granite Peak Plumbing", kind: "subcontractor", trade: "Plumbing" },
        { name: "Maria Delgado", kind: "", is_person: true },
      ],
      BATCH,
    );
    expect(res).toMatchObject({ ok: true, added: 2, restored: [], refused: [] });
    const added = vendors().filter((r) => r.import_batch === BATCH);
    expect(added.map((r) => [r.name, r.kind, r.trade ?? null, r.is_person, r.created_by])).toEqual([
      ["Granite Peak Plumbing", "subcontractor", "Plumbing", false, "user-1"],
      ["Maria Delgado", null, null, true, "user-1"],
    ]);
    // The other company's Granite Peak Plumbing was never seen and never touched.
    expect(db.tables.price_list_vendors.find((r) => r.id === "v-other")).toMatchObject({ org_id: "org-2", archived: false });
  });

  it("refuses an exact duplicate of a live card case-insensitively, by name, and adds the rest", async () => {
    const res = await addVendorsBatch([{ name: "  ACME SUPPLY " }, { name: "Coldwater Drywall", kind: "subcontractor" }], BATCH);
    expect(res.ok).toBe(true);
    expect(res.added).toBe(1);
    expect(res.refused).toEqual([{ name: "ACME SUPPLY", why: "Acme Supply is already on your Vendors list." }]);
    expect(liveNames()).toEqual(["Acme Supply", "Coldwater Drywall"]);
  });

  it("a name twice in one press is added once", async () => {
    const res = await addVendorsBatch([{ name: "Coldwater Drywall" }, { name: "coldwater drywall" }], BATCH);
    expect(res.added).toBe(1);
    expect(res.refused).toEqual([{ name: "coldwater drywall", why: "It's in this list twice, so it was added once." }]);
  });

  it("an archived card comes back with what the row says, and hands Undo its stamp", async () => {
    const res = await addVendorsBatch([{ name: "lakeside windows", kind: "supplier", phone: "5305550101" }], BATCH);
    expect(res.ok).toBe(true);
    expect(res.added).toBe(0);
    const back = db.tables.price_list_vendors.find((r) => r.id === "v-arch")!;
    expect(back).toMatchObject({ archived: false, kind: "supplier", phone: "5305550101", import_batch: BATCH });
    expect(res.restored).toEqual([{ id: "v-arch", name: "Lakeside Windows", stamp: back.updated_at }]);
    expect(res.note).toBe("1 was archived and came back: Lakeside Windows.");
  });

  it("a subcontractor whose name already carries prices on items is refused by name", async () => {
    const res = await addVendorsBatch([{ name: "Harbor Door Co", kind: "subcontractor" }], BATCH);
    expect(res.ok).toBe(false);
    expect(res.refused?.[0].why).toMatch(/^Harbor Door Co has prices on 1 item, so it can't be a subcontractor\./);
    expect(liveNames()).toEqual(["Acme Supply"]);
  });

  it("a kind outside the whitelist is refused in words, never stored", async () => {
    const res = await addVendorsBatch([{ name: "Quartzline Holdings", kind: "vendor" }], BATCH);
    expect(res.ok).toBe(false);
    expect(res.refused).toEqual([{ name: "Quartzline Holdings", why: "Pick a kind: Supplier, Subcontractor, Brand or Not Sorted." }]);
  });

  it("a bad batch id, an empty list and more than 200 rows are refused before anything is read", async () => {
    expect((await addVendorsBatch([{ name: "A" }], "not-a-uuid")).ok).toBe(false);
    expect((await addVendorsBatch([], BATCH)).error).toBe("Nothing is ticked, so nothing was added.");
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `Made Up ${i}` }));
    expect((await addVendorsBatch(many, BATCH)).error).toMatch(/more than 200 vendors at once/);
    expect(liveNames()).toEqual(["Acme Supply"]);
  });

  it("a tech can't add: requireStaff refuses and nothing is written", async () => {
    db.staff = false;
    const res = await addVendorsBatch([{ name: "Coldwater Drywall" }], BATCH);
    expect(res).toEqual({ ok: false, error: "Only the office can change the price list." });
    expect(liveNames()).toEqual(["Acme Supply"]);
  });

  it("before 0341 it says in words that sorting arrives with the update, and writes nothing", async () => {
    db.noKinds = true;
    const res = await addVendorsBatch([{ name: "Coldwater Drywall", kind: "subcontractor" }], BATCH);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Sorting vendors into suppliers, subcontractors and brands arrives with the next update\./);
    db.noKinds = false;
    expect(liveNames()).toEqual(["Acme Supply"]);
  });

  it("the server reads the cards again at the press: a name added elsewhere since the preview is refused by name", async () => {
    db.tables.price_list_vendors.push({ id: "v-new", org_id: "org-1", name: "Ridge Roofing", archived: false, created_at: "t", updated_at: "t" });
    const res = await addVendorsBatch([{ name: "Ridge Roofing" }, { name: "Pine Painting" }], BATCH);
    expect(res.refused).toEqual([{ name: "Ridge Roofing", why: "Ridge Roofing is already on your Vendors list." }]);
    expect(res.added).toBe(1);
  });

  it("a name that lands between the server's read and its insert: the one insert is refused whole, nothing half-added", async () => {
    db.hidden = "Ridge Roofing";
    db.tables.price_list_vendors.push({ id: "v-race", org_id: "org-1", name: "Ridge Roofing", archived: false, created_at: "t", updated_at: "t" });
    const res = await addVendorsBatch([{ name: "Pine Painting" }, { name: "ridge roofing" }], BATCH);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/added to your Vendors list a moment ago, somewhere else\. Nothing was added\./);
    db.hidden = null;
    expect(liveNames()).toEqual(["Acme Supply", "Ridge Roofing"]);
  });
});

describe("Undo: archives exactly that press's cards, and only the ones nobody has touched since", () => {
  it("leaves an edited card alone and names it; archives the rest; never another company's", async () => {
    const res = await addVendorsBatch([{ name: "Granite Peak Plumbing" }, { name: "Coldwater Drywall" }, { name: "Summit Construction" }], BATCH);
    expect(res.added).toBe(3);
    // Somebody fixes a phone number on one of them after the import.
    const fixed = await saveVendorField({ name: "Coldwater Drywall", field: "phone", value: "5305550199" });
    expect(fixed.ok).toBe(true);

    const undo = await undoVendorImport({ batchId: BATCH, restored: res.restored });
    expect(undo).toMatchObject({ ok: true, archived: 2, leftAlone: ["Coldwater Drywall"] });
    expect(undo.note).toBe("Archived 2 vendors from that import. Left alone because it has been changed since: Coldwater Drywall.");
    expect(liveNames()).toEqual(["Acme Supply", "Coldwater Drywall"]);
    // org-2's card carries the same batch id (a forged or colliding id): untouched.
    expect(db.tables.price_list_vendors.find((r) => r.id === "v-other")?.archived).toBe(false);
  });

  it("a card brought back from the archive goes back to the archive, while it still carries its stamp", async () => {
    const res = await addVendorsBatch([{ name: "Lakeside Windows" }], BATCH);
    const undo = await undoVendorImport({ batchId: BATCH, restored: res.restored });
    expect(undo).toMatchObject({ ok: true, archived: 1, leftAlone: [] });
    expect(db.tables.price_list_vendors.find((r) => r.id === "v-arch")?.archived).toBe(true);
  });

  it("without its stamp, a brought-back card is left alone (never guessed at)", async () => {
    await addVendorsBatch([{ name: "Lakeside Windows" }], BATCH);
    const undo = await undoVendorImport({ batchId: BATCH });
    expect(undo).toMatchObject({ ok: true, archived: 0, leftAlone: ["Lakeside Windows"] });
  });

  it("a card put on an item since the import is left alone", async () => {
    await addVendorsBatch([{ name: "Ridge Glass", kind: "supplier" }], BATCH);
    db.tables.price_list_item_options.push({ id: "o-2", org_id: "org-1", item_id: "item-830", vendor: "Ridge Glass", label: null, archived: false, is_default: false });
    const undo = await undoVendorImport({ batchId: BATCH });
    expect(undo).toMatchObject({ ok: true, archived: 0, leftAlone: ["Ridge Glass"] });
  });

  it("a tech can't undo", async () => {
    await addVendorsBatch([{ name: "Granite Peak Plumbing" }], BATCH);
    db.staff = false;
    expect((await undoVendorImport({ batchId: BATCH })).ok).toBe(false);
    db.staff = true;
    expect(liveNames()).toContain("Granite Peak Plumbing");
  });
});

describe("a subcontractor never carries prices on an item (0341), at the write as well as the picker", () => {
  it("adding a subcontractor's name to an item is refused by name, and nothing is written", async () => {
    await addVendorsBatch([{ name: "Coldwater Drywall", kind: "subcontractor" }], BATCH);
    const before = db.tables.price_list_item_options.length;
    const res = await addItemOption({ itemId: "item-830", vendor: "coldwater drywall", buyPrice: "100" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Coldwater Drywall is a subcontractor on your Vendors list, and subcontractors don't carry prices on items. Change its Kind to Supplier or Brand on the Vendors tab first.",
    );
    expect(db.tables.price_list_item_options.length).toBe(before);
  });

  it("a supplier can still go on an item", async () => {
    await addVendorsBatch([{ name: "Ridge Glass", kind: "supplier" }], BATCH);
    const res = await addItemOption({ itemId: "item-830", vendor: "Ridge Glass", buyPrice: "100" });
    expect(res.ok).toBe(true);
  });

  it("a vendor with prices on items can't be switched to Subcontractor; it says why and how", async () => {
    const res = await saveVendorField({ name: "Harbor Door Co", field: "kind", value: "subcontractor" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Harbor Door Co has prices on 1 item, so it can't be a subcontractor\. Keep it a Supplier or Brand/);
  });

  it("kind and trade save one at a time like every other detail, with the old value for Undo", async () => {
    const res = await saveVendorField({ name: "Acme Supply", field: "kind", value: "brand" });
    expect(res).toMatchObject({ ok: true, previous: "supplier" });
    const t = await saveVendorField({ name: "Acme Supply", field: "trade", value: "Lumber" });
    expect(t.ok).toBe(true);
    expect(vendors().find((r) => r.id === "v-live")).toMatchObject({ kind: "brand", trade: "Lumber" });
  });
});

describe("the screen: Title Case on every new clickable, and the words that replaced 'a vendor is the brand'", () => {
  const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
  const IMPORT = read("./vendor-import.tsx");
  const MANAGER = read("./vendors-manager.tsx");

  it("the import door and its preview", () => {
    for (const label of ["Import A List", "Drop A Vendor List Here (Excel, CSV, PDF Or Photo)", "Tick All", "Untick All", "Guessed From The Name", "A Person", "Nothing Ticked"]) {
      expect(IMPORT).toContain(label);
    }
    expect(IMPORT).toContain("`Add ${n} Vendor${n === 1 ? \"\" : \"s\"}`");
    expect(IMPORT).toContain("Nothing is saved until you press Add.");
    // The preview sits above the dock like every other Modal (z-[120]) and its targets are 44px.
    expect(IMPORT).toContain("min-h-11 min-w-11");
  });

  it("the Vendors tab: chips, kind words, View On Map, and the line that says who carries prices", () => {
    expect(MANAGER).toContain("Your suppliers, subcontractors and brands. Brands and suppliers can carry prices on items.");
    expect(MANAGER).toContain("View On Map");
    expect(MANAGER).not.toContain("A vendor is the brand, e.g. Andersen.\n");
    expect(MANAGER).not.toContain('placeholder: "the brand, e.g. Andersen"');
  });
});
