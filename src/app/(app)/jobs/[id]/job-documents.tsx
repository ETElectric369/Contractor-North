"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Trash2, Loader2, FileText, DollarSign, Pencil, Globe, Receipt } from "lucide-react";
import { categoryIsShowable } from "@/lib/portal/doc-kinds";
import { Fold } from "@/components/why-fold";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { MediaLightbox } from "@/components/media-lightbox";
import { prettyBytes, readReceiptDocument, type ReceiptTone } from "@/lib/receipt-capture";
import { isCostableCategory } from "@/lib/job-photos";
import { deleteDocument, linkReceiptToBill, updateDocument } from "../actions";

/** A Receipt or a Bill: what Record As Cost reads into a job cost (lib/job-photos, the same rule
 *  that decides which papers can be "Not On A Bill Yet"). */
const COSTABLE = isCostableCategory;

/** The pencil's choices: what a filed paper can be re-filed as. */
const CATEGORIES = ["Receipt", "Bill", "Invoice", "Photo", "Plan", "Permit", "Other"];

interface Doc {
  id: string;
  name: string;
  category: string | null;
  file_url: string | null; // null = Organize note filed to the job (no file)
  size_bytes: number | null;
  created_at: string;
  signedUrl: string | null;
}

const isImage = (d: Doc) => /\.(jpe?g|png|webp|gif|heic)($|\?)/i.test(d.signedUrl ?? d.name);
const isPdf = (d: Doc) => /\.pdf($|\?)/i.test(d.signedUrl ?? d.name);

/** What the reader said about one document, under its row. `done` = a bill exists for it (created
 *  now, or found already), so the Record as Cost verb goes away — a warning tone can still ride a
 *  done note (the reader's lines didn't add up; the bill is in, the notes carry the warning). */
type BillNote = {
  text: string;
  done: boolean;
  tone: ReceiptTone;
  /** A bill already carries this paper's number, so nothing was written (audit v994): the row
   *  offers Different Purchase: Record It Anyway, because only a person can say it isn't the same. */
  different?: boolean;
  /** …and, when that bill is on this job (d1ff7c5a), Same Purchase: It's That Bill, which ties the
   *  paper to it (linkReceiptToBill) instead of reading it again or billing it twice. */
  sameBillId?: string;
  sameOnThisJob?: boolean;
};

/** One of the job's live bills, said the way the page says them ("the CED bill #8802-1106969"). */
export type BillChoice = { id: string; label: string };

const NOTE_COLOR: Record<ReceiptTone, string> = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  fail: "text-red-600",
};

/**
 * THE JOB'S FILED LIST (plans, permits, every receipt). No uploader of its own (W1-23: one way to
 * add a cost): papers come in at the top of the Costs tab (Snap The Bill, or its ⋯ Upload), which
 * run THE receipt pipeline (lib/receipt-capture) and file every paper here, read or not. This card
 * says what each paper became: which bill it made, or that it is on no bill yet, with Record As Cost
 * as the retry, the pencil (re-file it as a Plan, a Permit, a Photo) and the trash.
 *
 * PLANS LIVE ON THE CUSTOMER PAGE TAB (2026-09-25). A line always links to that tab's Add Plans Or
 * Drawings (?plans=add) while the office has it (the Customer Portal switch on); with the portal off,
 * the empty line says a plan goes in through ⋯ → File A Paper (Not A Cost), which files it as a Plan
 * and never reads it as a receipt. Office only: the Customer Page tab is not a tech's, so a tech is
 * never pointed at it.
 *
 * RECEIPTS & PAPERS, FOLDED (Erik, 2026-09-27: bills and job photos kept separate). The list leads
 * with the job's papers; what the Photos tab holds (`photoTabIds`) folds under them, still here for
 * the pencil (a receipt snapped as a Photo is re-filed from this list) and the trash. A paper that
 * made a bill on this job says which (`billOf`); a receipt or bill on no bill at all (`looseIds`)
 * says so beside its Record As Cost, and the fold's line counts those and starts open while there
 * are any, so an unrecorded receipt is never folded out of sight.
 *
 * A LOOSE RECEIPT CAN SAY "IT IS THAT BILL" (d1ff7c5a). A bill typed by hand with the receipt
 * uploaded separately, or a paper the reader answered "already on the books" for, left the receipt
 * "Not on a bill yet" beside the very bill it made, and the only doors were another paid read or a
 * second bill. Every such row now carries Already On A Bill: <the job's live bills> + Tie It, and
 * the reader's "already on the books" answer carries Same Purchase: It's That Bill when that bill is
 * on this job. Both write the one missing tie (linkReceiptToBill), and a refusal is said on the row.
 */
export function JobDocuments({
  // Unused since the uploader went to the top of the tab (W1-23); kept so the page's mount holds.
  orgId: _orgId,
  jobId,
  docs,
  portalPapers = null,
  plansDoor = false,
  nortOn = true,
  photoTabIds = null,
  billOf = null,
  looseIds = null,
  tieNote = null,
  bills = null,
}: {
  orgId: string;
  jobId: string;
  docs: Doc[];
  /** 0326: which papers are on the customer's page (null before 0326, or for a tech: no control).
   *  A plan, permit or other job paper gets Show On Portal, which opens the Customer Page tab's
   *  sheet for it; a receipt, bill or invoice never does. */
  portalPapers?: Record<string, "shown" | "replaced"> | null;
  /** The viewer is office staff and the Customer Portal is on, so the Customer Page tab (and its
   *  plans door) exists for them. */
  plansDoor?: boolean;
  /** The Nort switch (0352): the receipt reader still reads; its tooltip just doesn't name Nort. */
  nortOn?: boolean;
  /** The documents the Photos tab holds (lib/job-photos sortJobPapers): listed last, folded. */
  photoTabIds?: readonly string[] | null;
  /** Document id → the bill on this job it made, in words ("the CED bill #8802-1106969"). */
  billOf?: Record<string, string> | null;
  /** Receipts and bills tied to no bill at all (never an Invoice: nothing reads one into a bill, so
   *  its flag would have no Record As Cost). null = not known (the ties weren't read): nothing is
   *  claimed, and Record as Cost stays on every receipt, as before. */
  looseIds?: readonly string[] | null;
  /** Said when the ties couldn't be read (the bills then draw no Receipt door): the fold starts open
   *  so it is seen. */
  tieNote?: string | null;
  /** The job's live bills, for a loose receipt's Already On A Bill → Tie It (the office only; a
   *  tech is handed none, and no loose rows either). Empty or null: no tie door is drawn. */
  bills?: BillChoice[] | null;
}) {
  const router = useRouter();
  const onPhotoTab = new Set(photoTabIds ?? []);
  const papers = docs.filter((d) => !onPhotoTab.has(d.id));
  const tabPictures = docs.filter((d) => onPhotoTab.has(d.id));
  const loose = looseIds ? new Set(looseIds) : null;
  const looseCount = loose ? papers.filter((d) => loose.has(d.id)).length : 0;
  // Open while a paper is on no bill, as the page loaded: a fold that shut itself the moment the last
  // one was recorded would hide the line saying it was. Open too when the ties couldn't be read: the
  // bills above draw no Receipt door then, and the sentence saying why is inside this fold.
  const [openAtStart] = useState(() => looseCount > 0 || !!tieNote);
  const [pending, start] = useTransition();
  const [viewing, setViewing] = useState<Doc | null>(null);
  // Inline rename / re-categorize editor — null when closed.
  const [editing, setEditing] = useState<Doc | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("Receipt");
  const [editErr, setEditErr] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Per-document "recorded as a job cost" status, keyed by document id.
  const [billing, setBilling] = useState<string | null>(null);
  const [billMsg, setBillMsg] = useState<Record<string, BillNote>>({});
  // Which bill a loose receipt's Already On A Bill picker points at, per document (the first
  // live bill until a person picks another).
  const [tiePick, setTiePick] = useState<Record<string, string>>({});
  const billChoices = bills ?? [];

  const note = (docId: string, n: BillNote | null) =>
    setBillMsg((m) => {
      const next = { ...m };
      if (n) next[docId] = n;
      else delete next[docId];
      return next;
    });

  // Convert an already-filed receipt/bill into a job cost on demand — the retry for anything
  // the read at Snap The Bill or Upload refused.
  async function recordCost(d: Doc, differentPurchase = false) {
    setBilling(d.id);
    note(d.id, null);
    try {
      const out = await readReceiptDocument(d.id, differentPurchase ? { differentPurchase: true } : undefined, nortOn);
      note(d.id, {
        text: out.sentence,
        done: out.kind !== "filed",
        tone: out.tone,
        different: out.kind === "already" && out.samePurchase === true,
        ...(out.kind === "already" && out.samePurchase && out.sameBillId ? { sameBillId: out.sameBillId, sameOnThisJob: out.sameOnThisJob === true } : {}),
      });
      if (out.kind === "billed") router.refresh();
    } finally {
      setBilling(null);
    }
  }

  // "It IS that bill": write the one missing tie (linkReceiptToBill, job containment checked
  // there), say the outcome on the row, and refresh so the row, the Costs chip and Needs You all
  // read the tie. A refusal stays on the row in words.
  async function tieToBill(d: Doc, billId: string) {
    setBilling(d.id);
    try {
      const res = await linkReceiptToBill(billId, d.id);
      if (!res.ok) {
        note(d.id, { text: res.error ?? "The tie didn't save. Try again.", done: false, tone: "fail" });
        return;
      }
      const label = billChoices.find((b) => b.id === billId)?.label;
      note(d.id, { text: `On ${label ?? "that bill"}.`, done: true, tone: "ok" });
      router.refresh();
    } finally {
      setBilling(null);
    }
  }

  function open(d: Doc) {
    if (d.signedUrl && (isImage(d) || isPdf(d))) setViewing(d);
    else if (d.signedUrl) window.open(d.signedUrl, "_blank");
  }

  function remove(d: Doc) {
    if (!confirm(`Delete "${d.name}"?`)) return;
    start(async () => {
      await deleteDocument(d.id, d.file_url, jobId);
      router.refresh();
    });
  }

  function openEdit(d: Doc) {
    setEditing(d);
    setEditName(d.name);
    setEditCategory(d.category ?? "Other");
    setEditErr(null);
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editName.trim()) {
      setEditErr("Name is required.");
      return;
    }
    setSavingEdit(true);
    setEditErr(null);
    const res = await updateDocument(
      editing.id,
      { name: editName, category: editCategory },
      jobId,
    );
    setSavingEdit(false);
    if (!res.ok) {
      setEditErr(res.error ?? "Couldn't save changes.");
      return;
    }
    setEditing(null);
    router.refresh();
  }

  const row = (d: Doc) => {
    const n = billMsg[d.id];
    // Record as Cost is for a receipt no bill holds: when the ties were read, one that made a bill
    // has nothing left to record (the reader would only answer "already recorded").
    const recordable = COSTABLE(d.category) && !n?.done && (!loose || loose.has(d.id));
    return (
      <li key={d.id} className="flex flex-col gap-1.5 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <button onClick={() => open(d)} className="shrink-0">
            {isImage(d) && d.signedUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.signedUrl} alt="" className="h-12 w-12 rounded-md object-cover" />
            ) : (
              <span className="flex h-12 w-12 items-center justify-center rounded-md bg-slate-100">
                <FileText className="h-5 w-5 text-slate-400" />
              </span>
            )}
          </button>
          <button onClick={() => open(d)} className="min-w-0 flex-1 text-left">
            <div className="truncate text-sm font-medium text-slate-900 hover:text-brand">{d.name}</div>
            <div className="text-xs text-slate-400">
              {formatDate(d.created_at)}
              {d.size_bytes ? ` · ${prettyBytes(d.size_bytes)}` : ""}
            </div>
            {billOf?.[d.id] && <div className="text-xs text-slate-500">On {billOf[d.id]}.</div>}
            {loose?.has(d.id) && !n?.done && <div className="text-xs font-medium text-amber-700">Not on a bill yet.</div>}
          </button>
          {recordable && (
            <button
              onClick={() => recordCost(d)}
              disabled={billing === d.id}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-brand/30 bg-brand/5 px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 disabled:opacity-50"
              title={`${nortOn ? "Nort reads" : "Reads"} the receipt and adds it to this job's costs`}
            >
              {billing === d.id ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <DollarSign className="h-4 w-4 shrink-0" />
              )}
              Record As Cost
            </button>
          )}
          {d.category && <Badge tone="blue">{d.category}</Badge>}
          <button
            onClick={() => openEdit(d)}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title="Rename or re-categorize"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={() => remove(d)}
            disabled={pending}
            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        {portalPapers && d.file_url && categoryIsShowable(d.category) && (
          <div className="pl-15">
            <Link
              href={`/jobs/${jobId}?tab=customer&paper=${d.id}`}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-semibold ${
                portalPapers[d.id] === "shown" ? "bg-emerald-50 text-emerald-800" : "text-brand hover:bg-brand/5"
              }`}
            >
              <Globe className="h-4 w-4" />
              {portalPapers[d.id] === "shown"
                ? "On The Portal"
                : portalPapers[d.id] === "replaced"
                  ? "Replaced By A Newer One On The Portal"
                  : "Show On Portal"}
            </Link>
          </div>
        )}
        {/* A receipt on no bill, with the job's bills to choose from: it may already BE one of them
            (typed by hand, the photo uploaded apart). Tie It writes the one missing link. */}
        {loose?.has(d.id) && !n?.done && billChoices.length > 0 && (
          <div className="pl-15 flex flex-wrap items-center gap-2">
            <label htmlFor={`tie-${d.id}`} className="text-xs font-medium text-slate-600">
              Already On A Bill:
            </label>
            <Select
              id={`tie-${d.id}`}
              className="h-11 w-auto max-w-full"
              value={tiePick[d.id] ?? billChoices[0].id}
              onChange={(e) => setTiePick((m) => ({ ...m, [d.id]: e.target.value }))}
              disabled={billing === d.id}
            >
              {billChoices.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={() => tieToBill(d, tiePick[d.id] ?? billChoices[0].id)}
              disabled={billing === d.id}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {billing === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Tie It
            </button>
          </div>
        )}
        {n && (
          <div className={`pl-15 text-xs ${NOTE_COLOR[n.tone]}`}>
            {n.text}
          </div>
        )}
        {n?.different && (
          <div className="pl-15 flex flex-wrap items-center gap-2">
            {/* The reader found this paper's number on a bill of THIS job: most often it is that
                bill's own receipt, so the first door ties it, never reads or bills it again. */}
            {n.sameOnThisJob && n.sameBillId && (
              <button
                type="button"
                onClick={() => tieToBill(d, n.sameBillId!)}
                disabled={billing === d.id}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-brand/30 bg-brand/5 px-3 text-xs font-medium text-brand hover:bg-brand/10 disabled:opacity-50"
              >
                {billing === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Same Purchase: It&apos;s That Bill
              </button>
            )}
            <button
              type="button"
              onClick={() => recordCost(d, true)}
              disabled={billing === d.id}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {billing === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Different Purchase: Record It Anyway
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <Fold
        open={openAtStart}
        summaryClassName="px-5 py-3"
        summary={
          <span className="flex flex-wrap items-center gap-x-2 text-sm">
            <span className="inline-flex items-center gap-2 font-semibold text-slate-900">
              <Receipt className="h-4 w-4 text-slate-400" /> Receipts &amp; Papers
            </span>
            {looseCount > 0 && (
              <span className="font-medium text-amber-700">
                · {looseCount} Not On A Bill Yet
              </span>
            )}
          </span>
        }
      >
        <div className="border-t border-slate-100 px-5 py-5">
          {/* A plan is no cost: its home is the Customer Page tab (the office, Customer Portal on). */}
          {plansDoor && (
            <p className="mb-3 rounded-lg bg-slate-50 px-3 py-1 text-sm text-slate-700">
              <Link
                href={`/jobs/${jobId}?tab=customer&plans=add`}
                className="inline-flex min-h-11 items-center font-semibold text-brand underline-offset-2 hover:underline"
              >
                Plan Or Drawing? Add It On The Customer Page
              </Link>
            </p>
          )}

          {tieNote && <p className="mb-2 text-sm text-slate-500">{tieNote}</p>}

          {papers.length === 0 ? (
            <p className="text-sm text-slate-400">
              No receipts yet. Use Snap The Bill above.
              {!plansDoor && " A plan, permit or other paper? Tap ⋯ and File A Paper (Not A Cost)."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{papers.map(row)}</ul>
          )}

          {/* What the Photos tab holds, folded last: still here for the pencil (a receipt snapped as a
              Photo is re-filed as a Receipt from this list) and the trash. */}
          {tabPictures.length > 0 && (
            <Fold
              className="mt-4"
              summary={<span className="text-sm font-medium text-slate-700">Photos And Plans On The Photos Tab</span>}
            >
              <p className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                They show on the Photos tab. One that is really a receipt: tap its pencil and file it as a Receipt.
                <Link
                  href={`/jobs/${jobId}?tab=photos`}
                  className="inline-flex min-h-11 items-center text-sm font-medium text-brand underline-offset-2 hover:underline"
                >
                  Open Photos
                </Link>
              </p>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{tabPictures.map(row)}</ul>
            </Fold>
          )}
        </div>
      </Fold>

      {viewing?.signedUrl && (
        <MediaLightbox url={viewing.signedUrl} name={viewing.name} onClose={() => setViewing(null)} />
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit document"
        size="sm"
        footer={
          <ModalActions
            onCancel={() => setEditing(null)}
            onSave={saveEdit}
            saving={savingEdit}
          />
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="doc-name">Name</Label>
            <Input
              id="doc-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Document name"
            />
          </div>
          <div>
            <Label htmlFor="doc-category">Category</Label>
            <Select
              id="doc-category"
              value={editCategory}
              onChange={(e) => setEditCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
          {editErr && <p className="text-sm text-red-600">{editErr}</p>}
        </div>
      </Modal>
    </>
  );
}
