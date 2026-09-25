import { describe, it, expect, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkupBox } from "./markup-box";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { markupBoxSeed, markupBoxStart, markupBoxWords } from "@/lib/invoice-markup";

/**
 * THE % BOX NEVER REPRICES ON ITS OWN (2026-09-25). On INV-078 the box read 15 over lines priced at
 * 11, and leaving it - or tapping Materials from Costs - sent the 15 back. It now starts at what the
 * lines are priced at, and the only doors that apply a number are Apply and Enter, and only once a
 * different number is typed.
 *
 * MarkupBox has no hooks, so it is called as a plain function and its element tree is walked: the
 * handlers exercised below are the ones the page wires, not a copy of them.
 */

type El = ReactElement<Record<string, any>>;

function walk(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
  } else if (isValidElement(node)) {
    const el = node as El;
    out.push(el);
    walk(el.props.children as ReactNode, out);
  }
  return out;
}

const INV_078 = markupBoxSeed({ kind: "one", pct: 11 }, 15);

function box(overrides: Partial<Parameters<typeof MarkupBox>[0]> = {}) {
  const onApply = vi.fn();
  const onChange = vi.fn();
  const start = markupBoxStart(INV_078);
  const props = {
    value: start.value,
    applied: start.applied,
    canApply: true,
    pending: false,
    words: markupBoxWords(INV_078, "Andrew Cohen"),
    onChange,
    onApply,
    ...overrides,
  };
  const tree = walk(MarkupBox(props));
  const key = (k: string) => {
    const span = tree.find((e) => typeof e.props.onKeyDown === "function")!;
    span.props.onKeyDown({ key: k, preventDefault: () => {} });
  };
  const blurAll = () => {
    for (const e of tree) if (typeof e.props.onBlur === "function") e.props.onBlur({});
  };
  return { tree, props, onApply, onChange, key, blurAll };
}

describe("the % box on an invoice priced at 11%", () => {
  it("renders 11 - not the customer's 15 - with what the lines are at, and no Apply", () => {
    const { props } = box();
    const html = renderToStaticMarkup(createElement(MarkupBox, props));
    expect(html).toContain('value="11"');
    expect(html).toContain("Priced at 11%");
    expect(html).toContain("Andrew Cohen&#x27;s usual is 15%");
    expect(html).not.toContain(">Apply<");
  });

  it("loading it, leaving it, and pressing Enter without a change never calls the import", () => {
    const b = box();
    b.blurAll();
    b.key("Enter");
    b.key("Tab");
    expect(b.onApply).not.toHaveBeenCalled();
    // Nothing on the box reprices on blur at all - the input is not handed an onBlur.
    const input = b.tree.find((e) => e.type === NumberInput)!;
    expect(input.props.onBlur).toBeUndefined();
    expect(b.tree.some((e) => e.type === Button)).toBe(false);
  });

  it("typing a number hands it up; leaving the box after typing still applies nothing", () => {
    const b = box();
    const input = b.tree.find((e) => e.type === NumberInput)!;
    input.props.onValueChange(15);
    expect(b.onChange).toHaveBeenCalledWith(15);
    const typed = box({ value: 15 });
    typed.blurAll();
    expect(typed.onApply).not.toHaveBeenCalled();
  });

  it("a typed number shows Apply; Apply or Enter applies it, once", () => {
    const typed = box({ value: 15 });
    const apply = typed.tree.find((e) => e.type === Button)!;
    expect(apply.props.children).toBe("Apply");
    apply.props.onClick();
    expect(typed.onApply).toHaveBeenCalledTimes(1);
    const viaEnter = box({ value: 15 });
    viaEnter.key("Enter");
    expect(viaEnter.onApply).toHaveBeenCalledTimes(1);
  });

  it("while an import runs, Enter does nothing and Apply is disabled", () => {
    const busy = box({ value: 15, pending: true });
    busy.key("Enter");
    expect(busy.onApply).not.toHaveBeenCalled();
    expect(busy.tree.find((e) => e.type === Button)!.props.disabled).toBe(true);
  });

  it("no materials lines yet: no Apply - the box is only the figure Materials from Costs will use", () => {
    const fresh = box({ value: 20, canApply: false, words: { main: null, usual: null } });
    fresh.key("Enter");
    expect(fresh.onApply).not.toHaveBeenCalled();
    expect(fresh.tree.some((e) => e.type === Button)).toBe(false);
  });

  it("lines at different markups say so beside the box", () => {
    const mixed = markupBoxSeed({ kind: "mixed" }, 15);
    const html = renderToStaticMarkup(createElement(MarkupBox, { ...box().props, value: 15, applied: 15, words: markupBoxWords(mixed, "Andrew Cohen") }));
    expect(html).toContain('value="15"');
    expect(html).toContain("Lines are at different markups");
  });
});
