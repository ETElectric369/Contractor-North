import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE PLANS READER'S MODEL CALL, WITH THE MODEL STUBBED (never a paid call in a test). What goes to
 * the model (one PDF, or one photo of a sheet, and the prompt that says never guess), what is
 * metered, and how the answer is cleaned: bad sizes dropped rather than guessed, a sheet it couldn't
 * count named in plain words. (The photo's half is read-panel-photo.test.ts.)
 */

const meter = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: meter, modelFor: () => "claude-haiku-4-5" }));

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
    const r = await readPlanWithModel({ client, model: "m", media: { kind: "pdf", mime: "application/pdf" }, base64: "JVBER", name: "Honeysuckle E-sheets.pdf", orgId: "org-1" });
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
