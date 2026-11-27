import { reportClientError } from "@/app/report-client-error";
import type { PunchMiss } from "@/lib/punch-gps";

/**
 * THE REASON IS LEFT BEHIND (cn-v1201). The owner's clock-in had no position and nothing said why:
 * the punch's read, the fence's once-a-minute asks and what each one answered were thrown away. So at
 * two moments of a clock-in the fence sends ONE trace row to the ops sink (client:geo, level trace):
 *
 *   no-position   the adoption window closed and the punch never got a position
 *   stamped-late  the fence's late stamp landed (adoptGeofenceAnchor answered ok)
 *
 * The row holds codes and counts ONLY: never a latitude, a longitude, an address, a label, a job, a
 * person or an entry id, in the payload, the title or the console. Pure, apart from sendPunchTrace.
 */

export type PunchOutcome = "no-position" | "stamped-late";
/** What one fence check got: a read's own answer, or noRead when the gate refused to read; and, when
 *  the punch's read was not "ok" (and not "denied"), what the sharp follow-up read got: sharpOk when
 *  its word was "ok", else sharpMiss (cn-v1201, the adoption never does worse than before). */
export type PunchCheckWord = "ok" | "rough" | "stale" | "timeout" | "unavailable" | "denied" | "insecure" | "noRead" | "sharpOk" | "sharpMiss";
export const PUNCH_CHECK_WORDS: readonly PunchCheckWord[] = ["ok", "rough", "stale", "timeout", "unavailable", "denied", "insecure", "noRead", "sharpOk", "sharpMiss"];

export type PunchTally = { checks: Record<PunchCheckWord, number>; bestM: number | null };

export function newPunchTally(): PunchTally {
  const checks = {} as Record<PunchCheckWord, number>;
  for (const w of PUNCH_CHECK_WORDS) checks[w] = 0;
  return { checks, bestM: null };
}

/** Count one check; an answer that carried an accuracy keeps the best (smallest) one seen. */
export function tallyCheck(t: PunchTally, word: PunchCheckWord, accuracyM?: number | null): void {
  if (!PUNCH_CHECK_WORDS.includes(word)) return;
  t.checks[word] += 1;
  if (typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM >= 0) {
    t.bestM = t.bestM === null ? accuracyM : Math.min(t.bestM, accuracyM);
  }
}

/** Metres rounded UP to a multiple of 50 (a bucket, never the phone's own figure). */
export function bucketMetres(m: number | null): number | null {
  if (typeof m !== "number" || !Number.isFinite(m) || m < 0) return null;
  return Math.ceil(m / 50) * 50;
}

/** Seconds rounded to the nearest 5, never below 0. */
export function roundSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 1000 / 5) * 5;
}

export type PunchTracePayload = {
  outcome: PunchOutcome;
  tap: PunchMiss | null;
  checks: Record<PunchCheckWord, number>;
  best_m: number | null;
  seconds: number;
  native: boolean;
  shell1116: boolean;
  auth: string | null;
};

const AUTH_WORDS = new Set(["always", "whenInUse", "denied", "restricted", "notDetermined"]);
const MISS_WORDS = new Set(["rough", "stale", "denied", "timeout", "unavailable", "insecure", "cap"]);

export function punchTracePayload(i: {
  outcome: PunchOutcome;
  tap: PunchMiss | null;
  tally: PunchTally;
  openedMs: number;
  nowMs: number;
  native: boolean;
  shell1116: boolean;
  auth: string | null;
}): PunchTracePayload {
  const checks = {} as Record<PunchCheckWord, number>;
  for (const w of PUNCH_CHECK_WORDS) checks[w] = Math.max(0, Math.floor(i.tally.checks[w] ?? 0));
  return {
    outcome: i.outcome === "stamped-late" ? "stamped-late" : "no-position",
    tap: i.tap && MISS_WORDS.has(i.tap) ? i.tap : null,
    checks,
    best_m: bucketMetres(i.tally.bestM),
    seconds: roundSeconds(i.openedMs > 0 ? i.nowMs - i.openedMs : 0),
    native: !!i.native,
    shell1116: !!i.shell1116,
    auth: i.auth && AUTH_WORDS.has(i.auth) ? i.auth : null,
  };
}

// This page load's own mark, so two rows never share a title (the sink dedupes on the title and a
// repeat REPLACES the payload, lib/nort/trace flushTrace).
const loadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
let rowNo = 0;

export function punchTraceTitle(outcome: PunchOutcome): string {
  return `clock-in location ${outcome} (load ${loadId}, row ${++rowNo})`;
}

/** Send the row. Never throws; reporting must never break the fence. */
export function sendPunchTrace(p: PunchTracePayload): void {
  try {
    void reportClientError("geo", punchTraceTitle(p.outcome), { ...p }, "trace").catch(() => {});
  } catch {
    /* never let reporting throw */
  }
}
