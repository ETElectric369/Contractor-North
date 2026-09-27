import { describe, it, expect } from "vitest";
import { claimsOffTheirPerson, laborKeyPerson, laborLinePerson, planClaimsByPerson, type ClaimingLine } from "./labor-claim-owner";

/**
 * EACH LABOR CLAIM ON ITS OWN PERSON'S LINE, pinned on the shapes ET's paid invoices really had
 * (2026-09-26, read from production; ids shortened where the full uuid adds nothing).
 */
const ERIK = "d358effe-e352-401b-93bb-7dde456e9bc0";
const BRIAN = "07b85435-02ff-4382-a4f1-1f932c561d9f";
const people = [
  { id: ERIK, name: "Erik Taylor" },
  { id: BRIAN, name: "Brian Taylor" },
];

describe("whose line it is", () => {
  it("a key names its person, a legacy overflow key too; anything else is not a key", () => {
    expect(laborKeyPerson(`labor:${ERIK}`)).toBe(ERIK);
    expect(laborKeyPerson(`labor:${BRIAN}:2`)).toBe(BRIAN);
    expect(laborKeyPerson("labor:unknown")).toBeNull();
    expect(laborKeyPerson(`bill:${ERIK}`)).toBeNull();
    expect(laborKeyPerson(null)).toBeNull();
    // Upper case is not how Postgres prints a uuid, and 0361's trigger reads lower case only.
    expect(laborKeyPerson(`labor:${ERIK.toUpperCase()}`)).toBeNull();
  });

  it("a line typed by hand names its person by full name, else first name, as a whole word", () => {
    expect(laborLinePerson({ description: "Labor — Erik Taylor" }, people)).toBe(ERIK);
    expect(laborLinePerson({ description: "Labor - Brian" }, people)).toBe(BRIAN);
    expect(laborLinePerson({ description: "Labor - Erik " }, people)).toBe(ERIK); // INV-059's, trailing space and all
    expect(laborLinePerson({ description: "Labor, Brian (rewired kitchen switches)" }, people)).toBe(BRIAN);
    expect(laborLinePerson({ description: "Labor - Eriksen" }, people)).toBeNull();
  });

  it("a crew line is nobody's: no name, or two", () => {
    expect(laborLinePerson({ description: "Labor - ET Electric hourly with 2 guys" }, people)).toBeNull(); // INV-055
    expect(laborLinePerson({ description: "Labor - Erik & Brian" }, people)).toBeNull();
    // "Taylor" is both men's name: it names nobody in particular.
    expect(laborLinePerson({ description: "Labor - Taylor crew" }, people)).toBeNull();
  });

  it("the key wins over the words", () => {
    expect(laborLinePerson({ import_key: `labor:${BRIAN}`, description: "Labor - Erik Taylor" }, people)).toBe(BRIAN);
  });
});

describe("INV-050 as 0256 left it: Erik's line held Brian's four J-030 shifts, Brian's held none", () => {
  const erik5 = ["a9446e6d", "f414da54", "cf5a28a6", "71bbce8e", "66c752c7"];
  const brian4 = ["4e9d3b1f", "05d04559", "bd5a131d", "6399a8b7"];
  const ownerOf = new Map([...erik5.map((id) => [id, ERIK] as const), ...brian4.map((id) => [id, BRIAN] as const)]);
  // Held in the order the row had them: Brian's and Erik's interleaved.
  const erikLine: ClaimingLine = { id: "06f910de", description: "Labor — Erik Taylor", source_ids: ["05d04559", "66c752c7", "f414da54", "bd5a131d", "71bbce8e", "6399a8b7", "a9446e6d", "cf5a28a6", "4e9d3b1f"] };
  const brianLine: ClaimingLine = { id: "7bd0c098", description: "Labor — Brian Taylor", source_ids: [] };

  it("is found: the Erik line holds four ids that are Brian's", () => {
    expect(claimsOffTheirPerson([erikLine, brianLine], people, ownerOf)).toEqual([
      { lineId: "06f910de", person: ERIK, ids: ["05d04559", "bd5a131d", "6399a8b7", "4e9d3b1f"] },
    ]);
  });

  it("each claim goes to its own person's line, nothing added or dropped", () => {
    const plan = planClaimsByPerson([erikLine, brianLine], people, ownerOf);
    expect(plan).toEqual({
      ok: true,
      moves: [
        { lineId: "06f910de", before: erikLine.source_ids, after: ["66c752c7", "f414da54", "71bbce8e", "a9446e6d", "cf5a28a6"] },
        { lineId: "7bd0c098", before: [], after: ["05d04559", "bd5a131d", "6399a8b7", "4e9d3b1f"] },
      ],
    });
    if (!plan.ok) return;
    const all = plan.moves.flatMap((m) => m.after).sort();
    expect(all).toEqual([...erik5, ...brian4].sort());
  });

  it("run again on the re-pointed lines, it has nothing to do", () => {
    const plan = planClaimsByPerson(
      [
        { ...erikLine, source_ids: ["66c752c7", "f414da54", "71bbce8e", "a9446e6d", "cf5a28a6"] },
        { ...brianLine, source_ids: brian4 },
      ],
      people,
      ownerOf,
    );
    expect(plan).toEqual({ ok: true, moves: [] });
  });
});

describe("INV-00032: a retired split id follows the shift it became", () => {
  // 6bd5380f became Brian's 0bc53134; bcf29e88 became Erik's 65e608c7 (the retired split rows' `became`, 0289).
  const ownerOf = new Map([
    ["0bc53134", BRIAN],
    ["6bd5380f", BRIAN],
    ["65e608c7", ERIK],
    ["bcf29e88", ERIK],
  ]);
  it("Erik's hour and its old split id both go to Erik's line; Brian's line keeps his own", () => {
    const plan = planClaimsByPerson(
      [
        { id: "d8d52e98", description: "Labor — Brian Taylor", source_ids: ["6bd5380f", "0bc53134", "bcf29e88", "65e608c7"] },
        { id: "227bc934", description: "Labor — Erik Taylor", source_ids: [] },
      ],
      people,
      ownerOf,
    );
    expect(plan).toEqual({
      ok: true,
      moves: [
        { lineId: "d8d52e98", before: ["6bd5380f", "0bc53134", "bcf29e88", "65e608c7"], after: ["6bd5380f", "0bc53134"] },
        { lineId: "227bc934", before: [], after: ["bcf29e88", "65e608c7"] },
      ],
    });
  });

  it("an id whose person nobody knows stays where it is", () => {
    const plan = planClaimsByPerson(
      [
        { id: "b", description: "Labor — Brian Taylor", source_ids: ["mystery", "65e608c7"] },
        { id: "e", description: "Labor — Erik Taylor", source_ids: [] },
      ],
      people,
      ownerOf,
    );
    expect(plan).toEqual({
      ok: true,
      moves: [
        { lineId: "b", before: ["mystery", "65e608c7"], after: ["mystery"] },
        { lineId: "e", before: [], after: ["65e608c7"] },
      ],
    });
  });
});

describe("INV-059: two hand-typed lines named by first name only", () => {
  it("Brian's line gives Erik's 8/12 shift to 'Labor - Erik '", () => {
    const ownerOf = new Map([
      ["0ce98b6d", BRIAN],
      ["39c90754", ERIK],
    ]);
    const plan = planClaimsByPerson(
      [
        { id: "6180893e", description: "Labor - Brian", source_ids: ["0ce98b6d", "39c90754"] },
        { id: "f5edacb8", description: "Labor - Erik ", source_ids: [] },
      ],
      people,
      ownerOf,
    );
    expect(plan).toEqual({
      ok: true,
      moves: [
        { lineId: "6180893e", before: ["0ce98b6d", "39c90754"], after: ["0ce98b6d"] },
        { lineId: "f5edacb8", before: [], after: ["39c90754"] },
      ],
    });
  });
});

describe("what is never moved", () => {
  const ownerOf = new Map([
    ["e1", ERIK],
    ["e2", ERIK],
    ["b1", BRIAN],
    ["b2", BRIAN],
  ]);

  it("INV-055's crew line holds both men's hours and that is not crossed", () => {
    const crew = { id: "cdfe8178", description: "Labor - ET Electric hourly with 2 guys", source_ids: ["e1", "b1", "e2", "b2"] };
    expect(claimsOffTheirPerson([crew], people, ownerOf)).toEqual([]);
    expect(planClaimsByPerson([crew], people, ownerOf)).toEqual({ ok: true, moves: [] });
  });

  it("a crew line beside the crossed ones: not certain, left for a person", () => {
    const plan = planClaimsByPerson(
      [
        { id: "e", description: "Labor — Erik Taylor", source_ids: ["e1", "b1"] },
        { id: "b", description: "Labor — Brian Taylor", source_ids: [] },
        { id: "c", description: "Labor - helper", source_ids: [] },
      ],
      people,
      ownerOf,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toMatch(/"Labor - helper" names nobody/);
  });

  it("a person with two lines: not certain", () => {
    const plan = planClaimsByPerson(
      [
        { id: "e", description: "Labor — Erik Taylor", source_ids: ["b1"] },
        { id: "b", description: "Labor — Brian Taylor", source_ids: [] },
        { id: "b2", description: "Labor - Brian (overtime)", source_ids: [] },
      ],
      people,
      ownerOf,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toMatch(/both the same person's line/);
  });

  it("hours of a person with no line on the invoice: not certain", () => {
    const plan = planClaimsByPerson([{ id: "e", description: "Labor — Erik Taylor", source_ids: ["e1", "b1"] }], people, ownerOf);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toMatch(/no line on this invoice/);
  });

  it("an id on both lines of one invoice ends on its own line once", () => {
    const plan = planClaimsByPerson(
      [
        { id: "e", description: "Labor — Erik Taylor", source_ids: ["e1", "b1"] },
        { id: "b", description: "Labor — Brian Taylor", source_ids: ["b1"] },
      ],
      people,
      ownerOf,
    );
    expect(plan).toEqual({ ok: true, moves: [{ lineId: "e", before: ["e1", "b1"], after: ["e1"] }] });
  });
});

describe("a keyed line (what 0361 guards in the database)", () => {
  it("labor:<Erik> holding Brian's shift is found whatever its words say", () => {
    const ownerOf = new Map([
      ["e1", ERIK],
      ["b1", BRIAN],
    ]);
    expect(claimsOffTheirPerson([{ id: "k", import_key: `labor:${ERIK}`, description: "Labor - Crew", source_ids: ["e1", "b1"] }], [], ownerOf)).toEqual([
      { lineId: "k", person: ERIK, ids: ["b1"] },
    ]);
  });
});
