import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  chooseInventoryMatch,
  drawFrom,
  formatPerUnit,
  normaliseName,
  normalisePartNumber,
  provenanceLine,
  splitContainerCost,
  stockInputProblem,
  type MatchCandidate,
  type StockFromReceiptLineInput,
} from "@/lib/stock-flow";

/** The staff guard and the cache tag are the two things a unit test can't have. The guard is
 *  swapped for a holder each test sets, so the "not staff" refusal is testable too. */
const guard = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => guard.ctx }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/* ── THE LINE THAT STARTED THIS ───────────────────────────────────────────────────────────────
   IDEAL 30641, 500 Twister wire nuts, $108.36. On the real row `unit_price` and `amount` are
   both 108.36 and `quantity` reads 500 because the scanner took it out of the product name. */
const TWISTER: StockFromReceiptLineInput = {
  lineId: "line-1",
  description: "IDEAL 30641 500/5000 Twister 341-Tan",
  unitCost: 108.36,
  containerCount: 500,
  vendor: "CED",
  partNumber: "30641",
};

describe("normalising the two keys", () => {
  it("reads every way a supply house writes one part number as the same part", () => {
    expect(normalisePartNumber("30-641")).toBe("30641");
    expect(normalisePartNumber(" 30 641 ")).toBe("30641");
    expect(normalisePartNumber("30641")).toBe("30641");
    expect(normalisePartNumber("wc-4s/1-2")).toBe("WC4S12");
  });

  it("treats blank, missing and punctuation-only as no part number at all", () => {
    expect(normalisePartNumber(null)).toBeNull();
    expect(normalisePartNumber("")).toBeNull();
    expect(normalisePartNumber(" - / ")).toBeNull();
  });

  it("folds case and punctuation in a description but never digits", () => {
    expect(normaliseName("IDEAL 30641 500/5000 Twister 341-Tan")).toBe("IDEAL 30641 500 5000 TWISTER 341 TAN");
    expect(normaliseName("ideal   30641 500/5000 twister 341 tan")).toBe(normaliseName(TWISTER.description));
    // The tan nut and the red nut differ by one digit. They must never normalise together.
    expect(normaliseName("Twister 341-Tan")).not.toBe(normaliseName("Twister 342-Red"));
  });
});

describe("what a nut costs", () => {
  it("carries the true per-unit price at full precision and stores what the column can hold", () => {
    const { perUnit, storedUnitCost } = splitContainerCost(108.36, 500);
    expect(perUnit).toBeCloseTo(0.21672, 10);
    expect(storedUnitCost).toBe(0.22);
    // The whole reason the full-precision figure is kept: multiply the STORED one back out and
    // the box costs $110.00, which is $1.64 Erik never spent.
    expect(perUnit * 500).toBeCloseTo(108.36, 10);
    expect(storedUnitCost! * 500).toBe(110);
  });

  it("refuses to write $0.00 for something that cost money", () => {
    // A 5000-count bag at $12: 24 hundredths of a cent each. numeric(12,2) cannot say that, and
    // "$0.00" on the page reads as free.
    const { perUnit, storedUnitCost } = splitContainerCost(12, 5000);
    expect(perUnit).toBeCloseTo(0.0024, 10);
    expect(storedUnitCost).toBeNull();
  });

  it("keeps a true zero, because a comped box really did cost nothing", () => {
    expect(splitContainerCost(0, 100).storedUnitCost).toBe(0);
  });

  it("writes the per-unit price in words at the precision it actually has", () => {
    expect(formatPerUnit(0.21672)).toBe("$0.2167");
    expect(formatPerUnit(1.5)).toBe("$1.50");
    expect(formatPerUnit(0.0024)).toBe("$0.0024");
    expect(formatPerUnit(12)).toBe("$12.00");
  });

  it("says where it came from in a sentence he can read in a truck", () => {
    expect(provenanceLine({ containerCount: 500, containerCost: 108.36, vendor: "CED" })).toBe(
      "Last bought 500 for $108.36 from CED. That works out to $0.2167 each.",
    );
    expect(provenanceLine({ containerCount: 500, containerCost: 1108.36, vendor: null })).toBe(
      "Last bought 500 for $1,108.36. That works out to $2.2167 each.",
    );
  });
});

describe("the refusals, which have to be sentences he can act on", () => {
  it("will not guess how many are in the container", () => {
    expect(stockInputProblem({ ...TWISTER, containerCount: 0 })).toBe(
      "Say how many the container holds before this becomes stock.",
    );
    expect(stockInputProblem({ ...TWISTER, containerCount: Number.NaN })).toBeTruthy();
    expect(stockInputProblem({ ...TWISTER, containerCount: 2_000_000 })).toContain("too big");
  });

  it("will not name a stock item after an empty line", () => {
    expect(stockInputProblem({ ...TWISTER, description: "   " })).toContain("no description");
  });

  it("lets the real line through", () => {
    expect(stockInputProblem(TWISTER)).toBeNull();
  });
});

describe("the second box lands on the first box's row", () => {
  const nuts: MatchCandidate = {
    id: "inv-nuts",
    name: "IDEAL 30641 500/5000 Twister 341-Tan",
    part_number: "30-641",
    created_at: "2026-09-01T00:00:00Z",
  };

  it("matches on the part number however either side punctuates it", () => {
    expect(chooseInventoryMatch([nuts], { partNumber: "30641", description: "Twister nuts, tan" })).toEqual({
      kind: "match",
      id: "inv-nuts",
      why: "same part number",
    });
  });

  it("NEVER merges two different part numbers, however alike the names read", () => {
    const red = { ...nuts, id: "inv-red", part_number: "30644" };
    const decision = chooseInventoryMatch([red], {
      partNumber: "30641",
      description: "IDEAL 30641 500/5000 Twister 341-Tan",
    });
    // A bad merge is one row holding the sum of two products, and nothing on the page shows it.
    // A twin is two rows he can see. When in doubt, make the visible mistake.
    expect(decision.kind).toBe("create");
  });

  it("adopts a row that carries no part number of its own, and says why", () => {
    const handTyped = { ...nuts, id: "inv-typed", part_number: null };
    expect(chooseInventoryMatch([handTyped], { partNumber: "30641", description: nuts.name })).toMatchObject({
      kind: "match",
      id: "inv-typed",
    });
  });

  it("matches on the exact name when neither side has a part number", () => {
    const handTyped = { ...nuts, id: "inv-typed", part_number: null };
    expect(chooseInventoryMatch([handTyped], { partNumber: null, description: "ideal 30641 500/5000 twister 341-tan" })).toMatchObject({
      kind: "match",
      id: "inv-typed",
    });
    expect(chooseInventoryMatch([handTyped], { partNumber: null, description: "Wire nuts" }).kind).toBe("create");
  });

  it("adds to the oldest of existing twins rather than making a third", () => {
    const older = { ...nuts, id: "inv-older", created_at: "2026-08-01T00:00:00Z" };
    const newer = { ...nuts, id: "inv-newer", created_at: "2026-09-15T00:00:00Z" };
    expect(chooseInventoryMatch([newer, older], { partNumber: "30641", description: nuts.name })).toMatchObject({
      kind: "match",
      id: "inv-older",
    });
  });

  it("creates when the shelf is empty, which is where Erik starts", () => {
    expect(chooseInventoryMatch([], { partNumber: "30641", description: nuts.name }).kind).toBe("create");
  });
});

describe("taking stock out", () => {
  it("says what is left", () => {
    expect(drawFrom(500, 40)).toEqual({ ok: true, remaining: 460 });
    expect(drawFrom(500, 500)).toEqual({ ok: true, remaining: 0 });
  });

  it("refuses a draw bigger than the shelf, and says the real number", () => {
    const res = drawFrom(40, 60);
    expect(res.ok).toBe(false);
    // Not a silent clamp to zero: the next thing he does with this number is order against it.
    expect(res.ok === false && res.error).toBe("There are only 40 left, so 60 can't come out.");
    expect(drawFrom(0, 1).ok === false && drawFrom(0, 1)).toMatchObject({ error: expect.stringContaining("none of this left") });
    expect(drawFrom(1, 2).ok === false && drawFrom(1, 2)).toMatchObject({ error: expect.stringContaining("is only 1 left") });
  });

  it("will not take out nothing, or a number that isn't one", () => {
    expect(drawFrom(500, 0)).toEqual({ ok: false, error: "Say how many to take out." });
    expect(drawFrom(500, -5).ok).toBe(false);
    expect(drawFrom(500, Number.NaN).ok).toBe(false);
  });

  it("does not leave a hundredth of a nut behind on a fractional unit", () => {
    expect(drawFrom(2.5, 0.75)).toEqual({ ok: true, remaining: 1.75 });
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE SERVER HALF, against an in-memory PostgREST. These exist because the two waves before this
   one each shipped something that typechecked and was never called: "it compiles" is not evidence
   that a row moved.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

type Row = Record<string, unknown>;

/** A small PostgREST fake: `.eq()` filters really filter, `.update()` really writes, `.insert()`
 *  really appends, and `.select("id")` after a write hands back the rows that matched - which is
 *  the whole point, since the silent-write law turns on zero rows coming back. */
function fakeDb(tables: Record<string, Row[]>, fail: Record<string, string> = {}) {
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let op: "select" | "update" | "insert" = "select";
      let patch: Row = {};
      let incoming: Row[] = [];
      const rows = () => (tables[table] ??= []);
      const matches = (r: Row) => filters.every(([k, v]) => String(r[k]) === String(v));
      let ran = false;
      const run = () => {
        if (ran) return [] as Row[];
        ran = true;
        if (op === "update") {
          const hit = rows().filter(matches);
          hit.forEach((r) => Object.assign(r, patch));
          return hit;
        }
        if (op === "insert") {
          incoming.forEach((r, i) => rows().push({ id: `new-${rows().length + i + 1}`, ...r }));
          return rows().slice(-incoming.length);
        }
        return rows().filter(matches);
      };
      const result = () => {
        const key = `${table}.${op}`;
        if (fail[key]) return { data: null, error: { message: fail[key] } };
        return { data: run(), error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return builder;
        },
        update: (p: Row) => {
          op = "update";
          patch = p;
          return builder;
        },
        insert: (v: Row | Row[]) => {
          op = "insert";
          incoming = Array.isArray(v) ? v : [v];
          return builder;
        },
        maybeSingle: async () => {
          const r = result();
          return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error };
        },
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, err),
      };
      return builder;
    },
  };
  return client;
}

/** The receipt line as PostgREST hands it over: numerics are STRINGS. */
const receiptLine = () => ({ id: "line-1", org_id: "org-1", is_stock: false, amount: "108.36" });

async function stockIt(tables: Record<string, Row[]>, fail?: Record<string, string>, input = TWISTER) {
  const { stockFromReceiptLine } = await import("@/lib/stock-flow");
  guard.ctx = { supabase: fakeDb(tables, fail), userId: "u1", orgId: "org-1" };
  return stockFromReceiptLine(input);
}

describe("a receipt line becoming stock", () => {
  beforeEach(() => {
    guard.ctx = null;
  });

  it("puts 500 nuts on a new row at the price he paid, and marks the line", async () => {
    const tables: Record<string, Row[]> = { bill_line_items: [receiptLine()], inventory_items: [] };
    const res = await stockIt(tables);
    expect(res).toMatchObject({ ok: true });
    const item = tables.inventory_items[0];
    expect(item.quantity_on_hand).toBe(500);
    expect(item.unit_cost).toBe(0.22);
    expect(item.vendor).toBe("CED");
    expect(item.part_number).toBe("30641");
    // The cent the column cannot hold survives here, in words.
    expect(item.description).toBe("Last bought 500 for $108.36 from CED. That works out to $0.2167 each.");
    expect(tables.bill_line_items[0].is_stock).toBe(true);
  });

  it("adds the second box to the first box's row instead of making a twin", async () => {
    const tables: Record<string, Row[]> = {
      bill_line_items: [{ ...receiptLine(), id: "line-2" }],
      // quantity_on_hand as a string on purpose. The Supabase client is untyped, so a string can
      // reach the addition, and "460" + 500 is "460500" - the bug this assertion exists to catch.
      inventory_items: [
        {
          id: "inv-nuts",
          org_id: "org-1",
          active: true,
          name: "IDEAL 30641 500/5000 Twister 341-Tan",
          part_number: "30641",
          quantity_on_hand: "460.00",
          vendor: "CED",
        },
      ],
    };
    const res = await stockIt(tables, undefined, { ...TWISTER, lineId: "line-2" });
    expect(res).toEqual({ ok: true, inventoryItemId: "inv-nuts" });
    expect(tables.inventory_items).toHaveLength(1);
    expect(tables.inventory_items[0].quantity_on_hand).toBe(960);
  });

  it("counts a line once, however many times the button is tapped", async () => {
    const tables: Record<string, Row[]> = { bill_line_items: [receiptLine()], inventory_items: [] };
    await stockIt(tables);
    const again = await stockIt(tables);
    expect(again).toEqual({ ok: false, error: "That line is already counted into stock, so nothing was added a second time." });
    // One row, 500 on it. The claim is the update itself, so the second tap never gets past it.
    expect(tables.inventory_items).toHaveLength(1);
    expect(tables.inventory_items[0].quantity_on_hand).toBe(500);
  });

  it("hands the line back when the stock itself fails to save", async () => {
    const tables: Record<string, Row[]> = { bill_line_items: [receiptLine()], inventory_items: [] };
    const res = await stockIt(tables, { "inventory_items.insert": "boom" });
    expect(res.ok).toBe(false);
    // A line marked as stock with no stock behind it is a hole nothing on any page can see.
    expect(tables.bill_line_items[0].is_stock).toBe(false);
    expect(tables.inventory_items).toHaveLength(0);
  });

  it("says which of the two zero-row reasons it was", async () => {
    const tables: Record<string, Row[]> = { bill_line_items: [], inventory_items: [] };
    const res = await stockIt(tables);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("isn't there any more") });
  });

  it("refuses before touching anything when nobody confirmed the count", async () => {
    const tables: Record<string, Row[]> = { bill_line_items: [receiptLine()], inventory_items: [] };
    const res = await stockIt(tables, undefined, { ...TWISTER, containerCount: 0 });
    expect(res.ok).toBe(false);
    expect(tables.bill_line_items[0].is_stock).toBe(false);
  });

  it("is staff-only", async () => {
    const { stockFromReceiptLine } = await import("@/lib/stock-flow");
    guard.ctx = { error: "This action is staff-only." };
    expect(await stockFromReceiptLine(TWISTER)).toEqual({ ok: false, error: "This action is staff-only." });
  });
});

describe("drawing stock for a job", () => {
  async function draw(tables: Record<string, Row[]>, quantity: number) {
    const { drawStockForJob } = await import("@/lib/stock-flow");
    guard.ctx = { supabase: fakeDb(tables), userId: "u1", orgId: "org-1" };
    return drawStockForJob({ inventoryItemId: "inv-nuts", quantity, note: "Waldow panel" });
  }
  const shelf = (): Record<string, Row[]> => ({
    inventory_items: [{ id: "inv-nuts", org_id: "org-1", active: true, name: "Twister", quantity_on_hand: "500.00" }],
  });

  it("takes the nuts off and says what is left", async () => {
    const tables = shelf();
    expect(await draw(tables, 40)).toEqual({ ok: true, remaining: 460 });
    expect(tables.inventory_items[0].quantity_on_hand).toBe(460);
  });

  it("refuses an over-draw and leaves the count alone", async () => {
    const tables = shelf();
    const res = await draw(tables, 600);
    expect(res).toEqual({ ok: false, error: "There are only 500 left, so 600 can't come out." });
    expect(tables.inventory_items[0].quantity_on_hand).toBe("500.00");
  });

  it("says so when the item is gone rather than writing into nothing", async () => {
    const res = await draw({ inventory_items: [] }, 1);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("isn't there any more") });
  });
});
