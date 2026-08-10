/**
 * A ROW THE CSV IMPORT SHIFTED — one predicate, so the count and the list can't disagree.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────────────────────
 *
 * Until cn-v696, lib/csv.ts opened quote mode on ANY `"`, not just one at the start of a field.
 * An inch mark — `4" RND LS`, `1/2" EMT` — is the most common character in a trade parts list, and
 * hitting one swallowed the next comma and every newline after it. Usually that means the rest of
 * the file lands in a single cell and the import is visibly a disaster. Sometimes a later stray
 * quote closes the region again, parsing resumes, and the columns are simply shifted one to the
 * left from there on. That second case is the dangerous one, because it looks like data.
 *
 * ET Electric's live book has three of them, all from the CED import of 2026-07-12:
 *
 *     code               description                    unit        buy_price
 *     SMX4RLSFSD2W       "4'' RND LS(650/800/1000)      36.730      5.00
 *     RL56LS9FSD2W1EWH   "5/6'' RL                      25.690      900.00
 *     SMX6RLSFSD2W       "6'' RND LS(750/900/1200)      44.910      5.00
 *
 * The undamaged sibling of the middle one is `RL4LS9FSD2W1EWH  4'' RL 600/900LM 5CCT D2W  ea  23.85`,
 * which is what makes the shape unmistakable: the price is sitting in `unit`, the description was
 * cut at the character that broke the parser, and `buy_price` is holding whatever fell in after.
 *
 * ── WHY THIS FLAGS RATHER THAN REPAIRS ──────────────────────────────────────────────────────
 *
 * It would take one UPDATE to move 25.690 into buy_price and set unit back to 'ea'. It would also
 * be a GUESS, written into the book every quote prices from. This project already killed an address
 * parser for the same reason — a splitter that is usually right fabricates the rest of the time,
 * and here the fabrication is a dollar amount on a customer's estimate.
 *
 * So the app says exactly what it can prove: these three rows are shaped like a shifted import, and
 * here are the numbers currently in them. Erik knows what a 5/6" retrofit costs; he fixes it in
 * thirty seconds. That is a visible gap instead of a silent partial, and it is also live wrong
 * money right now — two of these quote at $5.00 and one at $900.00 today.
 *
 * ── THE PREDICATE ───────────────────────────────────────────────────────────────────────────
 *
 * `unit` does not begin with a letter. Every real unit in all three tenants' books does: ea, EA,
 * ft, LF, lot, pk, SQ FT. A unit that starts with a digit is a price that landed in the wrong
 * column, and there is nothing else it could be.
 */

/** The PostgREST form. Verified live: `.not("unit", "imatch", UNIT_STARTS_WITH_LETTER)` → 3 rows. */
export const UNIT_STARTS_WITH_LETTER = "^[a-z]";

/** The client-side twin. Same rule, so a highlighted row and a count can never disagree. */
export const unitLooksShifted = (unit: string | null | undefined): boolean =>
  !/^[a-z]/i.test(String(unit ?? "").trim());
