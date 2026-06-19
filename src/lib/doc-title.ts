/** Join non-empty parts into a clean document title — used for the browser tab
 *  and, crucially, the default "Save as PDF" filename a browser derives from it.
 *  e.g. docTitle("Invoice INV-00018", "Tao Zhu") → "Invoice INV-00018 - Tao Zhu". */
export function docTitle(...parts: (string | null | undefined)[]): string {
  const joined = parts
    .map((p) => (p ?? "").toString().trim())
    .filter(Boolean)
    .join(" - ");
  return joined || "Contractor North";
}
