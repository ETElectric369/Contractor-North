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
  // Change orders have no page of their own, and no list (W2-12): each lives on its job's Change
  // Orders tab, whose door passes back=/jobs/<id>?tab=change-orders (that wins above). The id here is
  // the change order's, never the job's, so with no back= the honest page is Jobs.
  "change-order": () => "/jobs",
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

/** The two papers opened from a page of their own, whose header draws Preview (components/preview-button). */
export type PreviewedDoc = "invoice" | "quote";

/**
 * THE WAY IN, FROM A DOCUMENT'S OWN PAGE (2026-11-10): the address of an invoice's or an estimate's
 * PDF preview, with `back=` naming that page. It is byte for byte what the two ⋯ rows wrote out by
 * hand before the header's Preview replaced them, and it reads the same table Back falls back to, so
 * the door in and the way home cannot come to name two different pages. The other papers are opened
 * from a job's tab and say their own `back=`.
 */
export function pdfPreviewHref(doc: PreviewedDoc, id: string): string {
  return `/print/pdf-preview?doc=${doc}&id=${id}&back=${DOC_PAGE[doc](id)}`;
}
