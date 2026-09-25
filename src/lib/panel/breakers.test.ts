import { describe, it, expect } from "vitest";
import { boughtLines, breakerCard, candidatesFor, firstPicks, groupBreakers, groupLabel, placementOf } from "./breakers";
import { spaceMap } from "./model";
import { FINAL_MAP, PANEL, PHOTO_EXISTING } from "./__fixtures__/herringbone";

/**
 * THE BREAKERS CARD ON J-011's NIGHT (Panel plan, phase 3), from the ticket's own words: CED
 * 8802-SO-257555 as it sits in bill_line_items, and J-011's materials list as it sits today.
 */

const TICKET_LINES = [
  { description: "LUT MSOPS5MWH 1P Sensor Switch", qty: 1 },
  { description: "ALM P2400W Flexbox Two Gang 40CU OWB", qty: 1 },
  { description: "PS TM870W WHT 1P15A125V SW", qty: 2 },
  { description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: 8 },
  { description: "SIEM Q21530CT", qty: 1 },
  { description: "PS 3864 30A 125/250 Recpt", qty: 1 },
  { description: "PS SS703 302SS 2G PWR OUTL PLT", qty: 1 },
  { description: "Tax @ 9.00000%", qty: 1 },
];
const LIST_LINES = [
  { description: "GFI", part_number: null, qty: 6, purchased: true },
  { description: "20a twin breaker", part_number: null, qty: 8, purchased: false },
  { description: "Quad 2p - 30a - 1p-15s breaker", part_number: null, qty: 1, purchased: false },
  { description: "4 prong 30a receptacle & fp", part_number: null, qty: 1, purchased: false },
];
const all = [...FINAL_MAP, ...PHOTO_EXISTING];

describe("the Herringbone Breakers card", () => {
  const card = breakerCard({ circuits: all, panel: PANEL, bought: TICKET_LINES, list: LIST_LINES, shelf: [] });

  it("counts what the ticket brought: 8 x Q2020 and 1 x Q21530CT, and nothing that isn't a breaker", () => {
    expect(card.bought.map((g) => [groupLabel(g), g.qty])).toEqual([
      ["Q2020 · Twin 1P 20A + 1P 20A", 8],
      ["Q21530CT · Quad 1P 15A + 1P 15A + 2P 30A", 1],
    ]);
    expect(card.unreadable).toEqual([]);
  });

  it("says Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.", () => {
    expect(card.needWords).toBe("Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A.");
    expect(card.check.verdict).toBe("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
    expect(card.alreadyInWords).toBe("Nine Existing And Two Reused Circuits Are Already In.");
  });

  it("offers a Q220 for the short 2P 20A, in the family the ticket came from", () => {
    expect(card.brand).toBe("siemens");
    expect(card.orders).toHaveLength(1);
    expect(card.orders[0]).toMatchObject({ part: "Q220", description: "Q220 2P 20A Breaker", qty: 1 });
  });

  it("offers the quad swap with the CT2 warning; with no tandem spaces set it holds only if a space takes a quad", () => {
    expect(card.quadSpace).toBe("unknown");
    expect(card.check.swaps).toHaveLength(1);
    expect(card.check.swaps[0]).toMatchObject({ get: { part: "Q22020CT" }, warning: "Not Q22020CT2, That Is Two 2-Pole 20s", ifSpaceTakesQuad: true });
    // Tandem spaces set and all full: no swap. Set and free: the swap, with no "if".
    const placed = all.map((c, i) => (i === 0 ? { ...c, space: 1 } : i === 1 ? { ...c, space: 3 } : c));
    const full = breakerCard({ circuits: placed, panel: { ...PANEL, spaces: 4, twin_spaces: [1, 3] }, bought: TICKET_LINES });
    expect(full.check.swaps).toEqual([]);
    const free = breakerCard({ circuits: all, panel: { ...PANEL, twin_spaces: [25, 27] }, bought: TICKET_LINES });
    expect(free.check.swaps[0].ifSpaceTakesQuad).toBe(false);
  });

  it("shows the list's unticked breakers and says the ticket already brought them; never counts them twice", () => {
    expect(card.onList.map((g) => [g.words, g.qty, g.onTicket])).toEqual([
      ["Twin 1P 20A + 1P 20A", 8, 8],
      ["Quad 1P 15A + 1P 15A + 2P 30A", 1, 1],
    ]);
    expect(card.check.spare).toEqual([{ poles: 1, amps: 20, kind: null, count: 1 }]);
  });

  it("an unreadable breaker counts as zero and is named", () => {
    const c = breakerCard({ circuits: all, panel: PANEL, bought: [...TICKET_LINES, { description: "SIEM Q22030CT", qty: 1 }] });
    expect(c.unreadable).toEqual([{ description: "SIEM Q22030CT", qty: 1, reason: "Can't Read Q22030CT. Confirm What Is Inside It." }]);
    expect(c.check.verdict).toBe("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
  });

  it("the shelf and the list are said beside the order, never instead of it", () => {
    const c = breakerCard({
      circuits: all,
      panel: PANEL,
      bought: TICKET_LINES,
      list: [{ description: "Q220 2P 20A Breaker", part_number: "Q220", qty: 1, purchased: false }],
      shelf: [{ name: "Siemens Q220 2P 20A", on_hand: 2 }],
    });
    expect(c.check.ok).toBe(false);
    expect(c.orders[0].alsoOn).toEqual([
      "On The List, Not Bought Yet: 1 x Q220 · 2P 20A",
      "On The Shelf: 2 x Q220 · 2P 20A",
    ]);
  });
});

describe("placing what was bought", () => {
  const groups = groupBreakers(TICKET_LINES).groups;
  const q2020 = groups.find((g) => g.codes.includes("Q2020"))!;
  const quad = groups.find((g) => g.codes.includes("Q21530CT"))!;

  it("a Q21530CT at 25 is 25A and 27A outside and a 2P 30 on 25B-27B inside, the way the door reads it", () => {
    expect(placementOf(quad, 25).map((p) => [p.space, p.half, p.poles, p.amps])).toEqual([
      [25, "A", 1, 15],
      [27, "A", 1, 15],
      [25, "B", 2, 30],
    ]);
    const placed = placementOf(quad, 25).map((p, i) => ({ ...FINAL_MAP[0], id: `q${i}`, space: p.space, half: p.half, poles: p.poles, amps: p.amps }));
    expect(spaceMap({ ...PANEL, twin_spaces: [25, 27] }, placed).warnings).toEqual([]);
  });

  it("a twin's halves go to the first unplaced 1P 20A circuits, each a different one, new work first", () => {
    const parts = placementOf(q2020, 7);
    expect(parts.map((p) => `${p.space}${p.half}`)).toEqual(["7A", "7B"]);
    const picks = firstPicks(parts, all, PANEL.id);
    expect(picks.map((id) => all.find((c) => c.id === id)!.description)).toEqual(["Outlets Right", "Outlets Left"]);
    // A reused or existing 20 is offered after the new ones, and one already placed isn't offered.
    const withPlaced = all.map((c) => (c.description === "Outlets Right" ? { ...c, space: 1 } : c));
    expect(candidatesFor(parts[0], withPlaced, PANEL.id).map((c) => c.description)).not.toContain("Outlets Right");
    expect(candidatesFor(parts[0], all, PANEL.id).at(-1)?.work).not.toBe("new");
  });
});

describe("adding up tickets", () => {
  it("the same breaker written two ways is one group; a return takes it back off", () => {
    const g = groupBreakers([
      { description: "SP 20A 120/240V CB (Q120)", qty: 10 },
      { description: "SP 20A 120/240V CB", qty: 3 },
      { description: "SP 20A 120/240V CB (SIEM Q120)", qty: -2 },
    ]);
    expect(g.groups.map((x) => [x.codes, x.words, x.qty])).toEqual([[["Q120"], "1P 20A", 11]]);
  });

  it("a credit nobody can read (0334's credit_qty) is named and never counted, either way", () => {
    const lines = boughtLines([
      { description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: "8", credit_qty: "8" },
      { description: "SP 20A 120/240V CB (Q120)", qty: 0, credit_qty: 2 },
    ]);
    expect(lines).toEqual([
      { description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: 8 },
      { description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: 8, credit: true },
      { description: "SP 20A 120/240V CB (Q120)", qty: 2, credit: true },
    ]);
    const g = groupBreakers(lines);
    expect(g.groups.map((x) => [x.codes, x.qty])).toEqual([[["Q2020"], 8]]);
    expect(g.unreadable.map((u) => [u.description, u.qty, u.credit])).toEqual([
      ["SIEM Q2020 SP 20/20A 120/240V CB", 8, true],
      ["SP 20A 120/240V CB (Q120)", 2, true],
    ]);
    // A 2-column answer (before 0334 carried credit_qty) still reads.
    expect(boughtLines([{ description: "SIEM Q21530CT", qty: 1 }])).toEqual([{ description: "SIEM Q21530CT", qty: 1 }]);
  });
});

describe("the family to order in", () => {
  it("a bare Square D or Eaton names no family: the tickets' codes decide, or a person does", () => {
    const one2P20 = all.filter((c) => c.poles === 2 && c.amps === 20);
    expect(one2P20.length).toBeGreaterThan(0);
    const bare = breakerCard({ circuits: all, panel: { ...PANEL, brand: "Square D" }, bought: [] });
    expect(bare.brand).toBeNull();
    expect(bare.orders.every((o) => o.part === null)).toBe(true);
    // The ticket brought Siemens codes, so a bare brand falls back to them.
    const fromTicket = breakerCard({ circuits: all, panel: { ...PANEL, brand: "Eaton" }, bought: TICKET_LINES });
    expect(fromTicket.brand).toBe("siemens");
    expect(breakerCard({ circuits: all, panel: { ...PANEL, brand: "Square D QO" }, bought: [] }).brand).toBe("square_d_qo");
    expect(breakerCard({ circuits: all, panel: { ...PANEL, brand: "Eaton CH" }, bought: [] }).brand).toBe("eaton_ch");
    expect(breakerCard({ circuits: all, panel: { ...PANEL, brand: "Square D Homeline" }, bought: [] }).brand).toBe("square_d_homeline");
  });
});
