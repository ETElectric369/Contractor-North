import { describe, it, expect } from "vitest";
import { CRM_DEFAULT_SORT, crmOrderColumn, formatCrmSort, isDefaultCrmSort, parseCrmSort } from "./crm-order";

/**
 * Andrew: "Sorting ABCD or otherwise" — the contact list must default to A→Z by name, honour a
 * ?sort= in the URL, and never break on a bad one.
 */

describe("parseCrmSort", () => {
  it("defaults to A→Z by name — that is what a contact list is for", () => {
    expect(parseCrmSort(undefined)).toEqual({ key: "name", dir: "asc" });
    expect(parseCrmSort(null)).toEqual(CRM_DEFAULT_SORT);
    expect(parseCrmSort("")).toEqual(CRM_DEFAULT_SORT);
  });

  it("reads key.dir", () => {
    expect(parseCrmSort("name.desc")).toEqual({ key: "name", dir: "desc" });
    expect(parseCrmSort("company.asc")).toEqual({ key: "company", dir: "asc" });
    expect(parseCrmSort("recent.asc")).toEqual({ key: "recent", dir: "asc" });
  });

  it("fills in the key's natural direction when none is given — recent means newest first", () => {
    expect(parseCrmSort("recent")).toEqual({ key: "recent", dir: "desc" });
    expect(parseCrmSort("company")).toEqual({ key: "company", dir: "asc" });
    expect(parseCrmSort("name.sideways")).toEqual({ key: "name", dir: "asc" });
  });

  it("is forgiving about case and whitespace", () => {
    expect(parseCrmSort(" Company.DESC ")).toEqual({ key: "company", dir: "desc" });
  });

  it("falls back to the default on garbage rather than erroring — a stale link must not blank the list", () => {
    expect(parseCrmSort("created_at.desc")).toEqual(CRM_DEFAULT_SORT);
    expect(parseCrmSort("last_job.asc")).toEqual(CRM_DEFAULT_SORT);
    expect(parseCrmSort("..")).toEqual(CRM_DEFAULT_SORT);
    expect(parseCrmSort("name;drop table customers")).toEqual(CRM_DEFAULT_SORT);
  });
});

describe("formatCrmSort", () => {
  it("round-trips through parseCrmSort", () => {
    for (const raw of ["name.asc", "name.desc", "company.asc", "company.desc", "recent.asc", "recent.desc"]) {
      expect(formatCrmSort(parseCrmSort(raw))).toBe(raw);
    }
  });
});

describe("isDefaultCrmSort", () => {
  it("is true only for name A→Z", () => {
    expect(isDefaultCrmSort({ key: "name", dir: "asc" })).toBe(true);
    expect(isDefaultCrmSort({ key: "name", dir: "desc" })).toBe(false);
    expect(isDefaultCrmSort({ key: "recent", dir: "desc" })).toBe(false);
  });
});

describe("crmOrderColumn", () => {
  it("maps each key to its real column", () => {
    expect(crmOrderColumn({ key: "name", dir: "asc" })).toEqual({ column: "name", ascending: true, nullsFirst: false });
    expect(crmOrderColumn({ key: "company", dir: "desc" })).toEqual({ column: "company_name", ascending: false, nullsFirst: false });
    expect(crmOrderColumn({ key: "recent", dir: "desc" })).toEqual({ column: "created_at", ascending: false, nullsFirst: false });
  });

  it("always sinks nulls — a contact with no company goes last whichever way the list is flipped", () => {
    expect(crmOrderColumn({ key: "company", dir: "asc" }).nullsFirst).toBe(false);
    expect(crmOrderColumn({ key: "company", dir: "desc" }).nullsFirst).toBe(false);
  });

  it("never emits an unknown column, even for a spec that dodged the parser", () => {
    expect(crmOrderColumn({ key: "email", dir: "asc" }).column).toBe("name");
  });
});
