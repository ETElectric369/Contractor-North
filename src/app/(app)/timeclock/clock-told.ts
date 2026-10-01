/**
 * WHAT THE CLOCK TELLS YOU ABOUT THE JOB IT PUT YOUR PUNCH ON.
 *
 * Erik, 2026-10-01: "we didn't do the job at TTP 56 this morning. Brian clocked in on his way to the
 * Supply house to get materials for Whitney before I could switch the schedule." Two punches landed
 * on the job the schedule happened to be showing — 2h19m of billable time on the wrong customer —
 * and the clock said nothing, because it only speaks up when it CANNOT tell the job (askAfterPunch,
 * which-job-choices). A punch the app placed looked exactly like a punch the person placed.
 *
 * Then the loop closed: those hours made that job a WORKED day, and moveJobDay deliberately keeps
 * worked days where they happened — so the job would not leave today when Erik tried to move it. A
 * punch the app assigned pinned the schedule, and the pinned schedule made the punch look right.
 *
 * NOTHING SILENT. So the clock now reports WHO chose the job, and when the answer is "the app did"
 * every door says one plain sentence naming the job the way a person knows it, with one tap to move
 * it. When the PERSON chose the job (a staff pick in More Options, the job page's own clock-in, an
 * appointment's Start) nothing new is said: they already know.
 *
 * TWO RULES, ONE COPY OF EACH, and every clock door calls them:
 *   · askAfterPunch (which-job-choices) — whether to ASK, for a punch that landed on no job;
 *   · tellAppChose (here)               — whether to TELL, for a punch the app put on a job.
 * They are mutually exclusive by construction: a punch with a job never carries `noJob`, and a punch
 * with no job never carries a `jobPick`. The clock stays TWO BUTTONS — this is a sentence with a
 * link, not a modal. Ignore it and the punch stays exactly where the app put it.
 *
 * A plain module, never "use server": it is imported by the server actions AND by every client door.
 */
import { askAfterPunch, whichJobLabel, type ChoiceJob, type WhichJobAsk } from "./which-job-choices";

/** Who put the job on a punch. "app": nobody picked it — the clock resolved it from the schedule. */
export type JobChosenBy = "person" | "app";

/**
 * The job a punch landed on, and who chose it. A UNION, not a boolean beside a label, because the
 * two carry different facts: only the app's pick needs a label, since only the app's pick gets said
 * out loud. Never infer "the app chose this" from job_id being present — a person-picked punch has
 * one too; that inference is the whole defect.
 */
export type PunchJob = { chosenBy: "person"; id: string } | { chosenBy: "app"; id: string; label: string };

/**
 * THE JOB AS A PERSON KNOWS IT (Erik: "i cant tell by job numbers alone"). The Timeclock's own
 * label SSOT (whichJobLabel: codes on = the job's name, codes off = customer · street), plus the
 * street when the label doesn't already carry it — so the sentence always says where the work is,
 * and a job that was never named reads "J-013 · 56 Timber Trail Pl", never a bare number.
 */
export function punchJobLabel(j: ChoiceJob, codesOn: boolean): string {
  const base = whichJobLabel(j, codesOn);
  const street = (j.address ?? "").trim();
  if (!street || base.toLowerCase().includes(street.toLowerCase())) return base;
  return `${base} · ${street}`;
}

/** When the job's own row could not be read, the sentence still goes out — it just can't name the
 *  job. Silence would be the one unacceptable answer; the Change door beside it still opens the sheet,
 *  which reads the job list itself. */
export const UNREAD_JOB_LABEL = "a job it couldn't name just now";

/** THE ONE SENTENCE a door says when the app chose the job. Plain words, the job named, and it ends
 *  in the door out, so it is never a dead end. */
export function appChoseSentence(label: string): string {
  return `Your punch is on ${label}. The app picked that from today's schedule — change it if you're somewhere else.`;
}

/** The Change door's words, Title Case, one copy (buttons on three surfaces read the same). */
export const CHANGE_JOB_LABEL = "Change The Job";

/** What a door puts on screen: the sentence, and the job the Change door moves the punch OFF. */
export type AppChoseNotice = {
  /** The punch, for the "Which Job Are You On?" sheet the Change door opens. */
  entryId: string;
  /** The job the app chose: its id (the sheet moves off it) and its label (said, and shown). */
  job: { id: string; label: string };
  sentence: string;
};

/** The shape of a clock answer this module reads. Every clock door's result is one of these. */
export type ToldResult = { ok: boolean; id?: string; noJob?: boolean; jobPick?: PunchJob; error?: string; warning?: string };

/**
 * THE ONE RULE EVERY CLOCK DOOR USES TO DECIDE WHETHER TO TELL: a punch that is saved (ok, with its
 * id) whose job the APP chose. A refusal, a person-picked job, a punch that landed on no job (that
 * one ASKS instead), or an answer without the entry id tells nothing.
 */
export function tellAppChose(res: ToldResult | null | undefined): AppChoseNotice | null {
  if (!res?.ok || !res.id) return null;
  const pick = res.jobPick;
  if (!pick || pick.chosenBy !== "app") return null;
  return { entryId: res.id, job: { id: pick.id, label: pick.label }, sentence: appChoseSentence(pick.label) };
}

/** What the Change door opens: the clock's own sheet, in move mode, off the job the app chose. */
export function changeJobAsk(notice: AppChoseNotice): WhichJobAsk {
  return { entryId: notice.entryId, moment: "move", from: notice.job };
}

/** A refusal TIME fixes (a session that hadn't refreshed after hours offline) is not a permanent
 *  rejection: the queue waits and tries again instead of quarantining the morning. */
const TRANSIENT_REFUSAL = /sign(ed)? in|session|expired|temporar|timeout|network|fetch/i;

/** Everything the offline queue's replay has to put on screen once a held punch finally lands. */
export type ReplayTold = {
  /** The punch landed on no job: the sheet asks, as it does at every other door. */
  ask: WhichJobAsk | null;
  /** The punch landed on a job the APP chose: say so, with the Change door. */
  told: AppChoseNotice | null;
  /** Anything else the punch did that nobody chose (a job it took off hold), kept until Got It. */
  said: string[];
  /** Try this one again later rather than quarantining it. */
  retryable: boolean;
};

/**
 * WHAT A REPLAYED PUNCH SAYS WHEN IT LANDS — and this is the door that matters most, because it is
 * Brian in a truck. A punch held on the phone in a dead zone still had its job chosen by the app,
 * hours after the tap, and the person must still be told where it went. Same two rules as the live
 * doors (askAfterPunch, tellAppChose), so the queue's door can never drift from the clock's.
 */
export function replayTold(res: ToldResult | null | undefined): ReplayTold {
  const warning = res?.ok ? (res.warning ?? "").trim() : "";
  return {
    ask: askAfterPunch(res, "in"),
    told: tellAppChose(res),
    said: warning ? [warning] : [],
    retryable: !!res && !res.ok && TRANSIENT_REFUSAL.test(res.error ?? ""),
  };
}
