/**
 * WHICH FIELDS DID THIS FORM ACTUALLY SEND?
 *
 * Extracted so the rule is testable, because the rule is the whole safety property: a FormData
 * distinguishes NOT SUBMITTED from SUBMITTED BLANK, and code that reads `formData.get(k) ?? default`
 * throws that distinction away. updateOrganization did exactly that for every column on the
 * organizations row — which is survivable while ONE giant form posts to it, and stops being
 * survivable the moment Settings splits into per-pane forms.
 *
 * What the old shape would have done to a "change your phone number" pane:
 *     name absent            → renamed the company to "My Company"
 *     default_tax_pct absent → set the tax rate to 0
 *     timezone absent        → moved the business to America/Los_Angeles
 *     glass_tint absent      → reset the brand colour to #1b9488
 */
export function patchFrom<T extends Record<string, (v: FormDataEntryValue | null) => unknown>>(
  formData: Pick<FormData, "has" | "get">,
  fields: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, coerce] of Object.entries(fields)) {
    if (!formData.has(key)) continue; // never mentioned → never written
    out[key] = coerce(formData.get(key));
  }
  return out;
}
