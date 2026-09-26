/**
 * WHAT /api/pdf SAYS WHEN THE PRINT PAGE DID NOT ANSWER WITH THE DOCUMENT (audit v1018 links-docs-3).
 *
 * Two different things used to read the same: "That document isn't available." (404).
 *   - Not there for this reader: a deleted or other-org id renders the app's 404, and an expired
 *     session lands on /login (a 200 on the wrong path). That one IS "isn't available".
 *   - There, but a read behind it failed just now: the print page refuses to draw a bill with a
 *     piece missing (it throws, so it answers 500) rather than have it stored as the customer's
 *     copy. Calling that "isn't available" told the office the invoice was gone. It is a 503 that
 *     says so and says to try again.
 * Pure, so the rule is a unit test. Returns null when the page answered with the document.
 */
export type PrintRefusal = { status: 404 | 503; error: string };

export function printRefusal(
  doc: string,
  res: { status: number; path: string } | null,
  expectedPath: string,
): PrintRefusal | null {
  if (!res || res.path !== expectedPath) return { status: 404, error: "That document isn't available." };
  if (res.status >= 500) {
    return {
      status: 503,
      error:
        doc === "invoice"
          ? "This invoice couldn't be read in full just now. Try again in a moment."
          : "This document couldn't be read just now. Try again in a moment.",
    };
  }
  if (res.status < 200 || res.status >= 300) return { status: 404, error: "That document isn't available." };
  return null;
}
