import { safeNextPath } from "@/lib/safe-next";

/**
 * WHERE THE PDF VIEWER'S BACK GOES WHEN THERE IS NO HISTORY TO POP.
 *
 * BackLink pops history whenever the arrival was in-app; this is the other case: a direct open,
 * a reload, a hard navigation with no same-origin referrer. The viewer lives under /print, outside
 * the app shell, so it has no dock and no topbar; in the iOS shell there is no swipe-back either
 * (be3dca81: "Can't get back from PDF screen have to restart app"). Back is the only door out,
 * and it has to land somewhere real.
 *
 * Every in-app door passes `back=` (the page it was opened from), so that wins when it is a safe
 * in-app path. Without one, the document's own page is the honest answer; failing that, My Day,
 * which is where the app itself opens. Never "/": on a browser that is the marketing landing.
 */
const DOC_PAGE: Record<string, (id: string) => string> = {
  invoice: (id) => `/billing/${id}`,
  quote: (id) => `/quotes/${id}`,
  "work-order": (id) => `/work-orders/${id}`,
  "material-list": (id) => `/materials/${id}`,
  // Change orders have no page of their own; the list is where each one is opened from.
  "change-order": () => "/change-orders",
  // The prelim notice is printed from the job, and its id IS the job id.
  "prelim-notice": (jobId) => `/jobs/${jobId}`,
  // The panel directory is printed from the job's Panel tab, and its id is the job id too.
  panel: (jobId) => `/jobs/${jobId}?tab=panel`,
};

export function pdfPreviewBackHref(doc: string, id: string, back: string): string {
  // `back` arrives from the query string, and this page is reached straight from a money
  // document: "//evil.tld" or "/\evil.tld" would turn our own Back into an off-site redirect.
  const fromCaller = safeNextPath(back);
  if (fromCaller) return fromCaller;
  const page = Object.prototype.hasOwnProperty.call(DOC_PAGE, doc) ? DOC_PAGE[doc] : null;
  // Ids are uuids. Anything else is not one of ours and must not become part of a path.
  if (page && /^[0-9a-f-]{1,64}$/i.test(id)) return page(id);
  return "/planner";
}
