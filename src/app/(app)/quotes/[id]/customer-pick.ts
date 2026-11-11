/**
 * THE PICK IS THE SAVE. Choosing a name in the estimate's customer box writes it at once; there is
 * no second tap to forget. Kept out of the component so it can be driven without a DOM.
 * The empty value is a deliberate write too: it clears the customer.
 */
export type PickResult = { ok: boolean; error?: string };

export async function commitCustomerPick(
  quoteId: string,
  value: string,
  deps: {
    setQuoteCustomer: (quoteId: string, customerId: string | null) => Promise<PickResult>;
    /** The sentence used when the server refuses without saying why. */
    fallbackError: string;
  },
): Promise<PickResult> {
  try {
    const res = await deps.setQuoteCustomer(quoteId, value || null);
    if (!res.ok) return { ok: false, error: res.error || deps.fallbackError };
    return { ok: true };
  } catch {
    return { ok: false, error: deps.fallbackError };
  }
}
