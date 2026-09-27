"use server";

import { dbError } from "@/lib/db-error";
import { requireMember, requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { signDocumentUrls } from "@/lib/signed-docs";
import { parseCedDocuments } from "@/lib/ced-invoice-parse";
import { parseCSV } from "@/lib/csv";
import { openListFromText } from "@/lib/supplier-open-list";
import type { NumberMatch } from "@/lib/paperwork";
import type { PaperRowItem } from "@/components/paperwork-row";
import { whichJobLabel, type ChoiceJob } from "@/app/(app)/timeclock/which-job-choices";
import { loadBooks, loadMarkContext, matchesOnBooks, OPEN_JOBS_FOR_PAPER, PAPER_JOB_STATUSES, rematchTray } from "@/app/(app)/organize/paperwork-core";
import { openListViews } from "@/app/(app)/bills/open-list-core";
import { bankLinesStayHere, bankViews } from "@/app/(app)/bills/bank-core";
import { importCedInvoices } from "@/app/(app)/bills/supplier-import-actions";

/**
 * SNAP OR NOTE'S SERVER HALF (W1-30). The sheet lives in the top bar on every page, and the top bar
 * hands it no company, no role and no rows, so it asks for them here:
 *
 *   · snapContext: who is asking (the company, office or crew), the job on their open punch, and
 *     for a tech the jobs a photo can go on, as LABELS only (whichJobLabel). No price is read.
 *   · snapPaperRows: the cards for the papers the sheet took this visit (the same rows Organize
 *     and Bills draw: rematched, signed, a bank download's lines kept here). Staff only: they carry
 *     prices.
 *   · routePastedText: a note that is really a supplier's invoices (or its open list, or a
 *     statement) pasted in goes to the importer Bills' paste box used, instead of becoming a note.
 *
 * Every read runs on the caller's own client and names the company (three share one database).
 */

export type SnapJob = { id: string; label: string };

export type SnapContext =
  | {
      ok: true;
      /** Who is signed in: the sheet's lines and waiting photos are this person's, and a different
       *  person (or company) on the same device starts from an empty sheet. */
      userId: string;
      orgId: string;
      /** Office (owner, admin, office) or crew. The crew's sheet is Take Photo and a note. */
      staff: boolean;
      /** The job on the caller's open punch, pre-picked for a tech's photo. */
      punchJobId: string | null;
      /** For a tech: the jobs a photo can go on, labels only. Empty for the office (their cards
       *  carry their own jobs). */
      jobs: SnapJob[];
      /** Said when the jobs couldn't be read: the sheet says so, never an empty "no jobs". */
      jobsError?: string;
      /** The Shop Stock switch (0352), for the office's cards. */
      shopStock: boolean;
    }
  | { ok: false; error: string };

/** A job's label columns and nothing that costs money. */
const LABEL_COLUMNS = "id, job_number, name, address, status, created_at, customers(name)";

export async function snapContext(): Promise<SnapContext> {
  const ctx = await requireMember();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Not signed in." };
  const { supabase, userId, orgId, staff } = ctx;
  const [orgR, punchR] = await Promise.all([
    supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    supabase.from("time_entries").select("job_id").eq("org_id", orgId).eq("profile_id", userId).eq("status", "open").limit(1).maybeSingle(),
  ]);
  const settings = getOrgSettings((orgR.data as { settings?: unknown } | null)?.settings);
  const punchJobId = ((punchR.data as { job_id?: string | null } | null)?.job_id ?? null) || null;
  const shopStock = featureOn(settings.features, "shop_stock");
  if (staff) return { ok: true, userId, orgId, staff: true, punchJobId, jobs: [], shopStock };

  // THE CREW'S JOBS, LABELS ONLY: the jobs still going, newest first, his punch's job on top.
  const { data, error } = await supabase
    .from("jobs")
    .select(LABEL_COLUMNS)
    .eq("org_id", orgId)
    .in("status", ACTIVE_JOB_STATUSES)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error)
    return {
      ok: true,
      userId,
      orgId,
      staff: false,
      punchJobId,
      jobs: [],
      jobsError: "Couldn't load the jobs just now. Check your signal and open Snap Or Note again.",
      shopStock,
    };
  const rows = (data ?? []) as ChoiceJob[];
  const going = (j: ChoiceJob) => (j.id === punchJobId ? 0 : j.status === "in_progress" ? 1 : 2);
  const ordered = rows.map((j, n) => ({ j, n })).sort((a, b) => going(a.j) - going(b.j) || a.n - b.n);
  return {
    ok: true,
    userId,
    orgId,
    staff: false,
    punchJobId,
    jobs: ordered.map(({ j }) => ({ id: String(j.id), label: whichJobLabel(j, settings.timeclock_job_codes) })),
    shopStock,
  };
}

export type SnapRows =
  | {
      ok: true;
      items: PaperRowItem[];
      jobs: { id: string; job_number: string; name: string; status?: string | null }[];
      matches: Record<string, NumberMatch[]>;
      shopStock: boolean;
      /** The jobs couldn't be read: the cards still show, and this says why no job is listed. */
      jobsError?: string;
    }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE CARDS FOR THE PAPERS THE SHEET TOOK, still waiting (a filed one leaves the sheet: its Undo is
 * in the list's done trail). The same reading Organize's page makes, for these rows only.
 */
export async function snapPaperRows(ids: string[]): Promise<SnapRows> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is the office's." };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const orgId = ctx.orgId;
  const supabase = ctx.supabase;
  const want = [...new Set((ids ?? []).map(String).filter((id) => UUID.test(id)))].slice(0, 50);
  if (!want.length) return { ok: true, items: [], jobs: [], matches: {}, shopStock: true };

  const [itemsR, jobsR, orgR, books, markCtx] = await Promise.all([
    supabase.from("organized_items").select("*, jobs(job_number, name)").eq("org_id", orgId).eq("status", "needs_review").in("id", want),
    supabase
      .from("jobs")
      .select("id, job_number, name, status")
      .eq("org_id", orgId)
      .in("status", PAPER_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(OPEN_JOBS_FOR_PAPER),
    supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    loadBooks(supabase, orgId),
    loadMarkContext(supabase, orgId),
  ]);
  if (itemsR.error) return { ok: false, error: `Couldn't read your papers just now. ${dbError(itemsR.error)}` };
  const rows = (itemsR.data ?? []) as any[];
  const [urls, listViews, bankCards] = await Promise.all([
    signDocumentUrls(supabase, rows.map((i) => i.file_url)),
    openListViews(supabase, orgId, rows),
    bankViews(supabase, orgId, rows),
  ]);
  // A bank download's own lines never go to the browser: its card is `bank` (bankLinesStayHere).
  const order = new Map(want.map((id, n) => [id, n] as const));
  const items: PaperRowItem[] = rematchTray(rows, markCtx)
    .map((i) => ({
      ...bankLinesStayHere(i, bankCards[i.id]),
      signedUrl: (i.file_url && urls.get(i.file_url)) || null,
      open_list: listViews[i.id] ?? null,
      bank: bankCards[i.id] ?? null,
    }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return {
    ok: true,
    items,
    jobs: (jobsR.data ?? []) as { id: string; job_number: string; name: string; status?: string | null }[],
    matches: Object.fromEntries(items.map((i) => [i.id, matchesOnBooks(i, books)])),
    shopStock: featureOn(getOrgSettings((orgR.data as { settings?: unknown } | null)?.settings).features, "shop_stock"),
    ...(jobsR.error ? { jobsError: "Couldn't load your jobs just now, so no job is listed on these cards. Close and open Snap Or Note to try again." } : {}),
  };
}

/** A pasted invoice's totals block. A note that names an invoice number has none. */
const TOTALS_BLOCK = /\b(?:TOTAL\s+DUE|MERCHANDISE|INVOICE\s+TOTAL)\b/i;

type PaperReading =
  /** Something in it reads: the importer takes it. */
  | { kind: "paper" }
  /** A plain note (it may name an invoice number: "ask CED about invoice no. 8802110"). */
  | { kind: "note" }
  /** It looked like a pasted supplier paper (a totals block, a statement's heading) and nothing in
   *  it would read: kept as a note, with why, so the words are never handed back to fail again. */
  | { kind: "unread"; why: string };

/**
 * DOES THIS TEXT READ AS A SUPPLIER'S PAPER? Only when the importer would take something from it:
 * at least one document the parser the importer runs actually READ (parseCedDocuments: an invoice,
 * a credit memo, a service charge), or a pasted open list or statement whose header names a paper
 * number and money (the importer's own strict reading). A note that merely mentions an invoice
 * number is a note: the parser anchors on "…invoice no. 8802110" and refuses it for having no
 * totals block, and that refusal must never turn a note into a failed import.
 */
function readPastedText(text: string): PaperReading {
  const docs = parseCedDocuments(text);
  if (docs.some((r) => r.ok)) return { kind: "paper" };
  const list = openListFromText(text, { name: "Pasted text", from: "paste", listDate: null, listDateFrom: "today", parseCsv: parseCSV, strict: true });
  if (list?.list) return { kind: "paper" };
  // A PASTED PAPER THAT WON'T READ (a statement, an invoice whose totals don't add up) is still said:
  // the parser's own refusals, and the words kept as a note rather than lost or bounced.
  const refused = docs.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
  const statement = refused.some((r) => r.invoiceNumber === null);
  if (refused.length && (statement || TOTALS_BLOCK.test(text))) return { kind: "unread", why: refused.map((r) => r.error).join(" ") };
  return { kind: "note" };
}

export type PastedTextRoute =
  /** Save it as a note. `unread` says why a pasted supplier paper in it didn't import. */
  | { kind: "note"; unread?: string }
  | { kind: "imported"; ok: boolean; line: string };

/**
 * A NOTE THAT IS REALLY A SUPPLIER'S PAPER (W1-30: Bills' Paste Text Instead folds into the note
 * box). Text that reads as supplier invoices, a statement or an open list goes through the same
 * importer with every one of its rules (checked against its own arithmetic, a re-import changes
 * nothing, a job a person set is never touched), and the line says what came in. Anything else is
 * a note: the caller saves it (saveVoiceNote). The office's only: a supplier's papers carry prices.
 */
export async function routePastedText(text: string): Promise<PastedTextRoute> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { kind: "note" };
  const clean = String(text ?? "").trim();
  if (!clean) return { kind: "note" };
  const reading = readPastedText(clean);
  if (reading.kind === "unread") return { kind: "note", unread: reading.why };
  if (reading.kind === "note") return { kind: "note" };
  const res = await importCedInvoices({ text: clean });
  // Only text the importer reads gets here (readPastedText runs its own parser and its strict list
  // reading first), so a refusal now is the books that couldn't be checked, two imports at once, or
  // a list already in: worth saying, and the words go back in the box for another Save.
  if (!res.ok) return { kind: "imported", ok: false, line: `Not imported: ${res.error ?? "nothing in it could be read."}` };
  const n = res.landed.length + res.updated.length + res.unchanged.length;
  return {
    kind: "imported",
    ok: true,
    line: n
      ? `Imported ${n} supplier ${n === 1 ? "invoice" : "invoices"} from the pasted text: ${res.message ?? "they are on the supplier documents list."}`
      : `From the pasted text: ${res.message ?? "nothing new came in."}`,
  };
}
