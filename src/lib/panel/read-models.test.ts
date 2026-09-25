import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE TWO READERS' MODEL CALLS, WITH THE MODEL STUBBED (never a paid call in a test). What goes to
 * the model (one image, or one PDF, and the prompt that says never guess), what is metered, and how
 * the answer is cleaned: bad sizes dropped rather than guessed, a sheet it couldn't count named in
 * plain words, a reply cut off by the token ceiling said, never parsed as if whole.
 */

const meter = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: meter, modelFor: () => "claude-haiku-4-5" }));

import { PHOTO_SYSTEM, parsePanelPhoto, photoMime, readPanelPhotoWithModel } from "./read-panel-photo";
import { parsePlanCircuits, planMedia, readPlanWithModel } from "./read-plan-circuits";

function stubModel(reply: string, stop = "end_turn") {
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: reply }],
    stop_reason: stop,
    usage: { input_tokens: 1800, output_tokens: 900 },
  }));
  return { client: { messages: { create } } as never, create };
}

beforeEach(() => meter.mockClear());

describe("Read The Panel Photo: the model call", () => {
  it("sends ONE image with the never-guess prompt, meters it as panel-photo, and cleans the answer", async () => {
    const reply = JSON.stringify({
      panel: { brand: "Siemens", main_amps: 125, spaces: 32, no_stab_spaces: [31, "32", 99] },
      circuits: [
        { space: 1, half: null, label: "Garage", amps: 20, poles: 1, kind: "standard" },
        { space: 7, label: "40A 2-Pole", amps: 40, poles: 2 },
        { space: 11, half: "a", label: "GDO #1", amps: "?", poles: 1, kind: "SPD" },
        { space: 13, label: "Garage 15", amps: 17, kind: "arc fault" },
        { space: null, label: null, amps: 20 },
        { space: 99, label: "Off the end" },
      ],
      unreadable: ["Space 9's label is torn off", ""],
    });
    const { client, create } = stubModel("```json\n" + reply + "\n```");
    const r = await readPanelPhotoWithModel({ client, model: "claude-opus-4-8", mime: "image/jpeg", base64: "AAAA", orgId: "org-1" });
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0] as unknown as [{ system: string; max_tokens: number; messages: { content: { type: string; source?: { media_type: string } }[] }[] }];
    expect(sent[0].system).toBe(PHOTO_SYSTEM);
    expect(sent[0].system).toMatch(/Never guess/);
    expect(sent[0].max_tokens).toBeLessThanOrEqual(3000);
    expect(sent[0].messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg" } });
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", surface: "panel-photo" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.header).toEqual({ brand: "Siemens", main_amps: 125, spaces: 32, dead_spaces: [31, 32] });
    expect(r.reading.rows.map((x) => [x.space, x.half, x.said, x.amps, x.poles, x.kind])).toEqual([
      [1, null, "Garage", 20, 1, "standard"],
      [7, null, "40A 2-Pole", 40, 2, null],
      [11, "A", "GDO #1", null, 1, "spd"],
      // 17 isn't a breaker size: dropped to "not read", never rounded to a guess.
      [13, null, "Garage 15", null, 1, "afci"],
      // Space 99 on a 32-space panel: the words come in, the space doesn't, and that is said below.
      [null, null, "Off the end", null, 1, null],
    ]);
    expect(r.reading.rows.every((x) => x.work === "existing")).toBe(true);
    expect(r.reading.unreadable).toEqual(["Space 9's label is torn off", "Off the end: Space 99 Isn't On A 32-Space Panel."]);
  });

  it("a reply cut off by the token ceiling is said, never parsed as if whole", async () => {
    const { client } = stubModel('{"circuits": [{"space": 1', "max_tokens");
    const r = await readPanelPhotoWithModel({ client, model: "m", mime: "image/png", base64: "AAAA", orgId: "org-1" });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/closer photo/) });
    expect(meter).toHaveBeenCalledTimes(1); // it still cost something, so it is still on the ledger
  });

  it("only a photo the model can read is sent: HEIC and PDF are not photos to it", () => {
    expect(photoMime("IMG_1234.JPG")).toBe("image/jpeg");
    expect(photoMime(null, "org/job/1727-panel.webp")).toBe("image/webp");
    expect(photoMime("IMG_1234.HEIC")).toBeNull();
    expect(photoMime("plans.pdf")).toBeNull();
    expect(parsePanelPhoto(null)).toEqual({ header: { brand: null, main_amps: null, spaces: null, dead_spaces: [] }, rows: [], unreadable: [] });
  });
});

describe("Read Circuits From The Plans: the model call", () => {
  it("sends ONE PDF as a document, meters it as panel-plans, and names the sheets it couldn't count", async () => {
    const reply = JSON.stringify({
      sheets_read: ["E-1", "E-2"],
      not_counted: [{ sheet: "MPE-1", why: "too dense to count reliably" }, { sheet: "E-3", why: "blurry scan" }, "M-1"],
      circuits: [
        { sheet: "E-1", ckt: "14", description: "Bath floor heat", breaker: "2P 20A", wire: "12/2", existing: false },
        { sheet: "E-1", ckt: "3", description: "Lighting", breaker: "SP 15A [Q120]" },
        { sheet: "E-2", ckt: "20", description: "Range", amps: 50, poles: 2, kind: "gfci", existing: true },
        { sheet: "E-2", ckt: "", description: "", breaker: "" },
      ],
    });
    const { client, create } = stubModel(reply);
    const r = await readPlanWithModel({ client, model: "m", media: { kind: "pdf", mime: "application/pdf" }, base64: "JVBER", name: "Herringbone E-sheets.pdf", orgId: "org-1" });
    const sent = create.mock.calls[0] as unknown as [{ messages: { content: { type: string }[] }[] }];
    expect(sent[0].messages[0].content[0]).toMatchObject({ type: "document" });
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ surface: "panel-plans" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.sheets).toEqual(["E-1", "E-2"]);
    expect(r.reading.notCounted).toEqual(["MPE-1 Was Too Dense To Count.", "E-3 Couldn't Be Read Clearly.", "M-1 Wasn't Counted."]);
    expect(r.reading.rows).toHaveLength(3);
    expect(r.reading.rows[0]).toMatchObject({ said: "Bath floor heat", amps: 20, poles: 2, space: null, work: "new", extra: { sheet: "E-1", ckt: "14", breaker: "2P 20A" } });
    // The plans' own mistake is said the way E-017's was, in the plans' name.
    expect(r.reading.rows[1]).toMatchObject({ amps: 15, poles: 1, check: "The plans say 1P 15A, but Q120 is a 1P 20A." });
    expect(r.reading.rows[2]).toMatchObject({ amps: 50, poles: 2, kind: "gfci", work: "existing" });
  });

  it("a PDF goes as a document, a photo of a sheet as an image, anything else not at all", () => {
    expect(planMedia("Plans.PDF")).toEqual({ kind: "pdf", mime: "application/pdf" });
    expect(planMedia("sheet-e1.jpg")).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(planMedia("plans.dwg")).toBeNull();
    expect(parsePlanCircuits({})).toEqual({ sheets: [], notCounted: [], rows: [] });
  });
});
