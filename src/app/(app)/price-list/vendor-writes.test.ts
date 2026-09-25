import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vendor writes that move MONEY by moving a seat or a name (audit v994 VP3, VP4, VP5), driven
 * through the real server actions against a small in-memory database that keeps 0282's two unique
 * indexes (one maker per item, archived included; one live default per item) and can be told to
 * fail one write, the way a dropped statement or a policy refusal would.
 */

type Row = Record<string, any>;
type Fail = (table: string, op: "insert" | "update" | "delete", payload: Row | null, rows: Row[]) => { message: string } | null;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  fail: null as null | Fail,
}));

function uniqueViolation(table: string, rows: Row[]): { message: string } | null {
  if (table !== "price_list_item_options") return null;
  const seen = new Set<string>();
  const defaults = new Set<string>();
  for (const r of rows) {
    const k = `${r.item_id}|${String(r.vendor).trim().toLowerCase()}|${String(r.label ?? "").toLowerCase()}`;
    if (seen.has(k)) return { message: 'duplicate key value violates unique constraint "price_list_item_options_one_per_maker"' };
    seen.add(k);
    if (r.is_default && !r.archived) {
      if (defaults.has(r.item_id)) return { message: 'duplicate key value violates unique constraint "price_list_item_options_one_default"' };
      defaults.add(r.item_id);
    }
  }
  return null;
}

function fakeClient() {
  return {
    from(table: string) {
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | null = null;
      let wantRows = false;
      const filters: ((r: Row) => boolean)[] = [];
      const run = (): { data: any; error: any } => {
        const all = (db.tables[table] ??= []);
        const hit = all.filter((r) => filters.every((f) => f(r)));
        if (op === "select") return { data: hit.map((r) => ({ ...r })), error: null };
        const failed = db.fail?.(table, op, payload, hit) ?? null;
        if (failed) return { data: null, error: failed };
        if (op === "insert") {
          const row = { id: `${table}-${all.length + 1}-${Math.random().toString(36).slice(2, 6)}`, org_id: "org-1", archived: false, is_default: false, ...payload };
          const err = uniqueViolation(table, [...all, row]);
          if (err) return { data: null, error: err };
          all.push(row);
          return { data: wantRows ? [{ ...row }] : null, error: null };
        }
        if (op === "update") {
          const next = all.map((r) => (hit.includes(r) ? { ...r, ...payload } : r));
          const err = uniqueViolation(table, next);
          if (err) return { data: null, error: err };
          for (const r of hit) Object.assign(r, payload);
          return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        db.tables[table] = all.filter((r) => !hit.includes(r));
        return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
      };
      const chain: any = {
        select() {
          wantRows = true;
          return chain;
        },
        insert(p: Row) {
          op = "insert";
          payload = p;
          return chain;
        },
        update(p: Row) {
          op = "update";
          payload = p;
          return chain;
        },
        delete() {
          op = "delete";
          return chain;
        },
        eq(col: string, v: unknown) {
          filters.push((r) => r[col] === v);
          return chain;
        },
        neq(col: string, v: unknown) {
          filters.push((r) => r[col] !== v);
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
          return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
        },
        single: async () => {
          const r = run();
          return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
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
  requireStaff: vi.fn(async () => ({ supabase: fakeClient(), orgId: "org-1", userId: "user-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./vendor-db", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  knownVendorNamesFor: vi.fn(async () => []),
}));
vi.mock("server-only", () => ({}));

import { addItemOption, deletePriceItem, setDefaultItemOption } from "./actions";
import { saveVendorField } from "./vendor-actions";
import { linkKitItem } from "./kit-actions";
import { kitLineView } from "@/lib/kit-line";

const opt = (over: Row) => ({ org_id: "org-1", item_id: "item-830", label: null, archived: false, is_default: false, buy_price: 1000, sort_order: 1, ...over });
const seat = () => (db.tables.price_list_item_options ?? []).filter((o) => o.is_default && !o.archived).map((o) => o.vendor);

beforeEach(() => {
  db.fail = null;
  db.tables = {
    price_list_items: [{ id: "item-830", org_id: "org-1", code: "830", description: "Windows" }],
    price_list_item_options: [
      opt({ id: "o-milgard", vendor: "Milgard", is_default: true }),
      opt({ id: "o-andersen", vendor: "Andersen", archived: true }),
    ],
    price_list_vendors: [],
  };
});

describe("Make Default never empties the seat by accident (VP3)", () => {
  it("a refused add (the vendor is already on the item, archived) leaves the sitting default in its seat", async () => {
    const res = await addItemOption({ itemId: "item-830", vendor: "Andersen", buyPrice: "900", isDefault: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Andersen is archived on this item/);
    expect(seat()).toEqual(["Milgard"]);
  });

  it("a new vendor added as the default takes the seat, and the old one stands down", async () => {
    const res = await addItemOption({ itemId: "item-830", vendor: "Marvin", buyPrice: "1610", isDefault: true });
    expect(res.ok).toBe(true);
    expect(seat()).toEqual(["Marvin"]);
    expect(res.note).toMatch(/default for this code/);
  });

  it("added, but the seat didn't move: it says so, and Milgard is put back", async () => {
    let seatWrites = 0;
    db.fail = (table, op, payload, rows) => {
      if (table === "price_list_item_options" && op === "update" && payload?.is_default === true && rows.some((r) => r.vendor === "Marvin")) {
        seatWrites++;
        return { message: "canceling statement due to statement timeout" };
      }
      return null;
    };
    const res = await addItemOption({ itemId: "item-830", vendor: "Marvin", buyPrice: "1610", isDefault: true });
    expect(seatWrites).toBe(1);
    expect(res.ok).toBe(true); // Marvin IS on the item
    expect(res.note).toMatch(/Added, but it isn't the default yet/);
    expect(res.note).toMatch(/Milgard is still the default/);
    expect(seat()).toEqual(["Milgard"]);
  });

  it("Make Default that fails puts the sitting default back and names it", async () => {
    db.tables.price_list_item_options.push(opt({ id: "o-marvin", vendor: "Marvin" }));
    db.fail = (table, op, payload, rows) =>
      table === "price_list_item_options" && op === "update" && payload?.is_default === true && rows.some((r) => r.id === "o-marvin")
        ? { message: "permission denied" }
        : null;
    const res = await setDefaultItemOption({ itemId: "item-830", optionId: "o-marvin" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Milgard is still the default/);
    expect(seat()).toEqual(["Milgard"]);
  });

  it("back to the item's own price is one statement and says so", async () => {
    const res = await setDefaultItemOption({ itemId: "item-830", optionId: null });
    expect(res).toEqual({ ok: true, note: "This item is priced at its own number again." });
    expect(seat()).toEqual([]);
  });
});

describe("renaming a vendor is all or nothing (VP4)", () => {
  it("when the items can't take the new name, the card goes back too and nothing is renamed", async () => {
    db.tables.price_list_vendors.push({ id: "card-1", org_id: "org-1", name: "Milgard", archived: false });
    db.fail = (table, op, payload) => (table === "price_list_item_options" && op === "update" && payload?.vendor === "Milgard Windows" ? { message: "connection reset" } : null);
    const res = await saveVendorField({ name: "Milgard", field: "name", value: "Milgard Windows" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing was renamed: Milgard is still Milgard everywhere/);
    expect(db.tables.price_list_vendors[0].name).toBe("Milgard");
    expect(db.tables.price_list_item_options.find((o) => o.id === "o-milgard")!.vendor).toBe("Milgard");
    // …and the retry the sentence invites is not refused as "already a vendor".
    db.fail = null;
    const again = await saveVendorField({ name: "Milgard", field: "name", value: "Milgard Windows" });
    expect(again.ok).toBe(true);
    expect(db.tables.price_list_vendors[0].name).toBe("Milgard Windows");
  });
});

describe("Delete For Good and the vendors under the item (VP5)", () => {
  it("a live item with a live vendor is refused, names the live vendors, and points at Archive", async () => {
    const res = await deletePriceItem("item-830", { vendorPricesNamed: 2 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/has a vendor under it \(Milgard\)/);
    expect(res.error).toMatch(/Archive it instead/);
    expect(db.tables.price_list_items).toHaveLength(1);
  });

  it("once every vendor is archived, Delete goes ahead after a confirm that named them", async () => {
    db.tables.price_list_item_options[0].archived = true;
    db.tables.price_list_item_options[0].is_default = false;
    expect(await deletePriceItem("item-830", { vendorPricesNamed: 2 })).toEqual({ ok: true });
    expect(db.tables.price_list_items).toHaveLength(0);
  });

  it("an ARCHIVED item is never pointed at an Archive button it doesn't have: it deletes once the confirm named its vendors", async () => {
    db.tables.price_list_items[0].archived = true;
    const unnamed = await deletePriceItem("item-830");
    expect(unnamed.ok).toBe(false);
    expect(unnamed.error).toMatch(/2 vendor prices under it \(Milgard, Andersen\) that the page didn't show you/);
    expect(unnamed.error).not.toMatch(/Archive it instead/);
    expect(db.tables.price_list_items).toHaveLength(1);
    expect(await deletePriceItem("item-830", { vendorPricesNamed: 2 })).toEqual({ ok: true });
    expect(db.tables.price_list_items).toHaveLength(0);
  });

  it("a vendor the confirm didn't name (a stale page) stops the delete and is named", async () => {
    db.tables.price_list_item_options[0].archived = true;
    const res = await deletePriceItem("item-830", { vendorPricesNamed: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Reload the page and Delete again/);
    expect(db.tables.price_list_items).toHaveLength(1);
  });

  it("an item with no vendors deletes as before", async () => {
    db.tables.price_list_item_options = [];
    expect(await deletePriceItem("item-830")).toEqual({ ok: true });
    expect(db.tables.price_list_items).toHaveLength(0);
  });
});

describe("Unlink freezes a kit line at exactly what it showed (VP2 follow-through)", () => {
  it("a code whose default vendor is Marvin freezes at Marvin's words, unit and sell, not the allowance", async () => {
    const book = {
      id: "item-830",
      org_id: "org-1",
      code: "830",
      description: "Windows",
      unit: "ea",
      buy_price: 830,
      markup_pct: 0,
      archived: false,
      price_list_item_options: [
        opt({ id: "o-marvin", vendor: "Marvin", part_number: "M-1", unit: "pair", buy_price: 1610, is_default: true }),
        opt({ id: "o-andersen", vendor: "Andersen", archived: true, buy_price: 900 }),
      ],
    };
    db.tables.price_list_items = [book];
    db.tables.organizations = [{ id: "org-1", settings: { default_markup_pct: 25 } }];
    db.tables.kit_items = [{ id: "line-1", kit_id: "kit-1", description: "stale", unit: "ea", unit_price: 1, quantity: 2, price_list_item_id: "item-830" }];
    const shown = kitLineView({ ...db.tables.kit_items[0], price_list_items: book } as never, { orgDefaultPct: 25 });
    expect(shown.vendor).toBe("Marvin");

    const res = await linkKitItem("line-1", null);
    expect(res.ok).toBe(true);
    const line = db.tables.kit_items[0];
    expect(line.price_list_item_id).toBeNull();
    expect({ description: line.description, unit: line.unit, unit_price: line.unit_price }).toEqual({
      description: shown.description,
      unit: shown.unit,
      unit_price: shown.unit_price,
    });
    expect(line.description).toBe("830 — Windows (Marvin, #M-1)");
    expect(line.unit_price).toBe(2012.5); // 1610 × 1.25, not the $830 allowance
  });
});
