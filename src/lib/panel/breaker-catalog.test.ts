import { describe, it, expect } from "vitest";
import { decodeBreaker, decodeCode, partFor, promptCodeTable, QUAD_SWAPS, type BreakerReading } from "./breaker-catalog";

/**
 * THE DECODER ON ET'S REAL LINES (Panel plan, phase 3). Every breaker line ET Electric's bills carry
 * (read from production 2026-09-25, org-filtered, read only), J-011's materials lines, the CT2 trap
 * and the load centres. Each one is an EXACT reading or "unknown"; there is no confidence score and
 * nothing in between.
 */

const read = (...t: string[]) => decodeBreaker(...t);
const inside = (r: BreakerReading) => (r.kind === "breaker" ? { code: r.code, form: r.form, slots: r.slots.map((s) => `${s.poles}P${s.amps}${s.kind ? ` ${s.kind}` : ""}`) } : r.kind);

describe("ET's real bill lines", () => {
  const cases: [string, ReturnType<typeof inside>][] = [
    ["SIEM Q2020 SP 20/20A 120/240V CB", { code: "Q2020", form: "twin", slots: ["1P20", "1P20"] }],
    ["SIEM Q21530CT", { code: "Q21530CT", form: "quad", slots: ["1P15", "1P15", "2P30"] }],
    ["SIEM Q2100 2P 100A 120/240V CB", { code: "Q2100", form: "double", slots: ["2P100"] }],
    ["1P 20A CKT BRKR GFCI (SIEM QF120AN)", { code: "QF120AN", form: "single", slots: ["1P20 gfci"] }],
    ["SP 15A 120/240V CB (Q115)", { code: "Q115", form: "single", slots: ["1P15"] }],
    ["SP 20A 120/240V CB (Q120)", { code: "Q120", form: "single", slots: ["1P20"] }],
    ["SP 20A 120/240V CB (SIEM Q120)", { code: "Q120", form: "single", slots: ["1P20"] }],
    ["SP 20A 120/240V CB", { code: null, form: "single", slots: ["1P20"] }],
    ["2P 30A 120/240V CB (Q230)", { code: "Q230", form: "double", slots: ["2P30"] }],
    ["2P 50A 120/240V CB (Q250)", { code: "Q250", form: "double", slots: ["2P50"] }],
    ["2P 20A 120/240 plug-in CB", { code: null, form: "double", slots: ["2P20"] }],
    ["2P 30A 120/240V CB", { code: null, form: "double", slots: ["2P30"] }],
    ["2P 50A 120/240V CB", { code: null, form: "double", slots: ["2P50"] }],
    ["SQD HOM120 Miniature Circuit", { code: "HOM120", form: "single", slots: ["1P20"] }],
    ["SQD HOMT1515 Miniature Circuit", { code: "HOMT1515", form: "twin", slots: ["1P15", "1P15"] }],
    ["SQD HOMT2020 Miniature Circuit", { code: "HOMT2020", form: "twin", slots: ["1P20", "1P20"] }],
    ["SQD HOMT230250 Miniature Ckt Brkr", { code: "HOMT230250", form: "quad", slots: ["2P30", "2P50"] }],
  ];
  it.each(cases)("%s", (line, want) => {
    expect(inside(read(line))).toEqual(want);
  });

  it("the lines on ET's bills that are NOT breakers stay out: load centres, switches, receptacles, tubing, boxes", () => {
    for (const line of [
      "12/24CT 125A N3R Load Center",
      "ITE PN1632L1125C 125A Plug On Neutral Load Center",
      "40/60CT 200A LD-CTR (PN4060L1200C)",
      "1P 120V SEN SWITCH",
      "LUT MSOPS5MWH 1P Sensor Switch",
      "PS TM870W WHT 1P15A125V SW",
      "PS 3864 30A 125/250 Recpt",
      "Heat Shrink Tube 3/8 in 3P",
      "Steel City 2-Gang Square Device Wall Box (2G4D1234-10R)",
      "15A 125V GFCI RCPT",
      "SP 3WY CFL DMR",
      "NMB 12/2 w/gnd 250 ft coil",
      "Tax @ 9.00000%",
    ]) {
      expect(read(line).kind, line).toBe("not_breaker");
    }
    expect(read("12/24CT 125A N3R Load Center")).toEqual({ kind: "not_breaker", reason: "A Load Centre, Not A Breaker." });
  });
});

describe("J-011's materials lines", () => {
  it("reads the crew's words when they say the poles and amps", () => {
    expect(inside(read("20a twin breaker"))).toEqual({ code: null, form: "twin", slots: ["1P20", "1P20"] });
    expect(inside(read("Quad 2p - 30a - 1p-15s breaker"))).toEqual({ code: null, form: "quad", slots: ["1P15", "1P15", "2P30"] });
  });
  it("leaves the rest of the list alone", () => {
    for (const line of ["GFI", "4 prong 30a receptacle & fp", "White decora dimmer", "3 way switch", "Occupancy sensor - entry", "$$ remodel box", "31 outlets"]) {
      expect(read(line).kind, line).toBe("not_breaker");
    }
  });
  it("a part number on the line is read with its words", () => {
    expect(inside(read("Q220", "2P 20A breaker"))).toEqual({ code: "Q220", form: "double", slots: ["2P20"] });
  });
});

describe("the traps and the unknowns", () => {
  it("Q22020CT2 is two 2-pole 20s, not the quad it looks like", () => {
    expect(inside(read("SIEM Q22020CT2"))).toEqual({ code: "Q22020CT2", form: "quad", slots: ["2P20", "2P20"] });
    expect(inside(read("SIEM Q22020CT"))).toEqual({ code: "Q22020CT", form: "quad", slots: ["1P20", "1P20", "2P20"] });
    expect(QUAD_SWAPS.find((q) => q.part === "Q22020CT")?.trapWords).toBe("Not Q22020CT2, That Is Two 2-Pole 20s");
  });

  it("a breaker code this table doesn't know is unknown and says so; it is never extrapolated", () => {
    expect(read("SIEM Q22030CT")).toEqual({ kind: "unknown", code: "Q22030CT", reason: "Can't Read Q22030CT. Confirm What Is Inside It." });
    expect(read("SIEM Q3030 CB").kind).toBe("unknown");
    expect(read("QO1515 breaker").kind).toBe("unknown");
  });

  it("words and code that disagree are unknown, never one picked over the other (E-017's SP 15A [Q120])", () => {
    expect(read("SP 15A [Q120]")).toEqual({ kind: "unknown", code: "Q120", reason: "The Words Say 15A, But Q120 Is 1P 20A. Confirm Which." });
    expect(read("2P 20A CB (Q120)")).toEqual({ kind: "unknown", code: "Q120", reason: "The Words Say 2P, But Q120 Is 1P 20A. Confirm Which." });
  });

  it("a breaker whose words don't say its poles, or its amps, is unknown", () => {
    expect(read("20A breaker")).toEqual({ kind: "unknown", code: null, reason: "Says 20A But Not How Many Poles. Confirm." });
    expect(read("2P breaker")).toEqual({ kind: "unknown", code: null, reason: "Says 2P But Not Its Amps. Confirm." });
    expect(read("Quad breaker").kind).toBe("unknown");
    expect(read("twin breaker").kind).toBe("unknown");
    expect(read("SIEM Q120 and Q115 CB").kind).toBe("unknown");
  });

  it("a bedroom or a quarter is not a part number", () => {
    expect(read("BR2 outlets").kind).toBe("not_breaker");
    expect(decodeCode("Q1")).toBeNull();
  });

  it("the other families read exactly", () => {
    expect(inside(read("Eaton BR230"))).toEqual({ code: "BR230", form: "double", slots: ["2P30"] });
    expect(inside(read("CH120 CB"))).toEqual({ code: "CH120", form: "single", slots: ["1P20"] });
    expect(inside(read("GE THQL1120"))).toEqual({ code: "THQL1120", form: "single", slots: ["1P20"] });
    expect(inside(read("GE THQL2130"))).toEqual({ code: "THQL2130", form: "double", slots: ["2P30"] });
    expect(inside(read("HOM120PCAFI"))).toEqual({ code: "HOM120PCAFI", form: "single", slots: ["1P20 afci"] });
    expect(inside(read("QO120PDF"))).toEqual({ code: "QO120PDF", form: "single", slots: ["1P20 dual_function"] });
    expect(inside(read("Q230GF"))).toEqual({ code: "Q230GF", form: "double", slots: ["2P30 gfci"] });
    expect(inside(read("QA120AFC"))).toEqual({ code: "QA120AFC", form: "single", slots: ["1P20 afci"] });
    expect(inside(read("QSA2020SPD"))).toEqual({ code: "QSA2020SPD", form: "twin", slots: ["1P20 spd", "1P20 spd"] });
    expect(inside(read("Q22050CT"))).toEqual({ code: "Q22050CT", form: "quad", slots: ["1P20", "1P20", "2P50"] });
  });
});

describe("what to order", () => {
  it("a 2P 20A in a Siemens box is a Q220; a GFCI or an unknown family gives no part", () => {
    expect(partFor({ poles: 2, amps: 20, kind: null }, "siemens")).toBe("Q220");
    expect(partFor({ poles: 1, amps: 15, kind: null }, "square_d_homeline")).toBe("HOM115");
    expect(partFor({ poles: 1, amps: 20, kind: "gfci" }, "siemens")).toBeNull();
    expect(partFor({ poles: 2, amps: 20, kind: null }, null)).toBeNull();
  });
  it("the estimator's prompt carries the same table", () => {
    const t = promptCodeTable();
    expect(t).toContain("Q2020 = twin (1-pole 20A + 1-pole 20A)");
    expect(t).toContain("Q21530CT = quad (two 1-pole 15A plus one 2P 30A)");
    expect(t).toContain("Q22020CT2 is NOT a quad with 1-poles, it is two 2P breakers (2P 20A + 2P 20A)");
  });
});
