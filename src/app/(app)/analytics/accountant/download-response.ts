/**
 * IS THIS THE FILE? The download button's one check, before anything is saved or shared.
 *
 * The export route is not under /api/, so when the session is gone the middleware answers with a
 * redirect to /login, never the route's own "Not signed in." A fetch that followed it would get the
 * login page with a 200, and the button would save that HTML as "ET Electric 2026.xlsx" and say
 * "Downloaded". So the button fetches with redirect: "manual" (a redirect comes back opaque), and
 * this says what came back in words: signed out, the route's own refusal, or not the file.
 */

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const ZIP_TYPE = "application/zip";

export const SIGNED_OUT_WORDS = "You've been signed out. Sign in again, then download.";
export const NOT_THE_FILE_WORDS = "The download didn't come through: North sent back a page, not the file. Nothing was saved. If you've been signed out, sign in again, then download.";
export const DIDNT_COME_WORDS = "The download didn't come through. Nothing was made; try again.";

export type DownloadResponseFacts = {
  ok: boolean;
  status: number;
  /** Response.type: "opaqueredirect" when a redirect: "manual" fetch met a redirect. */
  type?: string;
  redirected?: boolean;
  contentType: string | null;
  disposition: string | null;
  /** The body as text, read only when the response is not ok (the route's refusal). */
  body?: string;
};

export type DownloadVerdict = { ok: true } | { ok: false; words: string };

export function downloadVerdict(r: DownloadResponseFacts, want: "xlsx" | "csv"): DownloadVerdict {
  if (r.type === "opaqueredirect" || r.redirected || r.status === 401) return { ok: false, words: SIGNED_OUT_WORDS };
  const type = String(r.contentType ?? "").toLowerCase();
  if (!r.ok) {
    // The route's refusals are plain text, in words. Anything else (an error page) is not.
    const words = String(r.body ?? "").trim();
    return { ok: false, words: type.startsWith("text/plain") && words && words.length < 400 ? words : DIDNT_COME_WORDS };
  }
  const expected = want === "xlsx" ? XLSX_TYPE : ZIP_TYPE;
  if (!type.startsWith(expected) || !r.disposition || !/attachment/i.test(r.disposition)) return { ok: false, words: NOT_THE_FILE_WORDS };
  return { ok: true };
}
