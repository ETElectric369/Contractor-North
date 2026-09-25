/**
 * WHICH OF A JOB'S PAPERS A TECH IS HANDED (audit v994, herringbone HB-2).
 *
 * The job page loaded every document on the job, signed every one with the viewer's own login and
 * passed them all to the Photos tab, which is pinned for techs and picks "photos" by file
 * extension. A receipt snapped on the job page is a .jpg in the job's own folder (receipt-capture
 * files it there, member-readable), so Brian, clocked on J-011, opened the Photos tab and saw the
 * CED counter ticket and the Home Depot receipt full size, with every price. Techs never see
 * prices (Erik's law), and the page is the boundary that decides what a tech's browser receives.
 *
 * So a tech is handed papers by what they ARE, from an allow-list: photos, plans, permits, notes
 * and other job papers, never a cost paper (a Receipt, a Bill, an Invoice, or a category nobody
 * set). It is chosen by what is allowed, not by what is refused: a category added later is kept
 * from a tech until someone decides a tech should see it, and a paper with no category (NULL,
 * which a NOT IN would also drop, silently) is left out on purpose. Only these are signed, so no
 * URL to a receipt ever reaches a tech's page data. The office keeps every paper, as before.
 */
export const TECH_DOCUMENT_CATEGORIES = ["Photo", "Plan", "Permit", "Note", "Other"] as const;

export function isTechDocument(d: { category?: string | null }): boolean {
  return (TECH_DOCUMENT_CATEGORIES as readonly string[]).includes(String(d?.category ?? ""));
}

/** The documents this viewer may be handed: all of them for the office, the allow-list for a tech. */
export function documentsForViewer<T extends { category?: string | null }>(rows: readonly T[] | null | undefined, viewerIsStaff: boolean): T[] {
  const all = [...(rows ?? [])];
  return viewerIsStaff ? all : all.filter(isTechDocument);
}
