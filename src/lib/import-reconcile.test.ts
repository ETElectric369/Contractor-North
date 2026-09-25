import { describe, it, expect } from "vitest";
import { removedLines, removedSentence, staleTombstones } from "./import-reconcile";

describe("a refresh never silently drops a line that is present (INV-078's Home Depot 14-2)", () => {
  const hd = { id: "li-hd", import_key: "bli:059c5c7c", description: "14-2 NM W/G 100 FT", line_total: "186.48" };
  const box = { id: "li-box", import_key: "bli:e7da8739", description: "Flexbox single gang 20.5 cu in", line_total: 49.17 };

  it("a tombstoned key whose line is ON the invoice is stale; one whose line is gone is not", () => {
    expect(staleTombstones([hd, box], ["bli:059c5c7c", "labor:p-erik:2", "bli:gone"])).toEqual(["bli:059c5c7c"]);
    expect(staleTombstones([hd], [])).toEqual([]);
    expect(staleTombstones([{ import_key: null }], ["bli:059c5c7c"])).toEqual([]);
  });

  it("what the importer removed is named with its amount", () => {
    const gone = removedLines([hd, box], [{ id: "li-box" }]);
    expect(gone).toEqual([{ importKey: "bli:059c5c7c", description: "14-2 NM W/G 100 FT", amount: 186.48 }]);
    expect(removedSentence(gone)).toBe("Removed 1 line the job no longer bills: 14-2 NM W/G 100 FT ($186.48)");
    expect(removedSentence([])).toBe("");
  });

  it("two lines, one sentence", () => {
    expect(removedSentence(removedLines([hd, box], []))).toBe(
      "Removed 2 lines the job no longer bills: 14-2 NM W/G 100 FT ($186.48), Flexbox single gang 20.5 cu in ($49.17)",
    );
  });
});
