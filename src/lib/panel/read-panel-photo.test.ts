import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * READ A PHOTO, THE MODEL'S HALF, WITH THE MODEL STUBBED (never a paid call in a test). The prompt
 * reads the door the way the label strips are built (one line per handle, a tandem as A then B, a
 * 2-pole's words on both its lines, a quad's centre 2-pole at half B), the call is metered as
 * panel-photo under the token cap, and the parser folds the lines into one row per breaker — pinned
 * on a 24-space Siemens door of 34 circuits (stand-in words, __fixtures__/door-24).
 */

const meter = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: meter, modelFor: () => "claude-haiku-4-5" }));

import { PHOTO_MAX_TOKENS, PHOTO_SYSTEM, parsePanelPhoto, photoMime, readPanelPhotoWithModel } from "./read-panel-photo";
import { landRead } from "./readers";
import { DOOR_24, DOOR_24_REPLY } from "./__fixtures__/door-24";

function stubModel(reply: string, stop = "end_turn") {
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: reply }],
    stop_reason: stop,
    usage: { input_tokens: 1800, output_tokens: 900 },
  }));
  return { client: { messages: { create } } as never, create };
}

beforeEach(() => meter.mockClear());

describe("the prompt: the sheet model, said to the model", () => {
  it("asks for one line per handle, space by space, with space, half, poles, amps and label", () => {
    expect(PHOTO_SYSTEM).toMatch(/ONE LINE PER HANDLE/);
    expect(PHOTO_SYSTEM).toMatch(/within a space give its handles top to bottom/);
    expect(PHOTO_SYSTEM).toMatch(/"lines": \[\{"space": number, "half": "A"\|"B"\|null, "poles": 1\|2\|3, "amps": number\|null, "label": string\|null/);
    // A tandem is two lines, A then B.
    expect(PHOTO_SYSTEM).toMatch(/A tandem \(twin\) in one space: two lines, half A \(the top handle\) then half B/);
    // A 2-pole is the same words on both of its lines.
    expect(PHOTO_SYSTEM).toMatch(/A 2-pole covers space s and s\+2 on the same side: one line on EACH of its two spaces, the same label on both, poles 2/);
    // A quad: outer singles and ONE centre 2-pole — BOTH ways a door is numbered, in one sentence,
    // from the model's one rule (quadCentreHalf): centre at s half B top down, s half A bottom up.
    const quad = PHOTO_SYSTEM.split(/(?<=\. )/).filter((s) => s.startsWith("A quad"));
    expect(quad).toHaveLength(1);
    expect(quad[0]).toContain(
      "where space 1 is at the top, the centre is space s half B and space s+2 half A, the outer singles space s half A (the top handle) and space s+2 half B (the bottom one)",
    );
    expect(quad[0]).toContain(
      "where space 1 is at the bottom (s+2 hangs above s), the centre is space s half A and space s+2 half B, the outer singles space s+2 half A (the top handle) and space s half B (the bottom one)",
    );
  });

  it("never guesses, and never invents a space the photo doesn't show", () => {
    expect(PHOTO_SYSTEM).toMatch(/Never guess a label, an amps figure or a space number, and never invent a space the photo does not show/);
    expect(PHOTO_SYSTEM).toMatch(/Leave out a space with nothing in it/);
  });

  it("reads the panel's own facts, the No Stab spaces among them, only when it can see them", () => {
    expect(PHOTO_SYSTEM).toMatch(/"panel": \{"brand": string\|null, "main_amps": number\|null, "spaces": number\|null, "no_stab_spaces": number\[\]\}/);
    expect(PHOTO_SYSTEM).toMatch(/no_stab_spaces = the spaces where the bus has no stab \(crimped or blocked off\), only when you can see it, else \[\]/);
  });
});

describe("the model call", () => {
  it("sends ONE image with the prompt, under the token cap, and meters it as panel-photo", async () => {
    const { client, create } = stubModel("```json\n" + JSON.stringify(DOOR_24_REPLY) + "\n```");
    const r = await readPanelPhotoWithModel({ client, model: "claude-opus-4-8", mime: "image/jpeg", base64: "AAAA", orgId: "org-1" });
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0] as unknown as [{ model: string; system: string; max_tokens: number; messages: { content: { type: string; source?: { media_type: string } }[] }[] }];
    expect(sent[0].model).toBe("claude-opus-4-8");
    expect(sent[0].system).toBe(PHOTO_SYSTEM);
    expect(sent[0].max_tokens).toBe(PHOTO_MAX_TOKENS);
    expect(PHOTO_MAX_TOKENS).toBe(3000);
    expect(sent[0].messages[0].content).toHaveLength(2);
    expect(sent[0].messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg" } });
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", surface: "panel-photo", model: "claude-opus-4-8" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.rows).toHaveLength(34);
  });

  it("a reply cut off by the token ceiling is said, never parsed as if whole", async () => {
    const { client } = stubModel('{"lines": [{"space": 1', "max_tokens");
    const r = await readPanelPhotoWithModel({ client, model: "m", mime: "image/png", base64: "AAAA", orgId: "org-1" });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/closer photo/) });
    expect(meter).toHaveBeenCalledTimes(1); // it still cost something, so it is still on the ledger
  });

  it("only a photo the model can read is sent: HEIC and PDF are not photos to it", () => {
    expect(photoMime("IMG_1234.JPG")).toBe("image/jpeg");
    expect(photoMime(null, "org/job/1727-panel.webp")).toBe("image/webp");
    expect(photoMime("IMG_1234.HEIC")).toBeNull();
    expect(photoMime("plans.pdf")).toBeNull();
  });
});

describe("the parser, on the 24-space Siemens door", () => {
  const reading = parsePanelPhoto(DOOR_24_REPLY);

  it("39 handles fold into 34 breakers, one row each, in space order", () => {
    expect(DOOR_24_REPLY.lines).toHaveLength(39);
    expect(reading.rows.map((r) => [r.space, r.half, r.poles, r.said])).toEqual(DOOR_24);
    expect(reading.rows.every((r) => r.work === "existing")).toBe(true);
    expect(reading.unreadable).toEqual([]);
    expect(reading.header).toEqual({ brand: "Siemens", main_amps: 200, spaces: 24, dead_spaces: [] });
  });

  it("the panel's No Stab spaces ride in the header, cleaned: only spaces this panel has, once each", () => {
    const r = parsePanelPhoto({ panel: { brand: "Siemens", main_amps: 200, spaces: 24, no_stab_spaces: [24, 23, "23", 30, "x"] }, lines: [] });
    expect(r.header.dead_spaces).toEqual([23, 24]);
  });

  it("a quad on a door numbered bottom up: its centre 2-pole folds at the first space's A half, the outer singles at sB and (s+2)A", () => {
    const up = parsePanelPhoto({
      panel: { spaces: 24 },
      lines: [
        { space: 3, half: "A", label: "Garage", amps: 15, poles: 1 },
        { space: 3, half: "B", label: "Floor Heat", amps: 20, poles: 2 },
        { space: 1, half: "A", label: "Floor Heat", amps: 20, poles: 2 },
        { space: 1, half: "B", label: "Porch", amps: 15, poles: 1 },
      ],
    });
    expect(up.rows.map((r) => [r.space, r.half, r.poles, r.said])).toEqual([
      [1, "A", 2, "Floor Heat"],
      [1, "B", 1, "Porch"],
      [3, "A", 1, "Garage"],
    ]);
  });

  it("the three quads: outer singles, and the centre 2-pole at the first space's B half", () => {
    const at = (space: number, half: string | null) => reading.rows.find((r) => r.space === space && r.half === half);
    expect(at(1, "B")).toMatchObject({ said: "Floor Heat", poles: 2, amps: 20 });
    expect(at(13, "B")).toMatchObject({ said: "Dryer", poles: 2, amps: 30 });
    expect(at(2, "B")).toMatchObject({ said: "TVSS", poles: 2, kind: "spd" });
    // The centre's second handle (3A, 15A, 4A) is the same breaker, not a circuit of its own.
    expect(at(3, "A")).toBeUndefined();
    expect(at(15, "A")).toBeUndefined();
    expect(at(4, "A")).toBeUndefined();
    expect(at(1, "A")).toMatchObject({ said: "Garage", poles: 1 });
    expect(at(3, "B")).toMatchObject({ said: "Garage", poles: 1 });
  });

  it("the full-width 2-poles sit at their first space; the single takes its whole space; 20 and 24 stay empty", () => {
    expect(reading.rows.filter((r) => r.said === "Mini Split")).toEqual([expect.objectContaining({ space: 9, half: null, poles: 2 })]);
    expect(reading.rows.filter((r) => r.said === "EV Charger")).toEqual([expect.objectContaining({ space: 6, half: null, poles: 2, amps: 50 })]);
    expect(reading.rows.filter((r) => r.space === 19)).toEqual([expect.objectContaining({ half: null, poles: 1, said: "Laundry" })]);
    expect(reading.rows.some((r) => r.space === 20 || r.space === 24 || r.space === 11 || r.space === 8)).toBe(false);
  });

  it("the same words on two spaces are two circuits (the door's two Garage singles), and every breaker has words", () => {
    expect(reading.rows.filter((r) => r.said === "Garage").map((r) => [r.space, r.half, r.poles])).toEqual([
      [1, "A", 1],
      [3, "B", 1],
    ]);
    expect(reading.rows.every((r) => !!r.said)).toBe(true);
  });

  it("on an empty panel every breaker lands in its own space, the quad centres at half B, both Garages", () => {
    const l = landRead(reading.rows, [], { panelId: "p1" });
    expect(l.toWrite).toHaveLength(34);
    expect(l.skipped).toEqual([]);
    expect(l.toWrite.find((d) => d.panel_label === "Floor Heat")).toMatchObject({ space: 1, half: "B", poles: 2, state: "suggested", source: "photo" });
    expect(l.toWrite.filter((d) => d.panel_label === "Garage").map((d) => [d.space, d.half])).toEqual([
      [1, "A"],
      [3, "B"],
    ]);
  });
});

describe("the parser's edges", () => {
  it("bad sizes are dropped to null, never rounded to a guess; a 2-pole read on one line only stands alone", () => {
    const r = parsePanelPhoto({
      panel: { brand: "Siemens", main_amps: 125, spaces: 32 },
      lines: [
        { space: 1, half: null, label: "Larkspur Lights", amps: 20, poles: 1, kind: "standard" },
        { space: 7, label: "40A 2-Pole", amps: 40, poles: 2 },
        { space: 11, half: "a", label: "GDO #1", amps: "?", poles: 1, kind: "SPD" },
        { space: 13, label: "Snowbell 15", amps: 17, kind: "arc fault" },
      ],
    });
    expect(r.rows.map((x) => [x.space, x.half, x.said, x.amps, x.poles, x.kind])).toEqual([
      [1, null, "Larkspur Lights", 20, 1, "standard"],
      [7, null, "40A 2-Pole", 40, 2, null],
      [11, "A", "GDO #1", null, 1, "spd"],
      // 17 isn't a breaker size: dropped to "not read", never rounded to a guess.
      [13, null, "Snowbell 15", null, 1, "afci"],
    ]);
  });

  it("a line with no space, or one the panel can't have, can't land: it is named, never dropped quietly", () => {
    const r = parsePanelPhoto({
      panel: { spaces: 32 },
      lines: [
        { space: 99, label: "Off The End" },
        { space: null, label: "Bayberry Fan" },
        { space: null, label: null, amps: 20 },
        { space: 3, label: null, amps: null },
      ],
      unreadable: ["Space 9's label is torn off", ""],
    });
    expect(r.rows).toEqual([]);
    expect(r.unreadable).toEqual([
      "Space 9's label is torn off",
      '"Off The End" is on space 99, which isn\'t on a 32-space panel.',
      '"Bayberry Fan" had no space number the photo showed.',
      "A 20A breaker had no space number the photo showed.",
    ]);
  });

  it("an answer in the old shape (circuits, not lines) still reads; nothing at all reads as nothing", () => {
    expect(parsePanelPhoto({ circuits: [{ space: 5, label: "Thistlewood Hall", amps: 15 }] }).rows).toEqual([
      expect.objectContaining({ space: 5, said: "Thistlewood Hall", amps: 15 }),
    ]);
    expect(parsePanelPhoto(null)).toEqual({ header: { brand: null, main_amps: null, spaces: null, dead_spaces: [] }, rows: [], unreadable: [] });
  });
});
