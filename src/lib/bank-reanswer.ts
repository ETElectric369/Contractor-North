/**
 * ONE BANK LINE ANSWERED AGAIN (correction door B, 2026-10-07): the pure half of Change Answer.
 *
 * A download's lines were answered once, at Apply, and until now the only way to change ONE of them
 * was Undo, which takes the whole download back: every bill it wrote, every payment, every mark and
 * every rule it taught. A check answered as crew pay that was really the truck's repair, or a
 * transfer answered Not Income that was the owner's own money going in, needed one line changed and
 * nothing else.
 *
 * THIS FILE HOLDS THE PARTS THAT ARE ONLY ARITHMETIC AND WORDS, so they are tested without a
 * database and the card can ask the same question the server asks (which answers a line may be
 * changed TO) without pulling the whole bank module into the browser. No runtime import: the server
 * hands in the labels (choiceLabel) and the band words (sayBand) it already makes.
 *
 * THE DOOR ITSELF is reanswerBankLineCore (bills/bank-core.ts): it unwinds the old answer's money row
 * by Undo's own per-line rules, writes the new one by Apply's own row shape, changes the line, and
 * settles the rules the old answer taught, using what is here.
 */

/**
 * THE ANSWERS A LINE MAY BE CHANGED TO, in the app's words (Cash Taken Out is stored as 'petty_cash').
 * Each one writes either nothing (the bank line IS the record) or one paid bill — never a payment to
 * a person, which is why the four below are not here.
 */
export const REANSWER_TO = ["cost", "job", "draw", "cash_out", "not_cost", "not_income", "owner_in", "other_income"] as const;
export type ReanswerTo = (typeof REANSWER_TO)[number];

/** The payment answers: each ties the line to a row somebody else's money is in (a payment on an
 *  invoice, a supplier's, a crew member's) or to a row already there (matched). */
export const REANSWER_PAYMENT_ANSWERS = ["matched", "supplier", "crew", "invoice"] as const;

/** Why a payment answer is not offered, and the one road that does it today. */
export const REANSWER_TO_PAYMENT = "Changing a line to a payment answer isn't a one-line change yet: Undo the download and apply it again.";

/** A word no line can hold at all (a hand-made request). */
export const REANSWER_UNKNOWN = "That isn't an answer a bank line can take. Pick one from the list.";

/** The answer's word as the app spells it: the stored word for Cash Taken Out, and the retired word
 *  for Owner's Draw (0380), come back as the words the app uses. */
const wordOf = (name: string) => (name === "petty_cash" ? "cash_out" : name === "personal" ? "draw" : name);

/** Null when a line may be changed to this answer (its word, or a whole choice id), else the sentence. */
export function reanswerRefusal(answer: string | null | undefined): string | null {
  const w = wordOf(String(answer ?? "").split(":")[0]);
  if ((REANSWER_TO as readonly string[]).includes(w)) return null;
  if ((REANSWER_PAYMENT_ANSWERS as readonly string[]).includes(w)) return REANSWER_TO_PAYMENT;
  return REANSWER_UNKNOWN;
}

/** May the card offer this button (a choice id, "cost:Auto", "job:…", "crew:…") under Change Answer? */
export function reanswerOffers(id: string): boolean {
  return reanswerRefusal(id) === null;
}

// ── THE RULE THE OLD ANSWER TAUGHT ────────────────────────────────────────────────────────────────

/** A rule's band, cents and positive; null both = every amount (a rule from before 0365). */
export type Band = { minCents: number | null; maxCents: number | null };

/** Does the band hold this amount (cents, either sign), exactly — no stretch? */
export function bandHolds(band: Band, cents: number): boolean {
  if (band.minCents == null || band.maxCents == null) return true;
  const a = Math.abs(cents);
  return a >= band.minCents && a <= band.maxCents;
}

export type BandAfter = { kind: "same" } | { kind: "gone" } | { kind: "band"; minCents: number; maxCents: number };

/**
 * THE BAND A RULE KEEPS ONCE ONE OF ITS LINES SAYS SOMETHING ELSE: the smallest and largest of the
 * SURVIVING answers it holds — the other lines a person answered the same way, for the same merchant,
 * the same way round. None left: the rule goes, because nothing a person said is behind it any more.
 *
 * ONLY EVER NARROWER. A surviving line outside the rule's band is not one it was taught by (a rule
 * forgotten and learned again later holds only the later amounts), so it is never counted: re-deriving
 * a rule can never widen what it reaches. A band of "every amount" takes the survivors' band, as Apply
 * would have given it.
 */
export function bandWithout(rule: Band, survivorsCents: readonly number[]): BandAfter {
  const held = survivorsCents.map((c) => Math.abs(c)).filter((c) => c > 0 && bandHolds(rule, c));
  if (!held.length) return { kind: "gone" };
  const minCents = Math.min(...held);
  const maxCents = Math.max(...held);
  if (minCents === rule.minCents && maxCents === rule.maxCents) return { kind: "same" };
  return { kind: "band", minCents, maxCents };
}

/** THE NEW ANSWER'S RULE, IF THERE IS ONE, grows to hold this line's amount — exactly as Apply widens a
 *  rule a person answers again. Null: it already holds it (or holds every amount). A re-answer never
 *  MAKES a rule: one line changed by hand is not a pattern. */
export function bandHolding(rule: Band, cents: number): { minCents: number; maxCents: number } | null {
  if (rule.minCents == null || rule.maxCents == null || bandHolds(rule, cents)) return null;
  const a = Math.abs(cents);
  return { minCents: Math.min(rule.minCents, a), maxCents: Math.max(rule.maxCents, a) };
}

// ── WHAT IT SAYS ─────────────────────────────────────────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "June 3" (", 2025" when it is not this year). */
export function sayLineDay(ymd: string, today?: string | null): string {
  const [y, m, d] = String(ymd ?? "").split("-").map(Number);
  if (!y || !m || !d || m > 12) return String(ymd ?? "");
  const year = today && String(today).slice(0, 4) !== String(ymd).slice(0, 4) ? `, ${y}` : "";
  return `${MONTHS[m - 1]} ${d}${year}`;
}

/** "June 8 Check 1003", "June 3 TRANSFER FROM 9876": the line the way the card names it. */
export function sayBankLine(l: { postedOn: string; description: string; check: string | null; cents: number }, today?: string | null): string {
  const title = l.check && l.cents < 0 ? `Check ${l.check}` : String(l.description ?? "").trim() || (l.cents > 0 ? "Deposit" : "Withdrawal");
  return `${sayLineDay(l.postedOn, today)} ${title}`;
}

/** What happened to a rule, with the answer it holds said in the card's own words. */
export type RuleChange =
  | { kind: "narrowed"; said: string; band: string }
  | { kind: "gone"; said: string }
  | { kind: "widened"; said: string; band: string }
  | { kind: "failed"; said: string; why: string }
  | { kind: "unread"; why: string };

export function sayRuleChange(r: RuleChange): string {
  switch (r.kind) {
    case "narrowed":
      return `The rule that said ${r.said} now covers ${r.band}.`;
    case "gone":
      return `The rule that said ${r.said} is gone: no other line was answered that way.`;
    case "widened":
      return `The rule for ${r.said} now covers ${r.band}.`;
    // SAID, never dropped: the line is changed, and the rule is the one thing left as it was.
    case "failed":
      return `The rule that said ${r.said} wasn't changed (${r.why}); forget it under See How It Sorted if it is wrong now.`;
    case "unread":
      return `This merchant's remembered answers couldn't be read (${r.why}), so none was changed; see them under See How It Sorted.`;
  }
}

/**
 * THE ONE SENTENCE (and the clauses that ride after it): what the line is now, what happened to its
 * money, and what happened to the rules. "June 3 TRANSFER FROM 9876 is now Owner's Money In. The rule
 * that said Already Counted Or Not Income now covers $550.00 to $2,000.00."
 *
 * ALREADY: the line said this answer before the tap (changed some other way). Nothing about the line
 * moves; a rule this download taught that still says the old answer for its amount is settled all the
 * same, and if there is none the sentence says nothing was changed.
 */
export function sayReanswer(o: { line: string; answer: string; already?: boolean; money?: readonly string[]; rules?: readonly RuleChange[] }): string {
  const head = o.already ? `${o.line} already says ${o.answer}.` : `${o.line} is now ${o.answer}.`;
  const rest = [...(o.money ?? []), ...(o.rules ?? []).map(sayRuleChange)].filter((s) => !!s && s.trim());
  if (o.already && !rest.length) return `${head} Nothing was changed.`;
  return rest.length ? `${head} ${rest.join(" ")}` : head;
}
