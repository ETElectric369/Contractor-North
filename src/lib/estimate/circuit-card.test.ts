import { describe, expect, it } from "vitest";
import { circuitCard } from "./circuit-card";

const ROW = [{ number: "1", label: "Kitchen counter", amps: 20 }];

describe("circuitCard: the card shows only when there are circuits; the ⋯ row offers one otherwise", () => {
  // [panelMapOn, circuits, locked, has, canAdd]
  const table: [boolean, unknown, boolean, boolean, boolean][] = [
    [true, [], false, false, true],
    [true, [], true, false, false],
    [true, null, false, false, true],
    [true, null, true, false, false],
    [true, "not a list", false, false, true],
    [true, { 0: "row" }, true, false, false],
    [true, ROW, false, true, false],
    [true, ROW, true, true, false],
    [false, [], false, false, false],
    [false, [], true, false, false],
    [false, null, false, false, false],
    [false, null, true, false, false],
    [false, "not a list", false, false, false],
    [false, { 0: "row" }, true, false, false],
    [false, ROW, false, true, false],
    [false, ROW, true, true, false],
  ];
  it.each(table)("Panel Map %s, circuits %j, locked %s → has %s, canAdd %s", (panelMapOn, circuits, locked, has, canAdd) => {
    expect(circuitCard({ panelMapOn, circuits, locked })).toEqual({ has, canAdd });
  });

  it("never both: an estimate that shows its card is never offered a second door to it", () => {
    for (const [panelMapOn, circuits, locked] of table) {
      const c = circuitCard({ panelMapOn, circuits, locked });
      expect(c.has && c.canAdd).toBe(false);
    }
  });
});
