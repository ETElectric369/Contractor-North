import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A SEEDED ADDRESS IS A SUGGESTION (cn-v1173 fixer). A customer's New Lead starts from the customer's
 * street and town, but the new job may be at another property: typing a different street must drop the
 * customer's city, state and ZIP (as for a suggestion picked in this sitting), or the old town posts
 * silently under the new street. Untouched, the place posts whole. Every other form (Edit Customer, a
 * lead's Edit Details) keeps the cn-v1171 rule: a STORED town stays when its street is typed over.
 *
 * The address box is a stand-in that keeps the props it was drawn with, so the block's own handlers are
 * called as the box would call them.
 */
type BoxProps = { defaultValue?: string; onTextChange?: (v: string) => void; onResolved?: (p: { line1: string; city?: string; state?: string; zip?: string }) => void };
const box = vi.hoisted(() => ({ props: null as BoxProps | null }));
vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: (p: BoxProps) => {
    box.props = p;
    return null;
  },
}));

const { PersonFields, personValue } = await import("./person-fields");
const { InquiryFields, customerLeadFormValue } = await import("@/app/(app)/leads/inquiry-fields");

const SAM = { id: "c-sam", name: "Sam Tillery", phone: "(530) 555-0100", email: "sam@example.test", address: "4 Larkspur Ln", city: "Thistlewood", state: "CA", zip: "96161", company_name: "Snowbell Builders" };

let patches: Record<string, unknown>[] = [];
const onChange = (p: Record<string, unknown>) => void patches.push(p);
beforeEach(() => {
  patches = [];
  box.props = null;
});

describe("the customer's New Lead (seededTownIsSuggestion)", () => {
  const drawLead = () =>
    renderToStaticMarkup(createElement(InquiryFields, { value: customerLeadFormValue(SAM), onChange, sources: [], seededTownIsSuggestion: true }));

  it("a NEW street drops the customer's city, state and ZIP", () => {
    drawLead();
    box.props!.onTextChange!("9 Catbird Ct");
    expect(patches).toEqual([{ address: "9 Catbird Ct", city: "", state: "", zip: "", town_picked: false }]);
  });

  it("untouched, it posts whole: the mount's echo of the same street patches nothing, and the town is posted", () => {
    const html = drawLead();
    box.props!.onTextChange!("4 Larkspur Ln");
    expect(patches).toEqual([]);
    for (const [k, v] of [["city", "Thistlewood"], ["state", "CA"], ["zip", "96161"]]) expect(html).toContain(`name="${k}" value="${v}"`);
    expect(box.props!.defaultValue).toBe("4 Larkspur Ln");
  });

  it("a customer with a street and no town has nothing to drop: typing is a plain street change", () => {
    renderToStaticMarkup(createElement(PersonFields, { value: personValue({ ...SAM, city: null, state: null, zip: null }), onChange, seededTownIsSuggestion: true }));
    box.props!.onTextChange!("9 Catbird Ct");
    expect(patches).toEqual([{ address: "9 Catbird Ct" }]);
  });
});

describe("every other form: a stored town stays (cn-v1171, unchanged)", () => {
  it("the lead form without the flag (Edit Details, the Leads page's New Lead)", () => {
    renderToStaticMarkup(createElement(InquiryFields, { value: customerLeadFormValue(SAM), onChange, sources: [] }));
    box.props!.onTextChange!("9 Catbird Ct");
    expect(patches).toEqual([{ address: "9 Catbird Ct" }]);
  });

  it("the block on its own (Edit Customer's)", () => {
    renderToStaticMarkup(createElement(PersonFields, { value: personValue(SAM), onChange }));
    box.props!.onTextChange!("9 Catbird Ct");
    expect(patches).toEqual([{ address: "9 Catbird Ct" }]);
  });
});
