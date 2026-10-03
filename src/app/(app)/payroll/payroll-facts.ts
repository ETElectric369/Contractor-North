/**
 * ── THE LONG SENTENCES ON /payroll, ONE FACT EACH, BEHIND AN INFO ICON ────────────────────────
 *
 * Erik, 2026-10-03: "this huge box of text in front of me is hard for me to read and takes up a lot
 * of space on the screen" / "inside the info box that wall of text will be a lot easier to read if
 * its broken into bullet points". A card says ONE line; the rest goes behind the icon as bullets
 * (components/info-popup.tsx — the repo's one overlay for this, not a second one).
 *
 * NOTHING IS CUT. Every clause that was in a paragraph on this page is a bullet here.
 *
 * THEY LIVE AS DATA, NOT AS JSX, for the reason statement-facts.ts gives: a list of facts is the
 * thing a test can count, so an explanation cannot be quietly dropped on its way into the box.
 *
 * EVERY CLAIM TRACES TO CODE (the onboarding-truth law). The traces are named per bullet below.
 */

/** Beside "You Owe $X". Was the lead's own small print plus the page's closing paragraph. */
export const BASE_PAY_FACTS = [
  // payLineFromGross / payrollCsvRows: two buckets, deliberately no combined total anywhere.
  "This figure is base pay only. Mileage settles on its own, further down this page.",
  "Base pay is hours times pay rate.",
  "Mileage is never added into base pay, on this page or in the export.",
  // crewOwing / totalOwed in payroll-view: only the positive balances are summed.
  "It adds up only the people you still owe. Somebody you have paid ahead does not reduce it.",
  // page.tsx: drawIds come off the board (0286).
  "An owner is paid by owner's draw, not wages, so an owner is not in it.",
  "Your accountant handles withholding, from the pay period export at the bottom.",
] as const;

/**
 * Beside Earned / Paid / Owed in a person's statement. LABEL HONESTY: `earned` is the frozen gross
 * of every locked pay period (payroll_runs, not windowed) plus live unlocked hours from the last 18
 * months only (page.tsx BALANCE_MONTHS), and a running shift is in neither (balanceForPerson). The
 * word "Earned" must not claim more than that.
 */
export const THREE_FIGURES_FACTS = [
  "Owed is Earned less Paid. That is the whole of it.",
  "Earned is every pay period already locked, at the figure it locked at, so a later raise does not restate it.",
  "Plus hours since then that are not locked yet, priced at today's rate.",
  "Unlocked hours older than 18 months are not in Earned. Locked pay periods are, however old.",
  "A shift still running is in neither figure, because its hours are not known until it is closed.",
  "Paid is every payment you have recorded, all time, not counting any you have undone.",
  "A minus means you have paid ahead. It comes off the next hours rather than being owed back.",
  "Mileage is in none of the three. It is settled on its own.",
] as const;

/** Inside the pay form. Was the paragraph under the fields. */
export const PAYMENT_LANDS_FACTS = [
  "This records money you have already handed over. It does not send anything to anybody.",
  // actions.ts recordPayment: the lock rule spends a payment on whole periods, oldest first.
  "It pays off whole pay periods, oldest first.",
  "A half paid week stays open until the rest of it is paid.",
  // NumberInput starts empty on purpose; openPay never seeds it.
  "The amount is whatever you type. The app never fills it in or suggests one.",
  // voidPayment: a void never deletes, and it unwinds the locks the payment bought.
  "Recorded the wrong figure? Undo puts it back on the balance and unlocks what it locked.",
] as const;
