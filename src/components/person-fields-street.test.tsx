import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A STORED TOWN SURVIVES TYPING IN THE STREET BOX (cn-v1171, skeptic #74). A stored street with its
 * town is drawn like a pick (the grey line), and the block cleared the town on the first keystroke
 * over it, so editing a stored street erased the stored city, state and ZIP on save, in the lead's
 * Edit Details and in Edit Customer alike. Only a town a suggestion resolved in this sitting is
 * cleared now. The address box is stood in for so its two callbacks can be called the way the real
 * one calls them; each patch is applied and the form drawn again, and the hidden inputs are read.
 */
type Parts = { line1: string; city?: string; state?: string; zip?: string };
const box: { onTextChange?: (v: string) => void; onResolved?: (p: Parts) => void } = {};
vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: (p: { onTextChange?: (v: string) => void; onResolved?: (p: Parts) => void; defaultValue?: string }) => {
    box.onTextChange = p.onTextChange;
    box.onResolved = p.onResolved;
    return createElement("input", { name: "address", defaultValue: p.defaultValue });
  },
}));

const { InquiryFields, inquiryFormValue } = await import("@/app/(app)/leads/inquiry-fields");
const { CustomerFields, customerFormValue } = await import("./customer-fields");

const hidden = (html: string, n: string) => html.match(new RegExp(`type="hidden" name="${n}" value="([^"]*)"`))?.[1];
const town = (html: string) => [hidden(html, "city"), hidden(html, "state"), hidden(html, "zip")];

/** Draw a form, run `act` against the address box, and return the value after every patch. */
function session<V extends object>(draw: (v: V, on: (p: Partial<V>) => void) => ReactElement, start: V, act: (b: typeof box) => void): string {
  let v = start;
  renderToStaticMarkup(draw(v, (p) => { v = { ...v, ...p }; }));
  act(box);
  return renderToStaticMarkup(draw(v, () => {}));
}

const stored = { name: "Dana Rook", address: "12 Larkspur Ln", city: "Bayberry", state: "CA", zip: "96161" };

const forms = [
  ["the lead form", (start: object) => (act: (b: typeof box) => void) =>
    session((v, on) => createElement(InquiryFields, { value: v as never, onChange: on as never, sources: [] }), { ...inquiryFormValue(start as never) }, act)],
  ["the customer form", (start: object) => (act: (b: typeof box) => void) =>
    session((v, on) => createElement(CustomerFields, { value: v as never, onChange: on as never, mode: "edit" }), { ...customerFormValue(start as never) }, act)],
] as const;

describe.each(forms)("%s", (_name, run) => {
  it("typing over a STORED street keeps the stored city, state and ZIP posting", () => {
    const html = run(stored)((b) => {
      b.onTextChange!("12 Larkspur Ln"); // the mount echo
      b.onTextChange!("14 Larkspur Ln");
    });
    expect(town(html)).toEqual(["Bayberry", "CA", "96161"]);
    expect(html).toContain("Bayberry, CA 96161");
  });

  it("a suggestion picked here, then typed over, clears its town as before", () => {
    const picked = run({ name: "Dana Rook" })((b) => {
      b.onResolved!({ line1: "3 Snowbell Way", city: "Thistlewood", state: "NV", zip: "89501" });
      b.onTextChange!("3 Snowbell Way"); // the text change that follows a pick
    });
    expect(town(picked)).toEqual(["Thistlewood", "NV", "89501"]);
    const typedOver = run({ name: "Dana Rook" })((b) => {
      b.onResolved!({ line1: "3 Snowbell Way", city: "Thistlewood", state: "NV", zip: "89501" });
      b.onTextChange!("3 Snowbell Way");
      b.onTextChange!("5 Snowbell Way");
    });
    expect(town(typedOver)).toEqual(["", "", ""]);
  });

  it("a stored street that is then replaced by a pick, and typed over, clears the pick's town", () => {
    const html = run(stored)((b) => {
      b.onResolved!({ line1: "9 Catbird Ct", city: "Thistlewood", state: "NV", zip: "89501" });
      b.onTextChange!("9 Catbird Ct");
      b.onTextChange!("9 Catbird Court");
    });
    expect(town(html)).toEqual(["", "", ""]);
  });
});
