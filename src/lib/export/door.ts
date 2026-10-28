import { rateLimited } from "@/lib/rate-limit";

/**
 * THE TWO CHECKS EVERY EXPORT DOOR MAKES AFTER THE GUARD (cn-v1138). The three GETs (records, a
 * job's files, the company's files) are plain links an owner's browser can be made to open from
 * anywhere — an `<img src>` on any page the owner visits would fire a ninety-table read or 400 MB
 * of egress. So, first thing after the owner is known:
 *   1. a CROSS-SITE fetch is refused (the browser says so in Sec-Fetch-Site; the Your Data card's
 *      button is same-origin, and a stranger's page is "cross-site");
 *   2. the company's downloads are counted: EXPORTS_PER_HOUR an hour across the three doors, keyed
 *      on the company (lib/rate-limit, the Postgres window every public door uses; it fails OPEN,
 *      the right trade for an authenticated owner).
 * One rule in one function, so the three routes cannot drift. Each refusal is one sentence naming
 * one action, as plain text the download button shows on the card.
 */
export const CROSS_SITE_WORDS = "Open this from Settings › Getting Paid › Your Data.";
export const TOO_MANY_DOWNLOADS_WORDS = "That's enough downloads for this hour. Try again in an hour.";

export const EXPORTS_PER_HOUR = 10;
export const EXPORT_WINDOW_SECONDS = 60 * 60;

export const exportRateKey = (orgId: string): string => `export:${orgId}`;

export type ExportDoorRefusal = { status: number; words: string };

export async function exportDoorRefusal(req: { headers: { get(name: string): string | null } }, orgId: string): Promise<ExportDoorRefusal | null> {
  if (req.headers.get("sec-fetch-site") === "cross-site") return { status: 403, words: CROSS_SITE_WORDS };
  if (await rateLimited(exportRateKey(orgId), EXPORTS_PER_HOUR, EXPORT_WINDOW_SECONDS)) return { status: 429, words: TOO_MANY_DOWNLOADS_WORDS };
  return null;
}
