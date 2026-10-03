/**
 * THE DATABASE'S NO, IN THE WORD EVERY OTHER SCREEN USES.
 *
 * A crew lead's save goes through save_walkthrough_capture (0356), and that function is the
 * boundary: its own RAISE EXCEPTION sentences are what he reads when it says no. They reach him
 * verbatim — appointments/actions.ts `inspectionRefusal` hands a 42501 message straight back,
 * `dbError` hands an unrecognised one back raw on purpose (see its header: Erik files bug reports by
 * copying that text), and appointments/[id]/inspector.tsx puts it on screen under his Save.
 *
 * THOSE SENTENCES STILL SAY "walk-through", AND THEY CANNOT BE EDITED WHERE THEY LIVE. They are
 * literals inside migration 0356, which is already applied: the test database is rebuilt from the
 * migration files and scripts/test-db/check-test-db.cjs fails CI when an applied one changes. Saying
 * the new word in the database would mean a fresh migration that recreates the function — a
 * migration for a word, with a function body to copy correctly, on the one door a crew lead saves
 * through. Not worth it. So the database keeps its sentence and it is re-said HERE, once, on the way
 * to the screen.
 *
 * THE WORD ONLY. Nothing else about the sentence moves. The sentence is the database's answer about
 * what it refused, and a reworded one is a guess — db-error.ts's rule, for the same reason.
 *
 * WHAT GIVES THIS TEETH: inspection-word.test.ts reads supabase/migrations itself and asserts that
 * every user-facing sentence any migration can raise comes out of this function in the new word. The
 * TypeScript sweep in that file cannot see SQL, which is exactly how the old word survived here —
 * the DB suite's expectations were rewritten to the new word while the function kept raising the old
 * one, and the unit project could not see it because the suite needs the test database.
 *
 * The matcher is a MATCHER, not a word anybody reads, which is why the literal sweep (string
 * literals, template chunks and JSX text) does not see it and this file needs no allowlist entry.
 */
const DB_OLD_WORD = /\bwalk\s*-?\s*through(s)?\b/gi;

/** A sentence the database raised, said in the site visit's one word. Anything with no trace of the
 *  old word comes back byte for byte. */
export function inspectionDbWords(message: string | null | undefined): string {
  return String(message ?? "").replace(DB_OLD_WORD, (hit: string, plural: string | undefined) => {
    const word = plural ? "inspections" : "inspection";
    // "The walk-through's notes…" starts a sentence; "…off the walk-through." does not.
    return /^[A-Z]/.test(hit) ? word[0].toUpperCase() + word.slice(1) : word;
  });
}
