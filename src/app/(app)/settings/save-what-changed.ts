/**
 * A SAVE SENDS WHAT THE PERSON CHANGED, AND NOTHING ELSE (2026-10-01).
 *
 * ── THE FAULT THIS EXISTS BECAUSE OF ──────────────────────────────────────────────────────────────
 *
 * Both of /team's editors sent every field they held on every save, whether or not it had been touched.
 * That is harmless only while the values on screen are the values in the database, and on /team they
 * stopped being: when the `profile_pay` read failed whole in a migration window, every box arrived null
 * and rendered 0, and the next save wrote those zeros back as nulls.
 *
 *   MemberRate sent `bill || null` on EVERY save. Typing a crew member's real $40 into a Pay box that
 *   read $0 for want of a read sent {hourly_rate: 40, bill_rate: null} and his stored $85 bill rate
 *   was gone - deleted by a save that never mentioned his bill rate.
 *
 *   EditMemberButton sent `home_address` and `commute_baseline_miles` unconditionally, so a Save about
 *   a phone number or a crew-lead checkbox cleared the home address and zeroed the baseline. That is
 *   the MILEAGE ORIGIN the Tax Report deducts the commute from, so the loss is a silently wrong
 *   deduction, with nothing on screen about either field.
 *
 * ── WHY IT IS A RULE AND NOT TWO PATCHES ──────────────────────────────────────────────────────────
 *
 * The read is fixed (profilePayRead carries the migration-window ladder) and /team now hides the boxes
 * and says so when it fails, so the specific trigger is closed twice over. This is the third tooth and
 * the general one: a box that was never typed in cannot destroy what it never managed to show. Any
 * future partial read, stale prop or half-rendered form is a no-op instead of a deletion.
 *
 * Both server actions already read `undefined` as "leave this column alone" (settings/actions.ts), so
 * leaving a field out is the exact, already-tested way to say nothing about it.
 *
 * Pure: no React, no I/O, so the rule is testable without rendering (save-what-changed.test.ts).
 */

/** What the page READ for one person's three rate boxes. Null means no figure stored. */
export type RateBoxesRead = {
  /** profiles.hourly_rate - what the business pays a crew member an hour. */
  rate: number | null;
  /** profiles.bill_rate - what the customer is charged for their hour. */
  billRate: number | null;
  /** profiles.cost_rate - what an hour of the OWNER'S own build time costs (0373). */
  costRate: number | null;
};

/** What is in the three boxes now. A NumberInput's empty box is 0, which is why a save has to compare
 *  against what was read rather than trust a figure to mean "the person typed this". */
export type RateBoxesTyped = { pay: number; bill: number; cost: number };

/** The arguments `updateMemberRate` is called with. A field left out is "leave that column alone". */
export type RateBoxesSave = {
  hourlyRate?: number | null;
  billRate?: number | null;
  costRate?: number | null;
};

const samePrice = (was: number | null | undefined, now: number): boolean =>
  (Number(was) || 0) === (Number(now) || 0);

/**
 * WHICH OF THE THREE RATE BOXES THIS SAVE ACTUALLY CHANGED — null when none of them did.
 *
 * An owner's save never carries a pay figure and a crew member's never carries a cost figure: two
 * different questions, never the same box, never defaulted into each other (0286 for the first, 0373
 * for the second). Beyond that the only rule is the one in the header: a box the person did not change
 * is not in the patch, so it cannot overwrite anything.
 */
export function rateBoxesToSave(
  read: RateBoxesRead,
  typed: RateBoxesTyped,
  paidByDraw: boolean,
): RateBoxesSave | null {
  const save: RateBoxesSave = {};
  if (!samePrice(read.billRate, typed.bill)) save.billRate = typed.bill || null;
  if (paidByDraw) {
    // His Cost box. Never a pay figure: he is paid by owner's draw and payroll refuses him (0286).
    if (!samePrice(read.costRate, typed.cost)) save.costRate = typed.cost || null;
  } else if (!samePrice(read.rate, typed.pay)) {
    // A crew member's Pay box. Never a cost figure: cost_rate is the owner's column alone.
    save.hourlyRate = typed.pay || null;
  }
  return Object.keys(save).length ? save : null;
}

/** What the editor READ for one member. */
export type MemberEditRead = {
  full_name?: string | null;
  phone?: string | null;
  home_address?: string | null;
  commute_baseline_miles?: number | null;
  role?: string | null;
  crew_lead?: boolean | null;
};

/** What is in the editor's fields now. */
export type MemberEditTyped = {
  full_name: string;
  phone: string;
  home_address: string;
  commute_baseline_miles: number;
  role: string;
  crew_lead: boolean;
};

/** The patch `updateMember` is called with. A field left out is "leave that column alone". */
export type MemberEditSave = {
  full_name?: string;
  phone?: string;
  home_address?: string;
  commute_baseline_miles?: number;
  role?: string;
  crew_lead?: boolean;
};

const sameText = (was: string | null | undefined, now: string): boolean =>
  String(was ?? "").trim() === String(now ?? "").trim();

/**
 * WHICH OF THE MEMBER EDITOR'S FIELDS THIS SAVE ACTUALLY CHANGED — null when none of them did.
 *
 * `isSelf` keeps the existing rule that nobody sends their own role (the server refuses an owner
 * demoting himself, and the editor hides the control). Everything else is the header's rule: a Save
 * about a phone number says nothing about a home address.
 */
export function memberEditToSave(
  read: MemberEditRead,
  typed: MemberEditTyped,
  opts: { isSelf: boolean },
): MemberEditSave | null {
  const save: MemberEditSave = {};
  if (!sameText(read.full_name, typed.full_name)) save.full_name = typed.full_name;
  if (!sameText(read.phone, typed.phone)) save.phone = typed.phone;
  // THE MILEAGE ORIGIN (Tax Report). Sent only when it was edited - never carried along by a save
  // about something else, which is how it used to be cleared.
  if (!sameText(read.home_address, typed.home_address)) save.home_address = typed.home_address;
  if ((Number(read.commute_baseline_miles) || 0) !== (Number(typed.commute_baseline_miles) || 0)) {
    save.commute_baseline_miles = typed.commute_baseline_miles;
  }
  if (!opts.isSelf && !sameText(read.role, typed.role)) save.role = typed.role;
  if (!!read.crew_lead !== !!typed.crew_lead) save.crew_lead = typed.crew_lead;
  return Object.keys(save).length ? save : null;
}
