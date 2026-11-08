import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasItemOptions, itemOptionChoices, normalizeItemOptions } from "@/lib/pricing/item-options";
import { addLineAsk, lineQuantity, typedLine } from "@/lib/invoice-math";
import { words as qt } from "@/lib/words/quotes";
import { NumberInput } from "@/components/ui/number-input";
import { AddLineItems } from "./add-line-items";

/**
 * THE DOOR, PINNED. The wave that built price_list_item_options wrote the table, a server action
 * and a pure resolver, and wired none of them to a screen - every quote still priced at the
 * allowance while the price-list tab said the item now priced at Marvin. AddLineItems is the one
 * component both quote screens and the PO screen add a price-list line through, so these assert
 * the shape that component now renders from.
 *
 * The fixture is Vivian Builders' real item: code 830, "Windows (Materials) (Allowance)", $830.00,
 * markup 0, unit ea - read from the live database on 2026-09-20.
 */
const item830 = {
  id: "vb-830",
  code: "830",
  description: "Windows (Materials) (Allowance)",
  unit: "ea",
  buy_price: 830,
  markup_pct: 0,
  price_list_item_options: [
    { id: "o-and", vendor: "Andersen", label: "400 Series", part_number: null, unit: null, buy_price: 1240, markup_pct: null, is_default: true, sort_order: 0 },
    { id: "o-mil", vendor: "Milgard", label: "Tuscany", part_number: null, unit: null, buy_price: 910, markup_pct: null, is_default: false, sort_order: 1 },
    { id: "o-mar", vendor: "Marvin", label: null, part_number: null, unit: null, buy_price: 1615, markup_pct: null, is_default: false, sort_order: 2 },
  ],
};

describe("the maker rows AddLineItems renders", () => {
  it("offers the allowance first, then every maker in the org's order", () => {
    const rows = itemOptionChoices(item830 as never, { orgDefaultPct: 20 });
    expect(rows.map((r) => r.makerLabel)).toEqual([
      "No Vendor Picked",
      "Andersen 400 Series",
      "Milgard Tuscany",
      "Marvin",
    ]);
  });

  it("puts the maker in the description, because that is what the customer reads", () => {
    const rows = itemOptionChoices(item830 as never, { orgDefaultPct: 20 });
    expect(rows[1].description).toContain("Andersen 400 Series");
    expect(rows[0].description).not.toContain("Andersen");
  });

  it("prices each maker off its OWN cost through the org markup, not the allowance", () => {
    const rows = itemOptionChoices(item830 as never, { orgDefaultPct: 20 });
    expect(rows[0].unitPrice).toBe(996); // 830 allowance + 20%
    expect(rows[1].unitPrice).toBe(1488); // 1240 Andersen + 20%
    expect(rows[3].unitPrice).toBe(1938); // 1615 Marvin + 20%
  });

  it("lets the customer's pricing level outrank the org default, as it does everywhere else", () => {
    const rows = itemOptionChoices(item830 as never, { levelPct: 10, orgDefaultPct: 20 });
    expect(rows[1].unitPrice).toBe(1364); // 1240 + 10%, the level wins
  });

  it("marks the one the office flagged, so the list opens on an answer", () => {
    const rows = itemOptionChoices(item830 as never, {});
    expect(rows.filter((r) => r.isDefault).map((r) => r.makerLabel)).toEqual(["Andersen 400 Series"]);
  });

  it("leaves an item with no makers exactly as it was", () => {
    const plain = { id: "x", code: "835", description: "Windows (Installation)", unit: "ea", buy_price: 835, markup_pct: 0 };
    expect(hasItemOptions(plain as never)).toBe(false);
    expect(normalizeItemOptions(undefined)).toEqual([]);
    // One row, the item's own, which is why the picker can add it on the first tap as before.
    expect(itemOptionChoices(plain as never, { orgDefaultPct: 20 })).toHaveLength(1);
  });

  it("does not offer a maker that was archived since the page rendered", () => {
    // The embed filters archived rows, but a stale page is the real case: normalizeItemOptions is
    // what both the picker and the server action read, so it has to agree with the database.
    const withArchived = {
      ...item830,
      price_list_item_options: [...item830.price_list_item_options, { id: "o-old", vendor: "Pella", label: null, part_number: null, unit: null, buy_price: 700, markup_pct: null, is_default: false, sort_order: 3, archived: true }],
    };
    expect(itemOptionChoices(withArchived as never, {}).map((r) => r.makerLabel)).not.toContain("Pella");
  });
});


/**
 * THE TYPED LINE (cn-v1152). Erik, 2026-11-07, on an invoice: "add from pricelist should be with or
 * integrated into the add a line item on the bottom". The invoice page drew this picker above its table
 * and its own hand-typed row under it; given `typed`, the picker's box is the row's description box and
 * the row is drawn under it. Three things are pinned here: without `typed` the component renders BYTE FOR
 * BYTE what it rendered before this wave (the estimate editor's picker is unchanged); with `typed` the one
 * box is the line's and the row follows; and the rules a typed line follows, in the source and the lib.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const pricing = { levelPct: null, orgDefaultPct: 20 };
const book = [
  { id: "p-1", code: "110", description: "Service Call", unit: "ea", buy_price: 100, markup_pct: 0 },
  { id: "p-2", code: "120", description: "Wire 12/2 Romex", unit: "roll", buy_price: 80, markup_pct: 25, supplier: "Snowbell Electric Supply" },
];
const kits = [{ id: "k-1", name: "Panel Swap", kit_items: [{ id: "ki-1" }, { id: "ki-2" }] }];
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AddLineItems, { pricing, onAdd: () => {}, ...props } as never));
/** The <button> that holds the Add label, its class list taken off (Tailwind writes "disabled:" into class names). */
const addButton = (out: string) => {
  const at = out.indexOf(" Add</button>");
  expect(at, "the row must be drawn").toBeGreaterThan(-1);
  return out.slice(out.lastIndexOf("<button", at), at).replace(/ class="[^"]*"/g, "");
};
/** The one box's <input …/> tag, its class list taken off (the same "disabled:" trap). */
const boxTag = (out: string) => {
  const at = out.indexOf('aria-label="What this charge is for"');
  expect(at, "the box must be drawn").toBeGreaterThan(-1);
  return out.slice(out.lastIndexOf("<input", at), out.indexOf("/>", at) + 2).replace(/ class="[^"]*"/g, "");
};

describe("without `typed`, the picker is byte for byte what the estimate editor has always drawn", () => {
  // Captured from the component at 54621ab7 (cn-v1151), before the typed row existed, with these same
  // fixtures and props. A difference here is a difference on the estimate editor's screen.
  const BEFORE = {
    full: "<div class=\"\"><div class=\"relative mb-3\"><input autoComplete=\"off\" data-1p-ignore=\"\" data-lpignore=\"true\" class=\"flex h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-50\" placeholder=\"Add from Price List — tap to browse, or search…\" value=\"\"/></div><div class=\"mb-3\"><p class=\"mb-1.5 text-xs font-medium text-slate-500\">Add from a list</p><div class=\"flex flex-wrap gap-2\"><button type=\"button\" class=\"inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-list-plus h-3.5 w-3.5\"><path d=\"M11 12H3\"></path><path d=\"M16 6H3\"></path><path d=\"M16 18H3\"></path><path d=\"M18 9v6\"></path><path d=\"M21 12h-6\"></path></svg>Panel Swap<span class=\"text-xs font-normal text-slate-400\">2</span></button></div></div></div>",
    noKits: "<div class=\"mb-2\"><div class=\"relative mb-3\"><input autoComplete=\"off\" data-1p-ignore=\"\" data-lpignore=\"true\" class=\"flex h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-50\" placeholder=\"Add from Price List — tap to browse, or search…\" disabled=\"\" value=\"\"/></div></div>",
    kitsOnly: "<div class=\"\"><div class=\"mb-3\"><p class=\"mb-1.5 text-xs font-medium text-slate-500\">Add from a list</p><div class=\"flex flex-wrap gap-2\"><button type=\"button\" class=\"inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-list-plus h-3.5 w-3.5\"><path d=\"M11 12H3\"></path><path d=\"M16 6H3\"></path><path d=\"M16 18H3\"></path><path d=\"M18 9v6\"></path><path d=\"M21 12h-6\"></path></svg>Panel Swap<span class=\"text-xs font-normal text-slate-400\">2</span></button></div></div></div>",
  };
  it("a book and a kit", () => {
    expect(html({ priceItems: book, kits })).toBe(BEFORE.full);
  });
  it("a book alone, waiting on a write, with a class of its own", () => {
    expect(html({ priceItems: book, kits: [], disabled: true, className: "mb-2" })).toBe(BEFORE.noKits);
  });
  it("kits alone", () => {
    expect(html({ priceItems: [], kits })).toBe(BEFORE.kitsOnly);
  });
  it("nothing to pick from: nothing drawn", () => {
    expect(html({ priceItems: [], kits: [] })).toBe("");
  });
  it("the estimate editor hands it no typed row", () => {
    const editor = read("src/app/(app)/quotes/estimate-editor.tsx");
    expect(editor).toContain("<AddLineItems priceItems={priceItems} kits={kits as never} pricing={pricing} measured={measured} disabled={busy} onAdd={(lines) => void session.addLines(lines)} />");
    expect(editor).not.toContain("typed=");
  });
});

describe("with `typed`, the one box is the line's box and the row sits under it", () => {
  const typed = { ask: addLineAsk };
  it("with a book the box names both doors, and the row follows it: Qty · unit · × · Price · Add, then the kit chips", () => {
    const out = html({ priceItems: book, kits, typed });
    expect(out).toContain('placeholder="Add a line item — type it, or pick from the Price List…"');
    expect(out).not.toContain("Add from Price List");
    const order = ['aria-label="What this charge is for"', 'placeholder="Qty"', 'placeholder="unit"', ">×<", 'placeholder="Price"', " Add</button>", "Add from a list"];
    const at = order.map((piece) => out.indexOf(piece));
    for (const [i, found] of at.entries()) expect(found, order[i]).toBeGreaterThan(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // ONE description box: the picker's. Four inputs in all - the box, Qty, unit, Price.
    expect((out.match(/<input/g) ?? []).length).toBe(4);
    // The unit box suggests from the page's one list (lib/pricing/units UNIT_DATALIST_ID).
    expect(out).toMatch(/placeholder="unit"[^>]*list="cn-units"/);
  });
  it("no book and no kits: the box says only that the line is typed, and the row is still drawn - a blank invoice has nothing else", () => {
    const out = html({ priceItems: [], kits: [], typed });
    expect(out).toContain('placeholder="Add a line item…"');
    expect(out).toContain('placeholder="Price"');
    expect(out).toContain(" Add</button>");
    expect(out).not.toContain("Add from a list");
  });
  it("Add is pressable with the row empty (44aeec9c); it waits only while the page's save is on the wire, and the box never waits", () => {
    expect(addButton(html({ priceItems: book, typed }))).not.toContain("disabled");
    const saving = html({ priceItems: book, typed: { ...typed, saving: true } });
    expect(addButton(saving)).toContain("disabled");
    expect(boxTag(saving)).not.toContain("disabled");
  });
  it("the ask is not said before he has typed a figure, changed the count or pressed Add", () => {
    const out = html({ priceItems: book, typed });
    expect(out).not.toContain("Type what this charge is for");
    expect(out).not.toContain("Type the price");
  });
});

describe("the typed row's rules, pinned in the source", () => {
  const picker = read("src/components/add-line-items.tsx");
  it("Enter in the box or in any box of the row, and the Add button, add the typed line through the ONE onAdd", () => {
    expect(picker).toContain('const onRowEnter = (e: { key: string }) => e.key === "Enter" && void addTyped();');
    expect(picker).toContain("onKeyDown={typed ? onRowEnter : undefined}");
    expect((picker.match(/onKeyDown=\{onRowEnter\}/g) ?? []).length).toBe(3);
    expect(picker).toContain("<Button onClick={() => void addTyped()} disabled={disabled || typed.saving}>");
    expect(picker).toContain("const landed = await onAdd([typedLine({ words: query, qty, unit, price })]);");
    // A line the server refused keeps its words; a saved one starts the row over and the cursor stays in the box.
    expect(picker).toContain("if (landed === false) return;");
    expect(picker).toMatch(/if \(landed === false\) return;[^\n]*\n\s*resetRow\(\);\s*box\.current\?\.focus\(\);/);
    // Enter while the save is on the wire is nothing, like the greyed button.
    expect(picker).toContain("if (!typed || typed.saving) return;");
  });
  it("a box missing: the ask is said under the row in the catalog's words, and the cursor goes to THAT box, by the invoice page's own rule for when", () => {
    expect(picker).toContain("const missing = typed ? typed.ask({ words: query, price }) : null;");
    expect(picker).toContain('const missingLine = missing === "words" ? t("qt_askWords") : missing === "price" ? t("qt_askPrice") : null;');
    expect(picker).toContain("const sayMissing = !!missing && (price !== null || qty !== 1 || askPressed);");
    // The words' box for the words, the Price box for a price nobody typed (skeptic #56b: Enter on "wire" put a $0 line on).
    expect(picker).toMatch(/if \(missing\) \{[^}]*setAskPressed\(true\);\s*\(missing === "price" \? priceBox : box\)\.current\?\.focus\(\);\s*return;/);
    expect(picker).toContain('{typed && sayMissing && <p className="mt-2 text-xs text-amber-700">{missingLine}</p>}');
    // The Price box is blank (null), not 0, until a figure is typed; the box says which, and the cursor can be put in it.
    expect(picker).toContain("const [price, setPrice] = useState<number | null>(null);");
    expect(picker).toContain("<NumberInput ref={priceBox} value={price} onValueChange={(n, blank) => setPrice(blank ? null : n)}");
  });
  it("a pick adds at once, at THE price, with the row's Qty (skeptic #56b); a kit is its own count; the row starts over after any add", () => {
    expect(picker).toContain("const line = priceBookLine(p, pricing);");
    expect(picker).toContain("onAdd([{ description: line.description, quantity: lineQuantity(qty), unit: line.unit, unit_price: line.unitPrice, ...(kind ? { kind } : {}) }]);");
    expect(picker).toContain("onAdd([{ description: choice.description, quantity: lineQuantity(qty), unit: choice.unit, unit_price: choice.unitPrice, ...(kind ? { kind } : {}) }]);");
    // The kit's lines go on as the picker sized them - `lines`, untouched - and then the row resets.
    expect(picker).toMatch(/onAdd=\{\(lines\) => \{[^}]*onAdd\(lines\);\s*setPickerKit\(null\);\s*resetRow\(\);/);
    // One reset behind all four doors: the words gone, Qty 1, unit ea, the price blank, the ask quiet, the list closed.
    expect(picker).toMatch(/const resetRow = \(\) => \{\s*setQuery\(""\);\s*setQty\(1\);\s*setUnit\("ea"\);\s*setPrice\(null\);\s*setAskPressed\(false\);\s*setOpen\(false\);\s*\};/);
    expect((picker.match(/resetRow\(\);/g) ?? []).length).toBe(4);
    // The book's dropdown opens only when there is a book; with a typed row and none, the box is the line's alone.
    expect(picker).toContain("{open && priceItems.length > 0 && (");
    expect(picker).toContain("if (!typed && !priceItems.length && !kits.length) return null;");
  });
  it("the invoice page draws ONE picker, in the bottom box, with the typed row and the one save loop; its own box and row are gone", () => {
    const page = read("src/app/(app)/billing/[id]/invoice-detail.tsx");
    expect((page.match(/<AddLineItems/g) ?? []).length).toBe(1);
    expect(page).toContain("typed={{ ask: addLineAsk, saving: pending }}");
    expect(page).toContain("new Promise<boolean>((landed) =>");
    expect(page).toContain("landed(false);");
    expect(page).toContain("landed(true);");
    for (const gone of ['placeholder="Add a line item…"', "descBox", "needsDesc", "function addItem(", "export function addLineAsk"]) expect(page, gone).not.toContain(gone);
    // Inside the bottom box, and the discount door follows it in the same box.
    const box = page.indexOf('<div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3">');
    const at = page.indexOf("<AddLineItems", box);
    const discount = page.indexOf("Add a Discount", at);
    expect(box).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(box);
    expect(discount).toBeGreaterThan(at);
    // The one unit list: drawn once, under the lib's id, for the line editor and the row alike.
    expect(page).toContain("<datalist id={UNIT_DATALIST_ID}>");
    expect(page).not.toContain('"cn-units"');
  });
});

describe("what a typed row becomes (lib/invoice-math typedLine), what it is still missing (addLineAsk), the count a pick takes (lineQuantity), and the row's words", () => {
  it("the words trimmed, a count of at least one, the unit as typed, the price or 0", () => {
    expect(typedLine({ words: " Service call ", qty: 0, unit: "ea", price: 0 })).toEqual({ description: "Service call", quantity: 1, unit: "ea", unit_price: 0 });
    expect(typedLine({ words: "Trenching", qty: 3, unit: "hr", price: 95 })).toEqual({ description: "Trenching", quantity: 3, unit: "hr", unit_price: 95 });
  });
  it("which box is missing: the words first, then a price nobody typed; a 0 typed on purpose is a no-charge line and goes on (skeptic #56b)", () => {
    expect(addLineAsk({ words: "", price: null })).toBe("words");
    expect(addLineAsk({ words: "  ", price: 95 })).toBe("words");
    expect(addLineAsk({ words: "wire", price: null })).toBe("price");
    expect(addLineAsk({ words: "Service call", price: 0 })).toBeNull();
    expect(addLineAsk({ words: "Service call", price: 95 })).toBeNull();
  });
  it("Qty 5 and a tap on a book row put five on; a blank or a 0 in the box is one", () => {
    expect(lineQuantity(5)).toBe(5);
    expect(lineQuantity(0)).toBe(1);
    expect(lineQuantity(NaN)).toBe(1);
  });
  it("the row's words are the catalog's, in both languages (the component is on a Spanish seat's billing too)", () => {
    for (const k of ["qt_addLineOrPick", "qt_addALineItem", "qt_whatThisChargeIsFor", "qt_qty", "qt_unitPh", "qt_unitAria", "qt_price", "qt_btn_add", "qt_askWords", "qt_askPrice"]) {
      expect(qt.en[k], k).toBeTruthy();
      expect(qt.es[k], k).toBeTruthy();
      expect(qt.es[k], k).not.toBe(qt.en[k]);
    }
    expect(qt.en.qt_btn_add).toBe("Add");
    expect(qt.es.qt_btn_add).toBe("Agregar");
    expect(qt.en.qt_addALineItem).toBe("Add a line item…");
    // The two asks, the sentences a person reads under the row.
    expect(qt.en.qt_askWords).toBe("Type what this charge is for in the box above, then tap Add.");
    expect(qt.en.qt_askPrice).toBe("Type the price, or 0 if there's no charge, then tap Add.");
  });
});

/**
 * THE PRICE BOX TELLS A BLANK FROM A TYPED 0 (skeptic #56b). NumberInput reported 0 for an empty box and
 * for a typed "0" alike, so the row could not ask for a price without refusing a no-charge line; it now
 * takes null for a blank box, says beside the figure whether the box is blank, and empties a typed "0"
 * when the row resets to null (a 0 would have left it standing).
 */
describe("the Price box tells a blank from a typed 0 (components/ui/number-input)", () => {
  const field = read("src/components/ui/number-input.tsx");
  it("null draws a blank box, as 0 does; a figure draws itself", () => {
    const draw = (value: number | null) => renderToStaticMarkup(createElement(NumberInput, { value, onValueChange: () => {} }));
    expect(draw(null)).toContain('value=""');
    expect(draw(0)).toContain('value=""');
    expect(draw(12.5)).toContain('value="12.5"');
  });
  it("the box says whether it is blank beside the figure, and a null from the outside empties a typed \"0\"", () => {
    expect(field).toContain('const blank = v === "" || v === ".";');
    expect(field).toContain("onValueChange(blank ? 0 : Number(v), blank);");
    expect(field).toMatch(/if \(value === null\) \{[^}]*if \(text !== ""\) setText\(""\);\s*return;\s*\}/);
  });
});
