import { describe, it, expect } from "vitest";
import { sortRows, groupRows, applyFilters, searchRows, type SortOption } from "./sort-filter";

const opts: SortOption[] = [
  { key: "code", label: "Code" },
  { key: "sell", label: "Sell", kind: "number" },
  { key: "updated_at", label: "Updated", kind: "date" },
];
const rows = [
  { code: "D10", sell: 5, updated_at: "2026-09-01", category: "Deck" },
  { code: "D2", sell: 50, updated_at: "2026-08-01", category: null },
  { code: null, sell: 1, updated_at: "2026-09-03", category: "Deck" },
  { code: "d9", sell: 20, updated_at: "2026-07-01", category: "Rail" },
];

describe("sortRows", () => {
  it("sorts text naturally and case-insensitively, nulls last either direction", () => {
    expect(sortRows(rows, { key: "code", dir: "asc" }, opts).map((r) => r.code)).toEqual(["D2", "d9", "D10", null]);
    expect(sortRows(rows, { key: "code", dir: "desc" }, opts).map((r) => r.code)).toEqual(["D10", "d9", "D2", null]);
  });
  it("sorts numbers and dates by value", () => {
    expect(sortRows(rows, { key: "sell", dir: "desc" }, opts).map((r) => r.sell)).toEqual([50, 20, 5, 1]);
    expect(sortRows(rows, { key: "updated_at", dir: "asc" }, opts).map((r) => r.updated_at)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01", "2026-09-03"]);
  });
  it("is stable and leaves rows alone with no spec", () => {
    expect(sortRows(rows, null, opts)).toBe(rows);
  });
});

describe("groupRows / applyFilters / searchRows", () => {
  it("groups in first-appearance order with an empty bucket", () => {
    const g = groupRows(rows, "category", "No category");
    expect(g.map((x) => x.label)).toEqual(["Deck", "No category", "Rail"]);
    expect(g[0].rows).toHaveLength(2);
  });
  it("ANDs the active chips and ignores inactive ones", () => {
    const chips = [
      { key: "cheap", label: "Under $10", test: (r: (typeof rows)[number]) => r.sell < 10 },
      { key: "deck", label: "Deck", test: (r: (typeof rows)[number]) => r.category === "Deck" },
    ];
    expect(applyFilters(rows, chips, new Set(["cheap", "deck"]))).toHaveLength(2);
    expect(applyFilters(rows, chips, new Set())).toHaveLength(4);
  });
  it("searches across fields", () => {
    expect(searchRows(rows, "d1", ["code"])).toHaveLength(1);
    expect(searchRows(rows, "rail", ["code", "category"])).toHaveLength(1);
  });
});
