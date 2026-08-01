/**
 * A form field's stable KEY, derived from its label.
 *
 * Lives in its own module because BOTH sides need the identical rule and they can't share it any
 * other way: the save path is a "use server" file (which may only export async functions), and the
 * editor is a client component that has to offer the same key when you point one field's
 * visibility at another. Two slightly different slug rules would produce a showIf that silently
 * never matches — a question that can never appear, with nothing to indicate why.
 */
export function slugifyFieldKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
