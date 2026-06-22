/** CA mechanics-lien deadline math. A direct claimant generally has 20 days from FIRST
 *  FURNISHING to serve the Preliminary Notice, and 90 days from COMPLETION to record the
 *  lien (60 if the owner records a Notice of Completion). These are the common deadlines
 *  CN surfaces as reminders — NOT legal advice; the contractor confirms the specifics for
 *  their role and jurisdiction. Pure + dateable for tests. */

const DAY = 86_400_000;
const parse = (s: string): number => Date.parse(`${s}T12:00:00Z`);
function addDays(s: string, days: number): string {
  return new Date(parse(s) + days * DAY).toISOString().slice(0, 10);
}
function daysUntil(target: string, today: string): number {
  return Math.round((parse(target) - parse(today)) / DAY);
}

export const PRELIM_WINDOW_DAYS = 20;
export const LIEN_WINDOW_DAYS = 90;

export type LienStatus = {
  prelimDeadline: string | null;
  lienDeadline: string | null;
  prelimDaysLeft: number | null; // negative = past due
  lienDaysLeft: number | null;
  prelimDone: boolean;
  lienDone: boolean;
  prelimUrgent: boolean; // not yet served and within a week (or past due)
  lienUrgent: boolean;
};

export function lienStatus(input: {
  firstFurnishedDate?: string | null;
  completionDate?: string | null;
  prelimSentAt?: string | null;
  lienRecordedAt?: string | null;
  nocRecorded?: boolean | null; // owner recorded a Notice of Completion/Cessation -> shorter window
  isSubcontractor?: boolean | null; // 30 days after a NOC for a sub, vs 60 for the direct contractor
  today?: string;
}): LienStatus {
  const today = input.today || new Date().toISOString().slice(0, 10);
  const prelimDone = !!input.prelimSentAt;
  const lienDone = !!input.lienRecordedAt;
  const prelimDeadline = input.firstFurnishedDate ? addDays(input.firstFurnishedDate, PRELIM_WINDOW_DAYS) : null;
  // A recorded Notice of Completion/Cessation shortens the lien window: 60 days for the
  // direct contractor, 30 for a subcontractor (Cal. Civ. Code §8412/§8414).
  const lienWindow = input.nocRecorded ? (input.isSubcontractor ? 30 : 60) : LIEN_WINDOW_DAYS;
  const lienDeadline = input.completionDate ? addDays(input.completionDate, lienWindow) : null;
  const prelimDaysLeft = prelimDeadline ? daysUntil(prelimDeadline, today) : null;
  const lienDaysLeft = lienDeadline ? daysUntil(lienDeadline, today) : null;
  return {
    prelimDeadline,
    lienDeadline,
    prelimDaysLeft,
    lienDaysLeft,
    prelimDone,
    lienDone,
    prelimUrgent: !prelimDone && prelimDaysLeft != null && prelimDaysLeft <= 7,
    lienUrgent: !lienDone && lienDaysLeft != null && lienDaysLeft <= 14,
  };
}
