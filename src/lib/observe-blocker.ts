import "server-only";
import { errorMessage, recordAppError, reportError } from "@/lib/observe";
import { alertPlatformAdmins } from "@/lib/platform-alert";

/**
 * A BLOCKER PAGES NORTH'S OWN TEAM (cn-v1136, the error sink that triages itself). An error row is
 * read at the morning sweep; a blocker is platform-wide — the Stripe webhook refusing every event, a
 * dead mail or model key, the whole nightly cron fallen over — and waiting for the morning is how a
 * week of refused card payments goes unheard. So a blocker's write is read back (0399 says whether it
 * INSERTED a new row or REOPENED a fixed one), and only then is anyone paged:
 *
 *   · the first sighting pages (inserted);
 *   · a fixed row seen again pages, and says it is back (reopened);
 *   · a row that was an everyday error and is a blocker for the first time pages (escalated,
 *     skeptic #42 S2): a key with history — a cron that had failed once, a webhook refusal from a
 *     past wave — is upgraded on conflict, and without this nobody heard its first blocker;
 *   · a repeat is a count bump and pages nobody — a storm is one page, not a thousand;
 *   · a write that failed (null) pages nobody: there is no row to point at, and the console line
 *     already went.
 *
 * Never throws. A page that could not be sent is filed as a plain error under "platform-alert" —
 * NEVER as a blocker, or a dead push key would page about its own page forever. A page that reached
 * NOBODY (sent 0: no admin with a company, every notify skipped) is filed the same way (S7): a
 * blocker that paged nobody is the one silence this door exists to end.
 */
async function fileBlocker(where: string, e: unknown, extra?: Record<string, unknown>): Promise<void> {
  const r = await recordAppError(where, e, extra, "blocker");
  if (!r || !(r.inserted || r.reopened || r.escalated)) return;
  try {
    const sent = await alertPlatformAdmins({ where, message: errorMessage(e), reopened: r.reopened, escalated: r.escalated });
    if (sent.sent === 0) reportError("platform-alert", new Error("no admin reachable"), { where, skipped: sent.skipped });
  } catch (alertErr) {
    reportError("platform-alert", alertErr, { where });
  }
}

/** Fire-and-forget: the row, then the page when it is the first sighting or a return. */
export function reportBlocker(where: string, e: unknown, extra?: Record<string, unknown>): void {
  try {
    void fileBlocker(where, e, extra).catch(() => {});
  } catch {
    /* never let reporting throw */
  }
}

/**
 * THE SAME, WAITED FOR: a route that answers on the very tick it files (the Stripe webhook, a cron's
 * 500) can be frozen the moment its response is out, so the write and the page are awaited — four
 * seconds at most (two for the row, as reportErrorAwaited, and two more for the page) — and the
 * caller still never sees a throw.
 */
export async function reportBlockerAwaited(where: string, e: unknown, extra?: Record<string, unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fileBlocker(where, e, extra), new Promise<void>((r) => { timer = setTimeout(r, 4000); })]);
  } catch {
    /* never let reporting throw */
  } finally {
    if (timer) clearTimeout(timer);
  }
}
