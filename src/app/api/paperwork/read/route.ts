import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { aiReviewItem, readPaperworkItem } from "@/app/(app)/organize/actions";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A 12-page supplier PDF or a slow read gets the reader's own time, whichever page the read was
// started from (W1-30: Snap Or Note is in the top bar of every page, and a server action runs under
// the page's time, not this). Saved is saved either way: a read that runs out says so on its line.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * READ ONE PAPER THE OFFICE PUT IN THROUGH SNAP OR NOTE. Staff only (a paper carries prices), and
 * org-scoped twice: here, and inside readPaperworkItem (the row is read by id AND the caller's
 * company). It reads and stops: nothing is filed, and the answer is the same OrganizedResult the
 * server action gives Organize.
 */
export async function POST(req: Request) {
  const ctx = await requireStaff();
  if ("error" in ctx) return NextResponse.json({ ok: false, error: ctx.error ?? "This is the office's." }, { status: 403 });
  if (!ctx.orgId) return NextResponse.json({ ok: false, error: "Your sign-in isn't attached to a company yet." }, { status: 403 });
  let id = "";
  let note = false;
  try {
    const body = (await req.json()) as { id?: unknown; note?: unknown };
    id = String(body?.id ?? "");
    note = body?.note === true;
  } catch {
    return NextResponse.json({ ok: false, error: "That wasn't a paper to read." }, { status: 400 });
  }
  if (!UUID.test(id)) return NextResponse.json({ ok: false, error: "That wasn't a paper to read." }, { status: 400 });
  if (note) {
    // AN OFFICE NOTE, ALREADY SAVED (W1-30): the sheet saved it first with no read, so a read that
    // runs out of time or loses signal can only ever say "Saved, Not Read", never "Not saved".
    // aiReviewItem is staff-only and reads the row by id AND the caller's company.
    try {
      const r = await aiReviewItem(id);
      return NextResponse.json({ ok: r.ok === true, ...(r.ok ? {} : { error: r.message }) });
    } catch (e) {
      reportError("paperwork:read.note", e, { id });
      return NextResponse.json({ ok: false, error: "the reader didn't answer." });
    }
  }
  const res = await readPaperworkItem(id);
  return NextResponse.json(res);
}
