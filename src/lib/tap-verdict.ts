/**
 * TAP TO PAY TELLS THE TRUTH (0e2cb937, 2026-09-30).
 *
 * Rich Seiler, INV-083, $420: the Pay Now sheet said "Card approved — recording it on the
 * invoice… Stripe confirmed the charge" at 12:41, and Stripe had charged nothing. The bridge's
 * "ok" meant only that the plugin's confirm call resolved (the Swift side never read the
 * intent's status); the sheet turned that into "confirmed" and polled the invoice for a webhook
 * that could never come. Rich paid by the link an hour later.
 *
 * Now the phone's word is a CLAIM, checked against Stripe before the sheet says anything:
 * tapPaymentOutcome reads the PaymentIntent off the tenant's own account and, when Stripe says
 * succeeded and the webhook hasn't landed, books it through the one writer. This module is the
 * pure half — what the sheet shows for each answer, and the watch that never spins forever — so
 * both are testable in plain Node.
 */

/** What tapPaymentOutcome answers (billing/tap-actions.ts). */
export type TapOutcomeAnswer =
  | {
      ok: true;
      /** Stripe's own status word for the PaymentIntent. */
      status: string;
      /** Cents Stripe settled. */
      amountReceived: number;
      /** Stripe's last error in plain words (lib/stripe-decline-words), or null. */
      lastError: string | null;
      /** THIS call wrote the payment row. */
      booked: boolean;
      /** The row is at rest — written by this call or found already there. False only when Stripe
       *  says succeeded and the write itself failed (the webhook will book it). */
      recorded: boolean;
    }
  | { ok: false; error: string };

/** The one sentence the box leads with when the phone said yes and Stripe says no. */
export const NOT_CHARGED_LEAD = "Not charged — try again. The phone said approved, but Stripe shows no charge";

/** The sheet's line while the server read itself failed: the claim is shown as a claim. */
export const UNCHECKED_LINE = "Card approved — couldn't double-check with Stripe yet; watching for the payment…";
/** Stripe has the charge but is still finishing it (never seen with card_present + automatic capture, but a status, so a line). */
export const PROCESSING_LINE = "Card approved — Stripe is still finishing the charge; watching for the payment…";
/** Stripe said succeeded; the row is on its way (the webhook, a beat behind this check). */
export const SUCCEEDED_LINE = "Card approved — Stripe confirmed the charge. Recording it on the invoice…";

/** "Not charged — try again. The phone said approved, but Stripe shows no charge: the card has insufficient funds." */
export function notChargedSentence(lastError: string | null | undefined): string {
  const why = (lastError ?? "").trim().replace(/\.$/, "");
  return `${NOT_CHARGED_LEAD}${why ? `: ${why}` : ""}.`;
}

/** When the second look at Stripe couldn't be taken either: the person is told what is and isn't known. */
export const UNCHECKED_TIMEOUT_SENTENCE =
  "Couldn't double-check with Stripe. The card may or may not have been charged — open the invoice and look for the payment before tapping again.";

/** Stripe still says processing after the whole watch: not a decline, not a charge — say so. */
export const STILL_PROCESSING_SENTENCE =
  "Stripe is still finishing this charge. Open the invoice and look for the payment before tapping again.";

/** Stripe says succeeded and the row still isn't there after the whole watch: nothing more to tap. */
export const CHARGED_NOT_RECORDED_SENTENCE =
  "Stripe confirmed the charge, but it isn't on the invoice yet. Don't tap again — it records itself when Stripe's message lands. Open the invoice in a minute.";

export type TapVerdict =
  /** Stripe says succeeded and the row is at rest: the Paid screen. */
  | { kind: "paid" }
  /** Keep watching, with the line that says how sure we are. `checked` = Stripe answered. */
  | { kind: "confirmed"; note: string; checked: boolean }
  /** The phone said yes and Stripe says no: the box. "failed" offers Try Again on the same
   *  PaymentIntent; "setup" doesn't (the charge is real, nothing more to tap). */
  | { kind: "error"; error: string; outcome: "failed" | "setup" };

/**
 * The bridge said ok; Stripe was asked. What does the sheet say?
 *
 *   succeeded, recorded    → Paid. (requires_capture never happens here — capture is automatic —
 *                            but it is Stripe's "the money is yours", so it counts the same.)
 *   succeeded, not yet     → keep watching, honestly: the charge is real, the row is the webhook's.
 *   processing             → keep watching, honestly: the charge exists and isn't finished.
 *   anything else          → "Not charged — try again", with Stripe's own reason in plain words.
 *   no answer (null / !ok) → keep watching, honestly: the claim is shown as a claim.
 */
export function verdictAfterConfirm(v: TapOutcomeAnswer | null | undefined): TapVerdict {
  if (!v || !v.ok) return { kind: "confirmed", note: UNCHECKED_LINE, checked: false };
  if (v.status === "succeeded" || v.status === "requires_capture") {
    return v.recorded ? { kind: "paid" } : { kind: "confirmed", note: SUCCEEDED_LINE, checked: true };
  }
  if (v.status === "processing") return { kind: "confirmed", note: PROCESSING_LINE, checked: true };
  return { kind: "error", error: notChargedSentence(v.lastError), outcome: "failed" };
}

export type WatchDeps = {
  /** The invoice's live money: "paid" the moment the row lands, "open" while it hasn't, "unknown" when the read failed. */
  poll: () => Promise<"paid" | "open" | "unknown">;
  /** The second look at Stripe (tapPaymentOutcome), null when the read itself failed. */
  verify: () => Promise<TapOutcomeAnswer | null>;
  /** False once the sheet has closed or this press was retired: stop, paint nothing. */
  alive?: () => boolean;
  /** How long the poll may run before Stripe is asked again. */
  timeoutMs?: number;
  /** The poll's cadence — the same 4 s the QR watch uses. */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WatchResult = { kind: "paid" } | { kind: "error"; error: string; outcome: "failed" | "setup" } | { kind: "stopped" };

/**
 * THE CONFIRMED WATCH, WITH AN END.
 *
 * Polls the invoice on the QR watch's cadence until it reads Paid — then, after `timeoutMs`
 * (~20 s) with nothing landed, asks Stripe ONCE MORE. Succeeded and recorded → Paid (the action
 * books it if the webhook hasn't). Not succeeded → the "Not charged — try again" box. Stripe
 * unreachable, still processing, or charged-but-not-recorded → a sentence that says exactly
 * that and what to look at. It never spins forever, and it paints nothing once `alive()` is
 * false.
 */
export async function watchConfirmedTap(deps: WatchDeps): Promise<WatchResult> {
  const alive = deps.alive ?? (() => true);
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const intervalMs = deps.intervalMs ?? 4_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const started = now();
  while (alive()) {
    await sleep(intervalMs);
    if (!alive()) return { kind: "stopped" };
    if ((await deps.poll()) === "paid") return { kind: "paid" };
    if (now() - started >= timeoutMs) break;
  }
  if (!alive()) return { kind: "stopped" };
  const v = await deps.verify();
  if (!alive()) return { kind: "stopped" };
  const verdict = verdictAfterConfirm(v);
  if (verdict.kind === "paid") return { kind: "paid" };
  if (verdict.kind === "error") return verdict;
  // Still not at rest after the whole watch: one more honest line, and an end.
  if (!verdict.checked) return { kind: "error", error: UNCHECKED_TIMEOUT_SENTENCE, outcome: "failed" };
  if (verdict.note === SUCCEEDED_LINE) return { kind: "error", error: CHARGED_NOT_RECORDED_SENTENCE, outcome: "setup" };
  return { kind: "error", error: STILL_PROCESSING_SENTENCE, outcome: "setup" };
}
