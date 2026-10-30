import { describe, it, expect } from "vitest";
import { boughtLines, breakerCard, breakerSay, candidatesFor, firstPicks, groupBreakers, groupLabel, placementOf, unplacedBought } from "./breakers";
import { spaceMap } from "./model";
import { FINAL_MAP, PANEL, PHOTO_EXISTING, circuit } from "./__fixtures__/honeysuckle";

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

describe("the Honeysuckle Breakers card", () => {
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
      "In Stock: 2 x Q220 · 2P 20A",
    ]);
  });
});

describe("placing what was bought", () => {
  const groups = groupBreakers(TICKET_LINES).groups;
  const q2020 = groups.find((g) => g.codes.includes("Q2020"))!;
  const quad = groups.find((g) => g.codes.includes("Q21530CT"))!;

  it("a Q21530CT at 25 is 25A and 27B outside and a 2P 30 on 25B-27A inside, the way the door reads it", () => {
    expect(placementOf(quad, 25).map((p) => [p.space, p.half, p.poles, p.amps])).toEqual([
      [25, "A", 1, 15],
      [27, "B", 1, 15],
      [25, "B", 2, 30],
    ]);
    const placed = placementOf(quad, 25).map((p, i) => ({ ...FINAL_MAP[0], id: `q${i}`, space: p.space, half: p.half, poles: p.poles, amps: p.amps }));
    const map = spaceMap({ ...PANEL, twin_spaces: [25, 27] }, placed);
    expect(map.warnings).toEqual([]);
    // Four handles, top to bottom: outside, inside, inside, outside.
    expect([map.cells.get(25), map.cells.get(27)]).toEqual([
      { A: ["q0"], B: ["q2"], full: [] },
      { A: ["q2"], B: ["q1"], full: [] },
    ]);
  });

  it("on a panel numbered BOTTOM UP (27 hangs above 25) the same quad is 27A and 25B outside and the 2P on 25A/27B inside", () => {
    const parts = placementOf(quad, 25, "bottom_up");
    expect(parts.map((p) => [p.space, p.half, p.poles, p.amps, p.label])).toEqual([
      [27, "A", 1, 15, "Outside, Top"],
      [25, "B", 1, 15, "Outside, Bottom"],
      [25, "A", 2, 30, "Inside 2-Pole"],
    ]);
    const placed = parts.map((p, i) => ({ ...FINAL_MAP[0], id: `q${i}`, space: p.space, half: p.half, poles: p.poles, amps: p.amps }));
    // (Where a slot is doesn't depend on the numbering; which one hangs on top does.)
    const map = spaceMap({ ...PANEL, twin_spaces: [25, 27] }, placed);
    expect(map.warnings).toEqual([]);
    // Top to bottom on that door: 27A outside, 27B inside, 25A inside, 25B outside.
    expect([map.cells.get(27), map.cells.get(25)]).toEqual([
      { A: ["q0"], B: ["q2"], full: [] },
      { A: ["q2"], B: ["q1"], full: [] },
    ]);
    // Top down is unchanged by saying so.
    expect(placementOf(quad, 25, "top_down")).toEqual(placementOf(quad, 25));
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

describe("the card's one line (the panel-first wave)", () => {
  const sized = (space: number | null, half: "A" | "B" | null, description: string, over: Parameters<typeof circuit>[0] | object = {}) =>
    circuit({ room: "Kitchen", description, amps: 20, poles: 1, space, half, ...over });

  it("J-011: short one 2P 20A with its one order, and the nine breakers that came not placed yet", () => {
    const card = breakerCard({ circuits: all, panel: PANEL, bought: TICKET_LINES, list: LIST_LINES, shelf: [] });
    const say = breakerSay(card, all);
    expect(say.nothing).toBeNull();
    expect(say.short?.text).toBe("Short one 2P 20A (Bath Floor Heat)");
    expect(say.short?.orders.map((o) => [o.part, o.qty, o.description])).toEqual([["Q220", 1, "Q220 2P 20A Breaker"]]);
    expect(say.unplaced).toMatchObject({ text: "9 bought breakers not placed yet", count: 9 });
    expect(groupLabel(say.unplaced!.group)).toBe("Q2020 · Twin 1P 20A + 1P 20A");
    expect(say.ok).toBeNull();
    expect(say.notes).toEqual([]);
  });

  it("a breaker is in when its circuits have spaces; one with no circuit to be is a spare, never 'not placed'", () => {
    const twins = groupBreakers([{ description: "SIEM Q2020", qty: 3 }]).groups;
    const four = [sized(1, "A", "A1"), sized(1, "B", "B1"), sized(null, null, "Waiting 1"), sized(null, null, "Waiting 2")];
    // Two placed circuits take one twin; two waiting take the second; the third has nothing to be.
    expect(unplacedBought(twins, four)).toMatchObject({ count: 1 });
    // Existing work, a suggestion, a circuit taken off, or one with no amps is never what came.
    const notNew = [sized(null, null, "Old", { work: "existing" }), sized(null, null, "Maybe", { state: "suggested" }), sized(null, null, "Gone", { removed_at: "2026-10-30T00:00:00Z" }), sized(null, null, "Unsized", { amps: null })];
    expect(unplacedBought(twins, notNew)).toEqual({ count: 0, first: null });
  });

  it("All breakers accounted for. when nothing is short, nothing waits and every new circuit is sized", () => {
    const circuits = [sized(1, "A", "A1"), sized(1, "B", "B1")];
    const card = breakerCard({ circuits, panel: PANEL, bought: [{ description: "SIEM Q2020", qty: 1 }] });
    expect(breakerSay(card, circuits)).toEqual({ nothing: null, short: null, unplaced: null, ok: "All breakers accounted for.", partial: null, notes: [] });
    // A new circuit with no amps is said, and the line no longer claims everything is accounted for.
    const holey = [...circuits, sized(null, null, "Fan", { room: "Bath", amps: null })];
    const say = breakerSay(breakerCard({ circuits: holey, panel: PANEL, bought: [{ description: "SIEM Q2020", qty: 1 }] }), holey);
    expect(say.ok).toBeNull();
    expect(say.notes).toEqual(["1 new circuit has no amps yet (Bath Fan), so it isn't counted."]);
  });

  it("several shortfalls in one sentence; one already on the list is said and left out of the order", () => {
    const circuits = [
      circuit({ room: "Bath", description: "Floor Heat", amps: 20, poles: 2 }),
      circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2 }),
      sized(null, null, "Porch", { amps: 15 }),
      sized(null, null, "Hall", { amps: 15 }),
    ];
    const list = [{ description: "Q230 2P 30A breaker", part_number: "Q230", qty: 1, purchased: false }];
    const say = breakerSay(breakerCard({ circuits, panel: PANEL, bought: [], list }), circuits);
    expect(say.short?.text).toBe("Short two 1P 15A (Kitchen Porch, Kitchen Hall), one 2P 20A (Bath Floor Heat) and one 2P 30A (Laundry Dryer)");
    expect(say.short?.orders.map((o) => o.part)).toEqual(["Q115", "Q220"]);
    expect(say.notes).toEqual(["2P 30A is on the materials list already, not bought yet."]);
  });

  it("nothing counted yet says what to do first, and nothing else", () => {
    const suggested = all.map((c) => ({ ...c, state: "suggested" as const }));
    const say = breakerSay(breakerCard({ circuits: suggested, panel: PANEL, bought: TICKET_LINES }), suggested);
    expect(say).toMatchObject({ short: null, unplaced: null, ok: null });
    expect(say.nothing).toMatch(/^Nothing counted yet\. Keep the new circuits to count what they need: \d+ suggestions are waiting above\.$/);
    const old = [circuit({ room: "Kitchen", description: "Range", amps: 50, poles: 2, work: "existing" })];
    expect(breakerSay(breakerCard({ circuits: old, panel: PANEL, bought: [] }), old).nothing).toBe(
      "No new circuits on the list yet. Add the new work to count its breakers.",
    );
  });

  it("an unreadable ticket line and a credit nobody can read are named on the line, for everyone", () => {
    const card = breakerCard({
      circuits: all,
      panel: PANEL,
      bought: [...TICKET_LINES, { description: "SIEM Q22030CT", qty: 1 }, { description: "SP 20A 120/240V CB (Q120)", qty: 2, credit: true }],
    });
    expect(breakerSay(card, all).notes).toEqual([
      "Can't read SIEM Q22030CT (1) on a ticket, so it isn't counted.",
      "A credit on a ticket for SP 20A 120/240V CB (Q120) (2) isn't counted either way.",
    ]);
  });

  it("never 'All breakers accounted for.' beside a line it couldn't read: it says what it counted", () => {
    const circuits = [sized(1, "A", "A1"), sized(1, "B", "B1")];
    const one = breakerSay(breakerCard({ circuits, panel: PANEL, bought: [{ description: "SIEM Q2020", qty: 1 }, { description: "SIEM Q22030CT", qty: 1 }] }), circuits);
    expect(one.ok).toBeNull();
    expect(one.partial).toBe("Counted what I could read — one ticket line is unreadable.");
    expect(one.notes).toEqual(["Can't read SIEM Q22030CT (1) on a ticket, so it isn't counted."]);
    // A credit nobody can read counts as unreadable too; two lines are said as two.
    const two = breakerSay(
      breakerCard({
        circuits,
        panel: PANEL,
        bought: [{ description: "SIEM Q2020", qty: 1 }, { description: "SIEM Q22030CT", qty: 1 }, { description: "SP 20A 120/240V CB (Q120)", qty: 2, credit: true }],
      }),
      circuits,
    );
    expect(two).toMatchObject({ ok: null, partial: "Counted what I could read — two ticket lines are unreadable." });
    // Something short is said as short, never as "counted what I could read".
    expect(breakerSay(breakerCard({ circuits: all, panel: PANEL, bought: [...TICKET_LINES, { description: "SIEM Q22030CT", qty: 1 }] }), all).partial).toBeNull();
  });
});
