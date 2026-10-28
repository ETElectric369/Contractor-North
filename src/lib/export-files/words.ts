import { SUPPORT_EMAIL } from "@/app/north-site/site-facts";

/**
 * THE FILE EXPORTS' WORDS (cn-v1138), in one place so the two routes and their tests cannot drift.
 * Each refusal is one sentence naming one action; the download button shows it on the card as it
 * is (lib/download-response: a plain-text body under 400 characters is the words).
 */
export const JOB_NOT_HERE_WORDS = "That job isn't here.";
export const JOB_NO_FILES_WORDS = "This job has no files yet.";
export const COMPANY_NO_FILES_WORDS = "The company has no files yet.";
export const COMPANY_UNREAD_WORDS = "Your company couldn't be read just now. Nothing was made; try again.";
export const JOB_UNREAD_WORDS = "This job couldn't be read just now. Nothing was made; try again.";
export const FILES_UNLISTED_WORDS = "The files couldn't be listed just now. Nothing was made; try again.";

/** The support address: the mailbox's env name first (billing-notices reads it the same way), the
 *  site's own constant when none is set. */
export function supportAddress(): string {
  return process.env.SUPPORT_EMAIL?.trim() || SUPPORT_EMAIL;
}

export const tooBigWords = (support: string = supportAddress()): string => `Too big to pack here. Write to ${support}.`;

export const couldNotReadWords = (failed: number, total: number): string =>
  `${failed} of ${total} ${total === 1 ? "file" : "files"} could not be read. Nothing was made. Try again.`;
