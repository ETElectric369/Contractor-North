/**
 * WHAT createJob SAYS ABOUT THE VISIT IT TIED (cn-v1181 fixer, skeptic #84 S6), said by every door that
 * makes a job by hand: `note` (a visit was filed with the new job, and its lead marked Won) as a success
 * the person reads, `warning` (the tie failed, or could not be read) as an error. Both stay until read,
 * because each door closes its form on success. Nothing when there is nothing to say.
 */
type Toast = (message: string, kind?: "success" | "error" | "info", action?: undefined, opts?: { sticky?: boolean }) => void;

export function sayTie(toast: Toast, res: { note?: string | null; warning?: string | null }): void {
  if (res.note) toast(res.note, "success", undefined, { sticky: true });
  if (res.warning) toast(res.warning, "error", undefined, { sticky: true });
}
