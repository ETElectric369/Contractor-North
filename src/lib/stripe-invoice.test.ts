import { describe, it, expect } from "vitest";
import { invoiceSubscriptionId } from "./stripe-invoice";

/**
 * THE INVOICE'S SUBSCRIPTION, IN BOTH SHAPES (cn-v1209). The endpoint's API version decides which
 * shape an event has; the webhook must find the subscription in either, or a declined card on a
 * subscription is skipped and the owner is never told.
 */
describe("invoiceSubscriptionId", () => {
  const newShape = (subscription: unknown) => ({ parent: { type: "subscription_details", subscription_details: { subscription } } });

  it("the old shape: invoice.subscription, as an id or as the expanded subscription", () => {
    expect(invoiceSubscriptionId({ subscription: "sub_1" })).toBe("sub_1");
    expect(invoiceSubscriptionId({ subscription: { id: "sub_2", status: "past_due" } })).toBe("sub_2");
  });

  it("the new shape: invoice.parent.subscription_details.subscription, as an id or expanded", () => {
    expect(invoiceSubscriptionId(newShape("sub_3"))).toBe("sub_3");
    expect(invoiceSubscriptionId(newShape({ id: "sub_4" }))).toBe("sub_4");
  });

  it("the old place is read first, and an empty old place falls through to the new one", () => {
    expect(invoiceSubscriptionId({ subscription: "sub_old", ...newShape("sub_new") })).toBe("sub_old");
    expect(invoiceSubscriptionId({ subscription: null, ...newShape("sub_new") })).toBe("sub_new");
    expect(invoiceSubscriptionId({ subscription: "", ...newShape("sub_new") })).toBe("sub_new");
    expect(invoiceSubscriptionId({ subscription: { id: "" }, ...newShape("sub_new") })).toBe("sub_new");
  });

  it("an invoice that belongs to no subscription answers null, whatever it carries instead", () => {
    expect(invoiceSubscriptionId({})).toBeNull();
    expect(invoiceSubscriptionId({ subscription: null, parent: null })).toBeNull();
    expect(invoiceSubscriptionId({ parent: { type: "quote_details", quote_details: { quote: "qt_1" }, subscription_details: null } })).toBeNull();
    expect(invoiceSubscriptionId(newShape(null))).toBeNull();
    expect(invoiceSubscriptionId(newShape(""))).toBeNull();
    expect(invoiceSubscriptionId(newShape({ id: 7 }))).toBeNull();
    expect(invoiceSubscriptionId({ subscription: 7, parent: "sub_1" })).toBeNull();
  });

  it("something that is not an invoice at all never throws", () => {
    for (const v of [null, undefined, 0, "sub_1", [], true]) expect(invoiceSubscriptionId(v)).toBeNull();
  });
});
