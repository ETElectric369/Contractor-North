import type { SupabaseClient } from "@supabase/supabase-js";
import { answerText, coerceByPlaybook, retiredAnswers, retiredLabel } from "@/lib/playbook/answers";
import { playbookForForm } from "@/lib/playbook/parse";
import { answersFromBrief, layerBriefAnswers, parsePlanBrief } from "@/lib/plan-brief";
import type { AnswerValue, Answers, Playbook } from "@/lib/playbook/types";

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

/**
 * THE OTHER HALF OF THE CARRY: WHAT THE WALK-THROUGH CANNOT ASK, SHOWN INSTEAD OF DROPPED.
 *
 * answersFromIntake pre-fills by KEY, and a key only matches when the same question exists on both
 * playbooks. That is the right rule and it is deliberately strict — but it is also, for most orgs,
 * every answer. Vivian Builders' intake declares 26 questions; their walk-through declares one, and
 * the two share nothing. So Andy Colar's lead arrived with the project, the room, the timeline, the
 * designer and the plans all answered, `carried` came back empty, and both of his walk-throughs
 * were written with `inspection_answers: {}` — Erik's three reports ("the walk-through starts
 * blank", "the intake answers don't carry over", "they aren't on the lead at all").
 *
 * Nothing here writes an answer. A question the contractor never put on his sheet has nowhere to be
 * pre-filled TO, and guessing a mapping — by label, by resemblance — is exactly the drift the
 * module header warns about (ET's `gotcha` means two different things on the two forms). What was
 * missing is smaller and honest: the customer's answers, in the words they were ASKED in, on the
 * walk-through, marked as theirs. He confirms rather than re-asks, which was the promise.
 *
 * LABELS COME FROM THE INTAKE PLAYBOOK because that is the only place they exist — `intake_answers`
 * is a bag of keys, and `q_mst1drw8` on its own is not a question. Retired keys are rescued the way
 * the inspector rescues its own (retiredAnswers): a question deleted from the form since submission
 * must not take the customer's answer off the screen with it.
 *
 * FILE ANSWERS ARE SKIPPED — IntakeFiles renders those as openable names wherever this card goes,
 * and a storage path is not something to read out.
 *
 * `skipKeys` is what the walk-through DID pre-fill: those are already on the sheet as editable
 * answers, and repeating them here would invite him to confirm the same thing twice.
 */
export function intakeAnswerLines(
  intakePb: Playbook,
  intakeAnswers: unknown,
  skipKeys: ReadonlySet<string> = new Set<string>(),
): { key: string; label: string; value: string }[] {
  if (!intakeAnswers || typeof intakeAnswers !== "object") return [];
  const stored = intakeAnswers as Record<string, unknown>;
  const out: { key: string; label: string; value: string }[] = [];
  // Playbook order, not object order: the customer answered them in this order and the office
  // reads them back in it.
  for (const n of intakePb.needs) {
    if (skipKeys.has(n.key)) continue;
    if (n.slot?.type === "file") continue;
    const value = answerText((stored[n.key] ?? null) as AnswerValue).trim();
    if (!value) continue;
    out.push({ key: n.key, label: n.label, value });
  }
  for (const [key, value] of Object.entries(retiredAnswers(intakePb, stored))) {
    if (skipKeys.has(key)) continue;
    out.push({ key, label: retiredLabel(key), value });
  }
  return out;
}

/**
 * EVERYTHING A NEW WALK-THROUGH INHERITS FROM ITS LEAD, in one place — the customer's own intake
 * answers plus the plan brief's, layered so the person always outranks the machine. Shared by
 * every door that mints an inspection from a lead (the booked paths on the Leads board AND the
 * one-tap Inspect-now), because two doors carrying different halves is how Andrew's plans got
 * read into a report the inspector then opened blank.
 *
 * Reads THE org walk-through (is_inspection, singular) on the CALLER's client — RLS-scoped
 * callers can only ever find their own org's.
 */
export async function carryForInquiry(
  supabase: SupabaseClient,
  inq: { intake?: { intake_answers?: unknown } | null },
): Promise<{
  inspectionTemplateId: string | null;
  inspectionAnswers: Answers;
  carried: string[];
  briefCarried: string[];
}> {
  const none = { inspectionTemplateId: null, inspectionAnswers: {}, carried: [], briefCarried: [] };
  const stored = inq.intake?.intake_answers;
  const brief = parsePlanBrief(inq.intake);
  const hasIntake = !!stored && typeof stored === "object";
  const hasBrief = brief?.status === "ready" && !!brief.answers && Object.keys(brief.answers).length > 0;
  if (!hasIntake && !hasBrief) return none;
  const { data: form } = await supabase
    .from("forms")
    .select("id, schema, playbook")
    .eq("is_inspection", true)
    .limit(1)
    .maybeSingle();
  if (!form) return none;
  const pb = playbookForForm(form as { schema?: unknown; playbook?: unknown });
  const { answers: fromCustomer, carried } = hasIntake
    ? answersFromIntake(pb, stored)
    : { answers: {}, carried: [] as string[] };
  const fromBrief = hasBrief ? answersFromBrief(pb, brief!.answers) : {};
  const { answers, briefCarried } = layerBriefAnswers(pb, fromCustomer, fromBrief);
  if (!carried.length && !briefCarried.length) return none;
  return { inspectionTemplateId: (form as { id: string }).id, inspectionAnswers: answers, carried, briefCarried };
}

/** WHICH ANSWERS ON A WALK-THROUGH CAME FROM THE CUSTOMER'S OWN FORM (v800 audit).
 *
 *  The estimator splits facts into "his words — take them as given" and "read by machine —
 *  verify". A carried intake answer is NEITHER: a stranger typed it into a web form, and the
 *  two playbooks can drift so far that the same key means different things on each side (ET
 *  Electric's `gotcha` is "Anything that'll bite us" on intake and "Man hours" on the
 *  walk-through). It reached the estimator wearing the contractor's own voice.
 *
 *  Provenance test mirrors briefProvenanceKeys: a key is still the CUSTOMER's only while the
 *  walk-through value is untouched — the moment the contractor edits it on site it becomes his.
 */
export function intakeProvenanceKeys(
  carried: string[],
  intakeAnswers: Record<string, unknown> | null | undefined,
  current: Answers,
): Set<string> {
  const keys = new Set<string>();
  for (const k of carried ?? []) {
    const was = intakeAnswers?.[k];
    const now = current?.[k];
    if (was === undefined || now === undefined) continue;
    if (JSON.stringify(was) === JSON.stringify(now)) keys.add(k);
  }
  return keys;
}

/** One line for the appointment's notes. A pre-filled answer that looks like the contractor's own
 *  is worse than no pre-fill: he has to know which of these came from a stranger. */
export const carriedNote = (carried: string[]): string | null =>
  carried.length ? `Already answered by the customer online (confirm on site): ${carried.join(", ")}.` : null;

/** Same law for the machine's answers — and these came from a document, so: verify on site. */
export const briefNote = (briefCarried: string[]): string | null =>
  briefCarried.length ? `Read from the customer's plans (verify on site): ${briefCarried.join(", ")}.` : null;
