/**
 * WHEN DID THE PUNCH ACTUALLY HAPPEN?
 *
 * A tech taps "clock in" at 7:02 in a dead zone; the phone reconnects at 11:00. Recording 11:00
 * costs him four hours. Recording 7:02 requires trusting a timestamp the device asserted — and
 * NOTHING can distinguish "made live, delivered late" from "backdated afterwards", because the
 * device is the only witness to both.
 *
 * So this doesn't pretend to verify. It bounds and it discloses:
 *
 *   - BOUNDED. A punch older than one long working day is refused rather than guessed at. The
 *     office already has a tool for genuinely old corrections (time.fixEntry, staff-only, audited),
 *     and a wrong number in payroll is worse than a refusal that names the fix.
 *   - DISCLOSED. What survives is stamped source='offline' (0168), so the timecard shows where the
 *     start time came from. A time record whose provenance is visible can be questioned; one that
 *     silently claims to be a live punch cannot.
 *
 * This is the same bargain the existing half-hour round-back already makes for a tech who missed
 * the moment — just widened to the length of a shift, and labelled.
 */

/** A long day plus slack. Beyond this, the office enters it. */
export const MAX_OFFLINE_PUNCH_AGE_MS = 14 * 60 * 60 * 1000;

/** Small allowance for a device clock running slightly fast. */
const FUTURE_SKEW_MS = 2 * 60 * 1000;

export type PunchTimeVerdict =
  | { ok: true; iso: string; offline: boolean }
  | { ok: false; reason: string };

/**
 * Resolve the instant to record for an offline-queued punch.
 *
 * `claimedIso` is when the user says they pressed the button; `now` is delivery time.
 */
export function resolveOfflinePunchTime(claimedIso: string | null | undefined, now: number = Date.now()): PunchTimeVerdict {
  if (!claimedIso) return { ok: true, iso: new Date(now).toISOString(), offline: false };
  const ms = new Date(claimedIso).getTime();
  if (!Number.isFinite(ms)) return { ok: false, reason: "That punch has no usable time on it." };

  if (ms > now + FUTURE_SKEW_MS) {
    // A future punch is always wrong — a bad device clock, or a tampered payload. Neither should
    // reach payroll.
    return { ok: false, reason: "That punch is timestamped in the future — check the phone's clock." };
  }

  const age = now - ms;
  if (age > MAX_OFFLINE_PUNCH_AGE_MS) {
    const hours = Math.round(age / 3_600_000);
    return {
      ok: false,
      reason: `That punch has been waiting ${hours} hours — too long to file automatically. Ask the office to enter it so the time is right.`,
    };
  }

  // Under a minute apart means it went through essentially live; don't label it offline just
  // because it happened to travel through the queue.
  const offline = age > 60_000;
  return { ok: true, iso: new Date(ms).toISOString(), offline };
}
