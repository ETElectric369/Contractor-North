import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupInvoiceLines, isDiscountLine, canBeDiscount, storedLineKind, LINE_KIND_LABEL, invoiceDiscountSplit, roomForDiscount, discountTooBig } from "@/lib/invoice-math";
import { lineGroup, sectionLines, countsAsWorkCompleted, LINE_GROUP_LABEL } from "@/lib/portal/line-kind";
import { DocTotals } from "@/components/doc-templates";
import { CostBreakdown } from "@/components/cost-breakdown";

/**
 * A DISCOUNT IS A LINE OF ITS OWN KIND (0389; Erik 2026-10-10, INV-089: he traded part of the work,
 * could not type −165, and the credit he posted instead read as PAID). A discount is stored as a
 * negative line filed 'discount'; the paper prints it between Subtotal and Tax; the breakdown and
 * the portal file it as Discount; only a negative line may be one; and a credit posted by mistake
 * can be taken back.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;|’/g, "'").replace(/\s+/g, " ").trim();
const body = (t: string, fn: string): string => {
  const at = t.indexOf(fn);
  expect(at, `${fn} not found`).toBeGreaterThan(-1);
  const next = t.indexOf("\nexport ", at + fn.length);
  return t.slice(at, next === -1 ? undefined : next);
};

describe("the kind", () => {
  it("is known, labelled Discount, grouped on its own, and only for a line that takes money off", () => {
    expect(storedLineKind("discount")).toBe("discount");
    expect(LINE_KIND_LABEL.discount).toBe("Discount");
    const g = groupInvoiceLines([
      { description: "Labor - Erik", line_total: 287.5, unit: "hr", line_kind: "labor" },
      { description: "traded for the deck boards", line_total: -165, line_kind: "discount" },
      { description: "Discount", line_total: -50, import_source: null }, // nobody filed it: Other, as before
    ]);
    expect(g.discounts.lines.map((l) => l.description)).toEqual(["traded for the deck boards"]);
    expect(g.discounts.subtotal).toBe(-165);
    expect(g.other.lines.map((l) => l.description)).toEqual(["Discount"]);
    expect(g.hasBreakdown).toBe(true);
    expect(isDiscountLine({ line_kind: "discount", line_total: -165 })).toBe(true);
    // A 'discount' that takes nothing off is not one — anywhere.
    expect(isDiscountLine({ line_kind: "discount", line_total: 50 })).toBe(false);
    expect(groupInvoiceLines([{ description: "x", line_total: 50, line_kind: "discount" }]).other.lines).toHaveLength(1);
    expect(lineGroup({ description: "x", line_total: 50, line_kind: "discount" })).toBe("other");
    expect(canBeDiscount(-165)).toBe(true);
    expect(canBeDiscount(-0.004)).toBe(false); // a sub-cent "discount" is a $0.00 line
    expect(canBeDiscount(0)).toBe(false);
    expect(canBeDiscount(165)).toBe(false);
  });

  it("never takes the bill below $0: the room is the other lines' total, and the refusal names it", () => {
    expect(roomForDiscount([287.5, 19.35])).toBe(306.85);
    expect(roomForDiscount([100, -165])).toBe(0);
    expect(discountTooBig(306.85)).toBe("That discount is more than the $306.85 on this bill — enter $306.85 or less.");
  });

  it("ONE split for the paper and the office card: the gross Subtotal, each discount, the listed lines", () => {
    const lines = [
      { description: "Labor - Erik", line_total: 287.5, unit: "hr", line_kind: "labor" },
      { description: "traded for the deck boards", line_total: -165, line_kind: "discount" },
    ];
    const split = invoiceDiscountSplit(lines, 122.5);
    expect(split.gross).toBe(287.5);
    expect(split.discounts).toEqual([{ label: "traded for the deck boards", amount: -165 }]);
    expect(split.listed.map((l) => l.description)).toEqual(["Labor - Erik"]);
    expect(invoiceDiscountSplit(lines.slice(0, 1), 287.5)).toEqual({ listed: lines.slice(0, 1), discounts: [], gross: 287.5 });
  });

  it("on the portal: its own group, labelled Discount, never work completed", () => {
    const line = { description: "traded for the deck boards", line_kind: "discount", line_total: -165 };
    expect(lineGroup(line)).toBe("discount");
    expect(LINE_GROUP_LABEL.discount).toBe("Discount");
    expect(countsAsWorkCompleted(line)).toBe(false);
    const secs = sectionLines([{ description: "Labor - Erik", unit: "hr", line_total: 287.5 }, line]);
    expect(secs.map((s) => [s.group, s.subtotal])).toEqual([["labor", 287.5], ["discount", -165]]);
  });
});

describe("the paper", () => {
  it("DocTotals prints each discount between Subtotal and Tax with what it was for", () => {
    const html = renderToStaticMarkup(
      createElement(DocTotals, { subtotal: 306.85, discounts: [{ label: "traded for the deck boards", amount: -165 }], tax: 0, total: 141.85, amountPaid: 0, balance: 141.85 }),
    );
    const t = text(html);
    expect(t).toContain("Subtotal $306.85 Discount — traded for the deck boards −$165.00 Tax $0.00 Total $141.85");
    expect(html).toContain('data-doc-discount=""');
    // A reason that already says Discount is not said twice.
    const twice = renderToStaticMarkup(createElement(DocTotals, { subtotal: 100, discounts: [{ label: "Discount for a repeat customer", amount: -10 }], tax: 0, total: 90 }));
    expect(text(twice)).toContain("Subtotal $100.00 Discount for a repeat customer −$10.00 Tax");
  });

  it("the invoice document takes discount lines out of the list and hands them to the totals as the gross Subtotal's reduction", () => {
    const doc = src("src/components/invoice-document.tsx");
    expect(doc).toContain("const { listed, discounts, gross: grossSubtotal } = invoiceDiscountSplit(lines, subtotal);");
    expect(doc).toContain("sectionLines(listed, invoiceKind ?? null)");
    expect(doc).toMatch(/listed\.map\(\(it, i\) => \(\s*<LineRow/);
    expect(doc).toContain("subtotal={grossSubtotal}");
    expect(doc).toContain("discounts={discounts}");
    // The breakdown reads the listed lines: the discount prints once, in the totals block.
    expect(doc).toContain("<CostBreakdown items={listed}");
    // The office's totals card reads the same split.
    const editor = src("src/app/(app)/billing/[id]/invoice-detail.tsx");
    expect(editor).toContain("const split = invoiceDiscountSplit(items, Number(invoice.subtotal) || 0);");
    expect(editor).toContain("<CostBreakdown items={split.listed}");
  });

  it("the Cost Breakdown has a Discount row", () => {
    const html = renderToStaticMarkup(
      createElement(CostBreakdown, {
        items: [
          { description: "Labor - Erik", line_total: 287.5, unit: "hr", line_kind: "labor" },
          { description: "traded", line_total: -165, line_kind: "discount" },
        ],
      }),
    );
    expect(text(html)).toContain("Labor $287.50 Discount -$165.00");
  });
});

describe("the doors", () => {
  const actions = src("src/app/(app)/billing/actions.ts");
  it("Add A Discount writes a negative line of the kind through addInvoiceItem, which refuses a discount with nothing off", () => {
    const fn = body(actions, "export async function addInvoiceItem(");
    expect(fn).toContain('if (!item.description?.trim()) return { ok: false, error: "Say what the discount is for." };');
    expect(fn).toContain('error: "A discount takes money off — give it an amount."');
    expect(fn).toContain("item.kind === DISCOUNT_KIND ? DISCOUNT_KIND : pickableLineKind(item.kind)");
    expect(fn).toContain("return { ok: false, error: discountTooBig(room) };");
    expect(fn).toContain('"Discounts aren\'t switched on yet. Try again after the next update."');
    const detail = src("src/app/(app)/billing/[id]/invoice-detail.tsx");
    expect(detail).toContain("Add A Discount");
    expect(detail).toContain("Save The Discount");
    expect(detail).toContain("unit_price: -Math.abs(discountAmount),");
    expect(detail).toContain('kind: "discount",');
    expect(detail).toContain("if (pending) return; // Enter twice is one discount, not two");
    // Editing a discount: shown and typed as the positive figure it takes off, stored back negative.
    expect(detail).toContain("unit_price: editingDiscount ? -Math.abs(editPrice) : editPrice,");
  });
  it("an edit can neither turn a discount into a charge nor take the bill below $0", () => {
    const fn = body(actions, "export async function updateInvoiceItem(");
    expect(fn).toContain("if (was && was.line_kind === DISCOUNT_KIND) {");
    expect(fn).toContain('if (!canBeDiscount(qty * price)) return { ok: false, error: "A discount takes money off — give it an amount." };');
    expect(fn).toContain("return { ok: false, error: discountTooBig(room) };");
  });
  it("the Kind chip offers Discount only on a hand-typed negative line, and the server checks the same", () => {
    const chips = src("src/app/(app)/billing/[id]/line-kind-chips.tsx");
    expect(chips).toContain("canBeDiscount(item.line_total) && !item.import_source ? [...PICKABLE_LINE_KINDS, DISCOUNT_KIND] : PICKABLE_LINE_KINDS");
    const fn = body(actions, "export async function setInvoiceItemKind(");
    expect(fn).toContain("if (next === DISCOUNT_KIND) {");
    expect(fn).toContain("if (line.import_source || !canBeDiscount(line.line_total)) {");
    expect(fn).toContain("Only a hand-typed line that takes money off can be a discount");
  });
  it("Take It Back returns an open credit to the account, recomputes and stamps the invoice; Delete This Credit is the second door", () => {
    const fn = body(actions, "export async function withdrawCustomerCredit(");
    expect(fn).toContain("withdrawCredit(ctx.supabase, creditId)");
    expect(fn).toContain("const landed = await recalcInvoice(ctx.supabase, res.invoiceId);");
    expect(fn).toContain('stampInvoiceRevised(ctx.supabase, res.invoiceId, "withdrawCustomerCredit")');
    expect(fn).toContain("revalidateMoney(res.invoiceId);");
    const del = body(actions, "export async function deleteCustomerCredit(");
    expect(del).toContain("deleteCredit(ctx.supabase, creditId)");
    const button = src("src/app/(app)/billing/[id]/credit-button.tsx");
    expect(button).toContain("Take It Back");
    expect(button).toContain("act(() => withdrawCustomerCredit(c.id))");
    expect(button).toContain("Delete This Credit");
    expect(button).toContain("confirm(`Delete the ${formatCurrency(c.amount)} credit on this customer's account? This cannot be undone.`)");
    expect(button).toContain("if (res.message) setSaid(res.message);");
    // A discount is not where a supplier return lands.
    expect(src("src/lib/already-billed.ts")).toContain('g !== "credit" && g !== "discount"');
  });
  it("0389 widens the one constraint and nothing else", () => {
    const m = src("supabase/migrations/0389_a_discount_is_a_line.sql");
    expect(m).toContain("drop constraint if exists invoice_items_line_kind_known");
    expect(m).toContain("check (line_kind is null or line_kind in ('labor', 'materials', 'other', 'credit', 'discount'))");
    expect(m).not.toMatch(/create or replace function|add column/i);
  });
});
