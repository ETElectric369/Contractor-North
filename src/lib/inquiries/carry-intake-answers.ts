import { coerceByPlaybook } from "@/lib/playbook/answers";
import type { Answers, Playbook } from "@/lib/playbook/types";

/**
 * WHAT THE CUSTOMER ALREADY TOLD YOU, CARRIED ONTO THE WALK-THROUGH.
 *
 * The public intake door writes a customer's answers to `inquiries.intake.intake_answers`. Until
 * now that column was read in exactly two places: to draw the lead card, and to sign the URLs of
 * any files they uploaded. Booking the inspection copied `inq.message` — the flattened
 * "Label: answer" SUMMARY — into `appointments.notes` and nothing else. So the structured answers
 * stopped at the Leads board: the inspector asked every question again on site, and the estimator
 * was handed the customer's words back as a paragraph to re-read.
 *
 * The Tahoe Deck starter's own blurb already promises the opposite — "so a customer's answers
 * carry in and he confirms rather than re-asks". This is that carry.
 *
 * ── THE RULE: A CUSTOMER MAY ANSWER A QUESTION, NEVER TAKE A MEASUREMENT ────────────────────
 *
 * `measured: true` already means "this is a number somebody takes with a tape on site", and the
 * playbook editor exposes it as a tick-box reading "This is measured on site". So it is the
 * boundary, and it is one the contractor can move himself without touching code.
 *
 * It matters because of where a measured answer GOES. quotes/new hands the estimator a block
 * headed "FROM THE WALK-THROUGH (his words — take them as given)", and lib/playbook/answers'
 * comments record what happened the last time a stale number reached it: a 25-ft feeder from an
 * abandoned branch was priced as fact. A homeowner's guess at a deck's depth is exactly that kind
 * of number — plausible, unverified, and multiplied by a rate. Chris pulls the tape; the customer
 * tells him whether it wraps the house, whether it is composite, and whether it is in the basin.
 *
 * Three more kinds are dropped, each for its own reason:
 *   · `scopes` — its options ARE price-list codes. publicIntakeNeeds already refuses to render one
 *     to a stranger, so a value under that key could only have been forged.
 *   · `file`   — the paths live in the intake bucket under `<org>/intake/`. The inspector's
 *     uploader writes somewhere else, so carrying a path across would produce an attachment that
 *     renders as a broken name. The files stay reachable from the lead, which is where they are.
 *   · anything the walk-through does not declare — coerceByPlaybook drops unknown keys outright,
 *     which is what keeps a crafted intake payload from stuffing jsonb onto an appointment.
 *
 * `carried` is returned separately so the caller can say out loud, in the appointment's own notes,
 * which questions were pre-filled and by whom. A pre-filled answer that looks like the
 * contractor's own is worse than no pre-fill at all.
 */
export function answersFromIntake(
  pb: Playbook,
  intakeAnswers: unknown,
): { answers: Answers; carried: string[] } {
  if (!pb.needs.length || !intakeAnswers || typeof intakeAnswers !== "object")
    return { answers: {}, carried: [] };

  // Coerce against the WALK-THROUGH, not the intake form: same key, and it is the walk-through's
  // declaration of that key that governs from here on. A question the customer answered as free
  // text that the contractor has since made a select coerces to null and is simply not carried,
  // which is the honest outcome — nobody has to guess which of his options they meant.
  const coerced = coerceByPlaybook(pb, intakeAnswers);

  const kept: Answers = {};
  for (const n of pb.needs) {
    if (n.measured) continue;
    if (n.slot?.type === "scopes" || n.slot?.type === "file") continue;
    const v = coerced[n.key];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    kept[n.key] = v;
  }

  // ── AND DELIBERATELY NOT clearInapplicable ────────────────────────────────────────────────
  //
  // Every other boundary in this codebase clears to a fixed point before it hands answers on, and
  // this one must not. Chris's walk-through gates `shape` and `wrap_around` behind
  // `{ key: "length_ft", known: true }` — reasonable, because on site he has a tape in his hand
  // before he thinks about the outline. But `length_ft` is MEASURED, so it is exactly the answer a
  // customer is never allowed to give. Clear here and the resolver throws away "irregular, and it
  // wraps the corner" — two answers that between them set the DS6C cutting rate and the DS6D
  // corner rate — on the grounds that nobody has measured the deck yet. Which is true, and is not
  // a reason to forget what the customer told us.
  //
  // Nothing is lost by waiting: the walk-through clears on its own save (appointments/actions),
  // and factsForEstimator clears again before a single fact reaches the estimator. Both of those
  // run at a moment when the measurements exist, which is the moment the question can actually be
  // answered. So a carried answer under a question that never becomes applicable is inert — it is
  // never rendered, never priced, and gone at the first autosave.
  //
  // SPARSE, though: only what somebody actually answered goes on the row. Writing a declared null
  // for every other need would be a pre-fill made of blanks.
  const carried = pb.needs.filter((n) => kept[n.key] != null).map((n) => n.label);
  return { answers: kept, carried };
}
