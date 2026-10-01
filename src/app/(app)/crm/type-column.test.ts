import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { customerColumns, customerTypesDiffer } from "./columns";
import type { Customer, CustomerType } from "@/lib/types";

/**
 * CUSTOMERS' TYPE COLUMN SHOWS ONLY WHEN A COMPANY'S CUSTOMERS DIFFER (W2-13). A company whose every
 * customer is residential read a column of "residential" down the page; the width is the name's then.
 * Two 1-row reads say whether two or more types are in use (the first and last type in the enum's own
 * order), ignoring the search and the sort, so the column never blinks while someone types.
 */
const src = (p: string) => readFileSync(join(process.cwd(), "src/app/(app)/crm", p), "utf8");
const spans = (showType: boolean) => customerColumns(showType).reduce((s, c) => s + c.span, 0);
const headers = (showType: boolean) => customerColumns(showType).map((c) => c.header);

const rita: Customer = {
  id: "c1",
  name: "Rita Moss",
  company_name: null,
  type: "contractor",
  status: "active",
  email: "rita@example.test",
  phone: "(530) 555-0101",
  address: null,
  unit: null,
  city: "Truckee",
  state: "CA",
} as unknown as Customer;

describe("the Type column is conditional on the types differing", () => {
  it("one type in use: no Type column, and Name takes its width (the grid still sums to 12)", () => {
    expect(headers(false)).toEqual(["Name", "Contact", "Location", "Status"]);
    expect(customerColumns(false)[0].span).toBe(6);
    expect(spans(false)).toBe(12);
  });

  it("two or more types: the Type column, span 2 and capitalized, beside a Name of 4 (still 12)", () => {
    expect(headers(true)).toEqual(["Name", "Contact", "Type", "Location", "Status"]);
    const type = customerColumns(true).find((c) => c.header === "Type")!;
    expect(type.span).toBe(2);
    expect(type.className).toContain("capitalize");
    expect(customerColumns(true)[0].span).toBe(4);
    expect(spans(true)).toBe(12);
  });

  it("the Type cell says the customer's type; every other cell reads the same with or without it", () => {
    const type = customerColumns(true).find((c) => c.header === "Type")!;
    expect(type.cell(rita)).toBe("contractor");
    const cells = (showType: boolean) =>
      customerColumns(showType)
        .filter((c) => c.header !== "Type")
        .map((c) => renderToStaticMarkup(createElement("div", null, c.cell(rita))));
    expect(cells(false)).toEqual(cells(true));
  });

  it("min ≠ max exactly when two or more types exist; a failed read keeps the column (today's table)", () => {
    const one = (type: string | null) => ({ data: type ? [{ type }] : [], error: null });
    expect(customerTypesDiffer(one("residential"), one("residential"))).toBe(false);
    expect(customerTypesDiffer(one("residential"), one("contractor"))).toBe(true);
    expect(customerTypesDiffer(one(null), one(null))).toBe(false); // no customers: the empty state shows anyway
    expect(customerTypesDiffer({ data: null, error: { message: "boom" } }, one("residential"))).toBe(true);
    expect(customerTypesDiffer(one("residential"), { data: null, error: { message: "boom" } })).toBe(true);
  });
});

describe("the page reads the ends of the type list beside the list, ignoring the search and the sort", () => {
  const page = src("page.tsx");

  it("two 1-row reads, one each way, run with the list query", () => {
    expect(page).toContain('supabase.from("customers").select("type").order("type", { ascending }).limit(1)');
    expect(page).toContain("await Promise.all([query, typeEnd(true), typeEnd(false)])");
    expect(page).toContain("const mixed = customerTypesDiffer(lo, hi);");
    expect(page).toContain("columns={customerColumns(mixed)}");
    // The two reads carry no search filter and no chosen order: only the list query does.
    const typeEnd = page.slice(page.indexOf("const typeEnd"), page.indexOf("const [{ data }, lo, hi]"));
    expect(typeEnd).not.toContain(".or(");
    expect(typeEnd).not.toContain("order.column");
  });

  it("the Type field stays in New Customer and Edit Customer, with Contractor in both", () => {
    for (const f of ["new-customer-button.tsx", "[id]/edit-customer-button.tsx"]) {
      expect(src(f), f).toContain('<option value="contractor">Contractor</option>');
    }
    // 'contractor' has been in the enum since 0151, and in the type now.
    const t: CustomerType = "contractor";
    expect(t).toBe("contractor");
  });
});
