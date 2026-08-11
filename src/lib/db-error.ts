/**
 * A DATABASE ERROR, SAID IN ENGLISH.
 *
 * Erik, blocked mid-estimate, reading the red text under his own Save button:
 * `duplicate key value violates unique constraint "quotes_org_number_key"`. He could not act on
 * that, and he should not have had to — it names a Postgres index, not a thing he did.
 *
 * There were 259 places returning `error.message` straight through to a person. Rewriting 259 call
 * sites would be 259 chances to get one wrong; this is one function they all call instead.
 *
 * ── THE RULE: TRANSLATE WHAT WE RECOGNISE, NEVER SWALLOW WHAT WE DON'T ──────────────────────
 *
 * An unknown error keeps its exact original text. That is deliberate and it is not laziness:
 * Erik files bug reports by copying this text out of the app, and a blanket "Something went wrong"
 * would destroy the only diagnostic he has while looking tidier. Every sentence below was added
 * because somebody hit that specific shape; the rest stay raw until they are.
 *
 * Constraint names are matched exactly rather than guessed at, because a name is the only part of
 * a Postgres error that reliably says WHICH rule was broken — and a wrong guess here is a
 * confidently wrong sentence, which is worse than the raw string it replaced.
 */

/** Postgres messages we have a better sentence for, matched on the constraint name. */
const BY_CONSTRAINT: Record<string, string> = {
  quotes_org_number_key: "That estimate number is already in use. Try saving again — it'll take the next one.",
  jobs_org_number_key: "That job number is already in use. Try saving again — it'll take the next one.",
  invoices_org_number_key: "That invoice number is already in use. Try saving again — it'll take the next one.",
  purchase_orders_org_number_key: "That PO number is already in use. Try saving again — it'll take the next one.",
  work_orders_org_number_key: "That work-order number is already in use. Try saving again — it'll take the next one.",
  change_orders_org_number_key: "That change-order number is already in use. Try saving again — it'll take the next one.",
  profiles_email_key: "Someone with that email address is already on the team.",
  organizations_public_handle_key: "That web address is already taken — pick another.",
};

/** Column names that read badly in a sentence. Anything else is title-cased as-is. */
const FIELD_LABEL: Record<string, string> = {
  org_id: "organization",
  customer_id: "customer",
  job_id: "job",
  quote_number: "estimate number",
  invoice_number: "invoice number",
  full_name: "name",
};

const label = (col: string) => FIELD_LABEL[col] ?? col.replace(/_id$/, "").replace(/_/g, " ");

export function dbError(err: unknown): string {
  // The fallback has to cover BOTH shapes. It originally only guarded the object branch, so a
  // literal empty string came straight back out and rendered as a red box with nothing in it —
  // which reads as the app breaking silently, the exact failure this file exists to end.
  const raw =
    (typeof err === "string" ? err : String((err as { message?: unknown } | null)?.message ?? "")).trim() ||
    "Something went wrong.";

  // UNIQUE — the shape that blocked every estimate. Named constraints get a real sentence.
  const dup = raw.match(/duplicate key value violates unique constraint "([^"]+)"/);
  if (dup) {
    return BY_CONSTRAINT[dup[1]] ?? "Something with that value already exists — change it and try again.";
  }

  // NOT NULL — the app forgot a required field, or the person left one blank.
  const nn = raw.match(/null value in column "([^"]+)"[^]*violates not-null constraint/);
  if (nn) return `${label(nn[1])} is required.`;

  // RLS. This is an ACCESS answer, never a "try again" — see the silent-write law: the row simply
  // is not yours to write, and saying so is the whole point.
  if (/violates row-level security policy|permission denied/i.test(raw))
    return "You don't have access to change that. If you think you should, ask an owner or admin.";

  // FOREIGN KEY — pointing at something that is gone, usually because it was deleted in another tab.
  if (/violates foreign key constraint/.test(raw))
    return "Something this is attached to no longer exists. Reload the page and try again.";

  // CHECK — a value outside what the column allows (a status, a type, a range).
  const chk = raw.match(/violates check constraint "([^"]+)"/);
  if (chk) return "That value isn't one this field accepts.";

  // LENGTH.
  if (/value too long for type/.test(raw)) return "That's longer than this field can hold — shorten it.";

  // A column or table the deploy expects and the database hasn't got yet.
  if (/column .* does not exist|relation .* does not exist/i.test(raw))
    return "This part of the app is mid-update. Give it a minute and try again.";

  // NOT RECOGNISED — hand back exactly what the database said. See the header for why.
  return raw;
}
