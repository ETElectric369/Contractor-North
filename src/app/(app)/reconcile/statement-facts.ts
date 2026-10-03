/**
 * ── WHAT THE READ ACTUALLY DOES, ONE FACT EACH (Erik, 2026-10-03) ─────────────────────────────
 *
 * This was one paragraph of eleven facts on the Bring In A Statement card, and he could not read it:
 * "this huge box of text in front of me is hard for me to read and takes up a lot of space on the
 * screen, valuable space for reconciling". It is the same eleven facts, as bullets, behind an info
 * icon. NOTHING IS CUT, and every clause still names something the code does — the walk
 * (statement-verify.ts balanceChain), the refusal on a scan (statement-scan-actions.ts), the warning
 * on a file (open-list-add-core.ts has no pass gate, on purpose) and the silence when a paper prints
 * neither (verifySaid). A claim here that the code does not do is the onboarding-truth law broken.
 *
 * IT LIVES AS DATA, NOT AS JSX, for one reason: a list of facts is the thing a test can count, and
 * reconcile-page-doors.test.ts counts them so an explanation cannot be quietly dropped on its way
 * into the box.
 */
export const STATEMENT_FACTS = [
  "Whatever your bank or supplier gave you: a download off their website, or the PDF a supplier emails. North works out what it is.",
  "Every line has to add up against the running balance printed beside it, so each line proves the one before it to the cent.",
  "The line underneath says how many lines it held, and where it stopped if it stopped.",
  "A statement that also prints a beginning balance, an ending balance or totals is held against those as well.",
  "If two columns could both be the amount, it asks you which is which, and adds them up once you have said.",
  "A statement whose lines are PICTURES is read as well — scanned, photographed, or a PDF whose columns don't come off as text.",
  "On a picture, its pages are looked at, and then its own printed figures are held against what came off them, to the cent.",
  "A card statement is read the way a card works, where what you owe goes up with a purchase.",
  "On a picture, a read its own paper disagrees with is refused and nothing is added.",
  "On a file off your bank those rows are the bank's own, so the line says what doesn't add up and names the line to go and look at.",
  "If the paper prints no totals and no running balance, it says that out loud, so you know nothing but your own eyes has checked it.",
  "Looking at the pages takes a minute, and a long statement takes a few.",
] as const;
