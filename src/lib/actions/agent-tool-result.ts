import type { ActionResult } from "./types";

/**
 * WHAT THE MODEL LEARNS ABOUT A WRITE IT JUST MADE — THE PROJECTION LAW, in one testable place.
 *
 * This object IS everything Nort knows about what it did. It is an explicit allowlist, which is the
 * right shape (a handler's internals must not leak into a prompt) and also the exact place the law
 * keeps being broken: audit v800 found `warning` and `recorded` stripped here, so Nort announced
 * "3 hours logged" for a three-second entry with the correction sitting unread in a dropped field.
 * It happened again on Erik's TTP 56 morning (2026-10-01): the clock-in handler attached the "the app
 * picked this job" sentence as a field of its own, this list did not carry it, and Nort read
 * `{"ok":true}` — so it answered "You're clocked in" while 2h19m billed the wrong customer, in
 * exactly the silence that fix exists to end.
 *
 * It lives here, as a pure function, so a test can read what the model would actually be handed
 * instead of trusting that a handler's field survives the trip (clock-told.test.ts).
 *
 * ADDING A FIELD IS A DELIBERATE ACT: put it on ActionResult (lib/actions/types) AND here, with a
 * test that the projected body carries it. Inventing one only on a handler drops it silently.
 */
export function agentToolResultBody(res: ActionResult, dropped?: string | null): string {
  // A switched-off field the agent sent anyway is said beside whatever the write had to say: both
  // are "it landed, and something about it has to be heard", and both ride the one channel.
  const warning = [res.warning, res.ok ? dropped : null].filter(Boolean).join(" ");
  return JSON.stringify({
    ok: res.ok,
    error: res.error ?? null,
    // missingFields rides through so Nort can ask for exactly what's absent ("I've got the job —
    // still need the hours") instead of parroting the bare zod "Required".
    ...(res.missingFields?.length ? { missingFields: res.missingFields } : {}),
    ...(warning ? { warning } : {}),
    ...(res.recorded ? { recorded: res.recorded } : {}),
    ...(res.speak ? { speak: res.speak } : {}),
    ...(res.data ? { data: res.data } : {}),
  });
}
