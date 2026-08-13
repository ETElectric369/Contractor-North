import { describe, it, expect } from "vitest";
import type { DraftLineItem } from "./line-map";

/**
 * THE READOUT'S RULES, as pure functions of the two lists.
 *
 * The component holds these in state, so this file pins the LOGIC that made the old readout
 * incoherent — the "mixing logics" Erik named: lines that inserted themselves while the box beside
 * them showed prose that could not become anything. The invariant that fixes it is simply that a
 * line is never in both lists.
 */

type Proposal = DraftLineItem & { pid: number; keep: boolean };

const propose = (items: DraftLineItem[]): Proposal[] =>
  items.filter((i) => i.description.trim()).map((i, n) => ({ ...i, pid: n, keep: true }));

const accept = (items: DraftLineItem[], proposed: Proposal[]) => {
  const taking = proposed.filter((p) => p.keep);
  const real = items.filter((i) => i.description.trim());
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    items: [...real, ...taking.map(({ pid, keep, ...line }) => line)],
    proposed: proposed.filter((p) => !p.keep),
  };
};

const line = (description: string, over: Partial<DraftLineItem> = {}): DraftLineItem => ({
  description,
  quantity: 1,
  unit: "ea",
  unit_price: 10,
  ...over,
});

describe("a proposal is on exactly one list", () => {
  it("a generate puts nothing on the estimate", () => {
    const items = [line("His own line")];
    const proposed = propose([line("Model line A"), line("Model line B")]);
    expect(items).toHaveLength(1);
    expect(proposed).toHaveLength(2);
  });

  it("accepting moves the ticked ones across and leaves the rest behind", () => {
    const items = [line("His own line")];
    const proposed = propose([line("A"), line("B"), line("C")]);
    proposed[1].keep = false;
    const out = accept(items, proposed);
    expect(out.items.map((i) => i.description)).toEqual(["His own line", "A", "C"]);
    expect(out.proposed.map((p) => p.description)).toEqual(["B"]);
  });

  it("and never leaves the bookkeeping fields on the estimate", () => {
    const out = accept([], propose([line("A")]));
    expect(out.items[0]).not.toHaveProperty("pid");
    expect(out.items[0]).not.toHaveProperty("keep");
  });

  it("accepting twice cannot add the same line twice", () => {
    const first = accept([], propose([line("A"), line("B")]));
    const second = accept(first.items, first.proposed);
    expect(second.items.map((i) => i.description)).toEqual(["A", "B"]);
  });
});

describe("the bugs that stop existing because nothing auto-inserts", () => {
  it("a SECOND generate replaces the proposals instead of doubling the estimate", () => {
    // The old applyDraft appended every line to `items`, so tweaking the scope wording and
    // pressing Generate again gave you both take-offs stacked, every material doubled.
    let proposed = propose([line("A"), line("B")]);
    proposed = propose([line("A"), line("B")]);
    expect(proposed).toHaveLength(2);
  });

  it("a line typed WHILE the model was thinking is still there afterwards", () => {
    // The old applyDraft wrote `[...itemsAtClick, ...res.items]` from a snapshot taken before a
    // twenty-to-sixty second call, so anything added in between was discarded.
    const typedDuring = [line("Typed while it thought")];
    const out = accept(typedDuring, propose([line("Model line")]));
    expect(out.items.map((i) => i.description)).toEqual(["Typed while it thought", "Model line"]);
  });

  it("a blank-description line never becomes a proposal", () => {
    // saveQuote drops a blank line at save, so on the old path it counted toward the subtotal he
    // read and then arrived as nothing — the total moved between the screen and the document.
    expect(propose([line("Real"), line("  "), line("")])).toHaveLength(1);
  });
});

describe("what survives an edit", () => {
  it("a corrected price is what lands, not the model's", () => {
    const proposed = propose([line("2x6 joist", { unit_price: 9.5, quantity: 40 })]);
    proposed[0].unit_price = 11.25;
    expect(accept([], proposed).items[0]).toMatchObject({ unit_price: 11.25, quantity: 40 });
  });

  it("dropping every proposal leaves the estimate exactly as it was", () => {
    const items = [line("His own line")];
    const out = accept(items, []);
    expect(out.items).toEqual(items);
  });
});
