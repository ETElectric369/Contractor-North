"use client";

import { COMPANY_FIELD } from "@/lib/vendor-words";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, BookOpen, Camera, Check, FileText, Link2, ListTodo, Loader2, Pencil, Receipt, RotateCcw, Sparkles, StickyNote, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { reconcileReceipt } from "@/lib/receipt-reconcile";
import { callOrLost } from "@/lib/lost-signal";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";
import {
  amountOf,
  billDeletedSaid,
  cardSentence,
  describePaper,
  fileRefusal,
  firstAnswer,
  guessOf,
  isReturnWithoutLines,
  paperKindWords,
  paperSays,
  paperTypeLabel,
  paperTypeOfItem,
  parseDestination,
  proposalOf,
  readinessOf,
  RETURN_NEEDS_LINES,
  SHELF_TRAY_NEEDS_LINES,
  shelfRowsOf,
  type NumberMatch,
  type PaperItem,
  type Readiness,
} from "@/lib/paperwork";
import { ShelfTicketSheet, type ShelfCountLine } from "@/components/shelf-count";
import { OpenListCard } from "@/components/open-list-card";
import type { OpenListView } from "@/lib/supplier-open-list";
import { BankCard } from "@/components/bank-card";
import type { BankView } from "@/lib/bank-download";
import { SectionActionsMenu, ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { BucketGrid, GuessMark, JobPicker, type PickJob } from "@/components/paper-answers";
import {
  archiveItem,
  deleteOrganizedItem,
  fileItem,
  keepAsNote,
  makeTaskFromPaper,
  readAsCost,
  readPaperworkItem,
  tiePaperwork,
  undoPaperwork,
} from "@/app/(app)/organize/actions";
import { addSupplierDocuments, keepPaperwork, updatePaperwork } from "@/app/(app)/organize/paperwork-actions";

/**
 * ONE CARD FOR ONE PIECE OF PAPER, ON EVERY PAGE THAT HOLDS PAPER (0295; W1-31).
 *
 * Snap Or Note's sheet, Organize and Needs You on /bills render THIS, so a receipt is filed the
 * same way whichever door it came in by. It is built on the Supplier Bills card grammar, so a tray
 * paper and a supplier's paper look and answer the same way:
 *
 *   Home Depot · $84.12 · It Says 13897 HONEYSUCKLE
 *   #8802-1108330 · Sep 24, 2026 · Receipt (Paid)
 *   [Open Paper]
 *   [Put It On J-011] [Another Job] [Shop Stock] [Business Cost]
 *
 * Every answer is one tap that files; Undo stays in the list's done trail and the toast. Nothing is
 * preselected and nothing files by itself: the FIRST answer is what the paper itself picks (a
 * printed mark matched exactly, with why), else a model's or the reader's guess, marked Guess on the
 * button with whose guess it is under it. Each answer asks the same fileRefusal the server asks
 * before it writes a cent, so a door that looks open is open and a shut one says why.
 *
 * A number already on the books puts an amber box above the answers with Same Purchase: Tie Them;
 * with it showing, every other answer records a different purchase (the old Different Purchase: File
 * It Anyway, folded into the answers: pressing one without the flag would be refused).
 *
 * The rarer doors (Fix Details, Read Again, Keep It In Files, Set Aside, Delete) live on the card's
 * ⋯. A paper the reader couldn't finish shows only the one door it needs (Read Now, or Fix Details:
 * Put The Total In); its answers appear once it has a total. A picture is asked what it is first
 * (Erik, 2026-09-24): Job Photo, Bill Or Receipt, Something Else.
 */

export type PaperRowItem = PaperItem & {
  title: string;
  created_at: string;
  signedUrl: string | null;
  file_url?: string | null;
  /** A supplier's open list: what it changes, worked out on the server as the page loads. */
  open_list?: OpenListView | null;
  /** A bank download: how it sorts against the books, worked out on the server as the page loads. */
  bank?: BankView | null;
};

/** `status` complete: a finished job, offered under Completed Jobs (PR1), never pre-picked. */
type JobOption = { id: string; job_number: string; name: string; status?: string | null };
type Filed = { id: string; sentence: string };

const TYPE_CHOICES: { value: string; label: string }[] = [
  { value: "receipt", label: "Receipt (Already Paid)" },
  { value: "bill", label: "Bill (Still Owed)" },
  { value: "not_a_cost", label: "Not A Cost" },
  { value: "statement", label: "Statement" },
  { value: "credit_memo", label: "Credit Memo" },
  { value: "purchase_order", label: "Purchase Order" },
  { value: "other", label: "Other Paper" },
];

const PAID_CHOICES = [
  { value: "paid_at_purchase", label: "Paid At The Counter" },
  { value: "on_account", label: "On Account (Still Owed)" },
  { value: "unknown", label: "Not Sure" },
];

/** The ⋯ menu's row: the section menu's own row, at 44px. Delete is red and last. */
const MENU_ROW = `${ACTIONS_ROW_CLS} min-h-11`;
const MENU_DANGER_ROW =
  "relative z-10 flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50/60 disabled:opacity-50";
/** The section menu with no tree of its own: every row is the card's (children). */
const CARD_MENU = { center: { label: "Actions", icon: "more" }, nodes: [] };

/** A chip a person taps to take a suggestion (a Reminder, Keep As Note). 44px. */
const CHIP =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-slate-300 bg-white px-3 text-left text-sm text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50";

function matchKey(m: NumberMatch): string {
  if (m.kind === "bill") return `bill:${m.billId}`;
  if (m.kind === "maybe_bill") return `maybe:${m.billId}`;
  if (m.kind === "supplier_invoice") return `si:${m.supplierInvoiceId}`;
  return `paper:${m.itemId}`;
}

/** A job as the card's buttons say it: its number, or its name when it has none. */
export function pickJobOf(j: JobOption): PickJob {
  const num = String(j.job_number ?? "").trim();
  const name = String(j.name ?? "").trim();
  return { id: j.id, label: num || name || "That Job", name, status: j.status ?? null };
}

/**
 * WITH A BILL ON THE BOOKS SHOWING, EVERY ANSWER IS A DIFFERENT PURCHASE (W1-31). The card shows a
 * bill already on the books with Same Purchase: Tie Them and the line "Any other button below
 * records it as a different purchase.", so every answer then carries the flag. Missing it, the
 * server would refuse the answer the card just offered.
 *
 * A MAYBE (the same long number under another spelling) never sends it: the server takes a maybe
 * as a warning, not a refusal, and only without the flag does it still link a supplier document
 * the card promised to link and write which other-spelling bill the person saw.
 */
export function differentPurchaseOf(state: Readiness["state"], matches: readonly NumberMatch[]): boolean {
  return state === "ready" && matches.some((m) => m.kind === "bill");
}

/** The one line under the Same Purchase box: what every other answer does, per what it shows. */
export function samePurchaseLine(state: Readiness["state"], onBooks: number): string {
  if (state !== "ready") return "Tying files this paper against it and adds nothing new.";
  return onBooks > 0
    ? "Any other button below records it as a different purchase."
    : "If it isn't the same purchase, any other button below files it, and its bill notes the other spelling.";
}

/** The ⋯ rows, per state, minus any door the card already shows (one door, one home). */
export type PaperMenuRow = "Fix Details" | "Read Again" | "Keep It In Files" | "Set Aside" | "Delete";
export function paperMenuRows(state: Readiness["state"], hasFile: boolean, onCard: readonly PaperMenuRow[] = []): PaperMenuRow[] {
  const rows: PaperMenuRow[] = [];
  // Supplier documents are recognised from the PDF itself; a too-big or totalless paper already
  // shows Fix Details as its one needed door.
  if (state !== "supplier_documents" && state !== "too_big" && state !== "needs_total") rows.push("Fix Details");
  // Never on supplier documents (the reader would overwrite what the PDF's own text said), nor on a
  // paper whose one door is already Read Now.
  if (hasFile && (state === "ready" || state === "needs_total" || state === "keep" || state === "later" || state === "picture")) rows.push("Read Again");
  if (state === "later" || state === "supplier_documents" || state === "not_read" || state === "too_big" || state === "picture") rows.push("Keep It In Files");
  if (state !== "later" && state !== "supplier_documents") rows.push("Set Aside");
  // Only paper this update can't file (a statement, a credit memo, a PO); last, and asked first.
  if (state === "later") rows.push("Delete");
  return rows.filter((r) => !onCard.includes(r));
}

function Thumb({ item }: { item: PaperRowItem }) {
  if (!item.signedUrl)
    return (
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-slate-100">
        <FileText className="h-6 w-6 text-slate-400" />
      </span>
    );
  const pdf = /\.pdf($|\?)/i.test(item.signedUrl) || /\.pdf$/i.test(String(item.file_url ?? ""));
  return (
    <a href={item.signedUrl} target="_blank" rel="noreferrer" className="shrink-0" title="Open The Paper">
      {pdf ? (
        <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-slate-100">
          <FileText className="h-6 w-6 text-slate-500" />
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.signedUrl} alt="" className="h-14 w-14 rounded-lg object-cover" />
      )}
    </a>
  );
}

/** Fix Details: a person's own numbers beat the reader's. */
function FixDetails({ item, onClose, onSaved }: { item: PaperRowItem; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<string>(paperTypeOfItem(item) ?? "receipt");
  const [vendor, setVendor] = useState(item.vendor ?? "");
  const [amount, setAmount] = useState(item.amount === null || item.amount === undefined ? "" : String(item.amount));
  const [date, setDate] = useState(item.item_date ?? "");
  const [number, setNumber] = useState(item.doc_number ?? "");
  const [paid, setPaid] = useState(item.payment ?? "unknown");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server asked whether a paper read as a credit memo really is a charge (DB4).
  const [askCharge, setAskCharge] = useState(false);
  const isCost = type === "receipt" || type === "bill";

  async function save(creditIsACharge = false) {
    setSaving(true);
    setError(null);
    setAskCharge(false);
    const res = await updatePaperwork(
      item.id,
      {
        doc_type: type,
        vendor: vendor.trim() || null,
        amount: amount.trim() === "" ? null : Number(amount.replace(/[$,\s]/g, "")),
        item_date: date || null,
        doc_number: number.trim() || null,
        payment: isCost ? paid : null,
      },
      { creditIsACharge },
    );
    setSaving(false);
    if (!res.ok) {
      setAskCharge(res.askCharge === true);
      return setError(res.error ?? "Couldn't save.");
    }
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title="Fix Details" footer={<ModalActions onCancel={onClose} onSave={() => save()} saving={saving} />}>
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
            {askCharge && (
              <div className="mt-2">
                <Button variant="outline" onClick={() => save(true)} disabled={saving}>
                  It Is A Charge
                </Button>
              </div>
            )}
          </div>
        )}
        <div>
          <Label htmlFor={`fd-type-${item.id}`}>What Kind Of Paper</Label>
          <Select id={`fd-type-${item.id}`} value={type} onChange={(e) => setType(e.target.value)} className="h-11">
            {TYPE_CHOICES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            {/* One word for one box (W1): this said "Supplier Or Store" while the drop box
                above it said "Vendor" and the bill door said "Supplier". */}
            <Label htmlFor={`fd-vendor-${item.id}`}>{COMPANY_FIELD.paperwork_line.label}</Label>
            <Input id={`fd-vendor-${item.id}`} value={vendor} onChange={(e) => setVendor(e.target.value)} className="h-11" />
          </div>
          <div>
            <Label htmlFor={`fd-amount-${item.id}`}>Total</Label>
            <Input
              id={`fd-amount-${item.id}`}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="h-11"
            />
          </div>
          <div>
            <Label htmlFor={`fd-date-${item.id}`}>Date On It</Label>
            <Input id={`fd-date-${item.id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11" />
          </div>
          <div>
            <Label htmlFor={`fd-number-${item.id}`}>Number On It</Label>
            <Input id={`fd-number-${item.id}`} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Ticket or invoice #" className="h-11" />
          </div>
          {isCost && (
            <div className="sm:col-span-2">
              <Label htmlFor={`fd-paid-${item.id}`}>Paid?</Label>
              <Select id={`fd-paid-${item.id}`} value={paid} onChange={(e) => setPaid(e.target.value)} className="h-11">
                {PAID_CHOICES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </Select>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function PaperworkRow({
  item,
  jobs,
  matches,
  onFiled,
  onChanged,
  shopStock = true,
  initialAnswer = null,
}: {
  item: PaperRowItem;
  jobs: JobOption[];
  matches: NumberMatch[];
  onFiled: (filed: Filed) => void;
  /** A picture's answer to What Is This? when the card is drawn already answered (tests; a holder
   *  that remembers it). Absent: the card asks. */
  initialAnswer?: "photo" | "else" | null;
  /** Anything on the card changed on the server (a read, a set aside, a fix): a holder that isn't a
   *  page (Snap Or Note's sheet) reads its rows again. Pages refresh themselves. */
  onChanged?: () => void;
  /** SHOP STOCK OFF (the switch board, 0352): the shelf isn't offered, and a paper marked STOCK picks
   *  nothing; its words still show ("It Says STOCK") and a person picks a job or a bucket.
   *  Absent = on. */
  shopStock?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [said, setSaid] = useState<{ text: string; tone: "error" | "info" } | null>(null);
  // A PICTURE is asked what it is first (Erik, 2026-09-24). Job Photo and Something Else are
  // answered here and change nothing until an answer files it; Bill Or Receipt is answered on the
  // server (readAsCost), because it changes what the row IS.
  const [answer, setAnswer] = useState<"photo" | "else" | null>(initialAnswer);
  /** Which picker is open under the answers: Another Job's, or Business Cost's buckets. */
  const [picking, setPicking] = useState<"job" | "bucket" | null>(null);
  /** What a person has picked in Another Job's list, before they press. Nothing preselected. */
  const [pickedJob, setPickedJob] = useState("");
  /** Open Paper: the file and its lines, inline. */
  const [paperOpen, setPaperOpen] = useState(false);
  /** The Shop Stock sheet: every line counted into stock, or Not Stock, before it files. */
  const [shelfSheet, setShelfSheet] = useState<{ differentPurchase: boolean } | null>(null);

  const r = readinessOf(item);
  const p = proposalOf(item);
  const type = paperTypeOfItem(item);
  const isCost = type === "receipt" || type === "bill";
  const jobIds = jobs.map((j) => j.id);
  const pickJobs = jobs.map(pickJobOf);
  const jobById = new Map(pickJobs.map((j) => [j.id, j] as const));
  const labelOf = (jobId: string) => {
    const j = jobById.get(jobId);
    return j ? `${j.label}${j.name && j.name !== j.label ? ` ${j.name}` : ""}` : "that job";
  };

  // Only a BILL is "already on the books". A supplier document no bill covers is linked by filing.
  const onBooks = matches.filter((m): m is Extract<NumberMatch, { kind: "bill" }> => m.kind === "bill");
  const toLink = matches.filter((m): m is Extract<NumberMatch, { kind: "supplier_invoice" }> => m.kind === "supplier_invoice");
  const papers = matches.filter((m) => m.kind === "paper");
  // THE SAME LONG NUMBER UNDER ANOTHER SPELLING (Erik, audit v994 DB5): a warning with a Tie.
  const maybes = matches.filter((m): m is Extract<NumberMatch, { kind: "maybe_bill" }> => m.kind === "maybe_bill");
  const samePurchase = onBooks.length ? onBooks : maybes;
  // WITH A BILL ON THE BOOKS SHOWING, EVERY ANSWER IS A DIFFERENT PURCHASE: the card says so above
  // the answers, and each one carries the flag (without it the server refuses and names the Tie).
  // A maybe alone sends no flag, so a supplier document on the card is still linked by filing.
  const differentPurchase = differentPurchaseOf(r.state, matches);

  // THE LINES, AND WHETHER THEY ADD UP TO THE TOTAL READ (audit v994, MR6). Shown, never a gate:
  // the bill a filing writes carries the same sentence in its notes.
  const rowLines = isCost ? shelfRowsOf(item) : [];
  const rowTotal = amountOf(item);
  const addsUp = rowTotal !== null && rowLines.length ? reconcileReceipt(rowTotal, rowLines) : null;
  const mismatch = !!addsUp?.mismatch && (r.state === "ready" || r.state === "needs_total");

  type Mode = "cost" | "keep" | "ask" | "photo" | "none";
  const mode: Mode =
    r.state === "ready"
      ? "cost"
      : r.state === "keep"
        ? "keep"
        : r.state === "picture"
          ? answer === "photo"
            ? "photo"
            : answer === "else"
              ? "keep"
              : "ask"
          : "none";

  // THE FIRST ANSWER: what the paper picks, else a guess (marked), else none and the card asks.
  const first = firstAnswer(item, jobIds, { shopStock });
  const firstJob = first.dest.startsWith("job:") ? (jobById.get(first.dest.slice(4)) ?? null) : null;
  // A model's job guess that disagrees with the paper's own pick is not a button; it is the top of
  // Another Job's Closest, beside the paper's job, so nothing it said is lost.
  const guess = guessOf(item, jobIds);
  const guessJob = guess?.startsWith("job:") ? (jobById.get(guess.slice(4)) ?? null) : null;
  const closestJobs = [firstJob, guessJob].filter((j): j is PickJob => !!j);
  // A picture's job is only ever a job (the paper's, or a job guess); a cost or stock guess is not a photo's.
  const firstFor = mode === "cost" ? first.dest : firstJob ? first.dest : "";

  // EACH ANSWER ASKS THE GATE THE SERVER ASKS (fileRefusal), and says why when it is shut.
  const jobRefusal = fileRefusal(item, mode === "photo" ? { type: "photo", jobId: firstJob?.id ?? "a-job" } : { type: "job", jobId: firstJob?.id ?? "a-job" });
  const costRefusal = mode === "cost" ? fileRefusal(item, { type: "overhead", category: BUSINESS_COST_BUCKETS[0] }) : null;
  const stockRefusal = mode === "cost" && shopStock ? fileRefusal(item, { type: "stock" }) : null;
  const keepRefusal = mode === "keep" ? fileRefusal(item, { type: "keep" }) : null;
  const working = pending || busy !== null;

  // THE DOOR A REFUSAL NAMES (DB4): a return with no lines, or a ticket with no lines for stock, is
  // refused with "Press Read Again"; that door sits right under the sentence, not only on the ⋯.
  const readAgainNamed =
    mode === "cost" && !!item.file_url && (isReturnWithoutLines(item) || jobRefusal === RETURN_NEEDS_LINES || stockRefusal === SHELF_TRAY_NEEDS_LINES);

  /**
   * Every write on the card. `filedSentence`: it moved the paper out of the tray, so the list's done
   * trail and the toast carry the sentence and its Undo. `gone`: it can't be undone (Delete), so the
   * toast says what happened, with no Undo.
   */
  function run(key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, filedSentence?: string, gone?: string) {
    setSaid(null);
    setBusy(key);
    start(async () => {
      // A dropped signal rejects (audit v994 SI2): caught here, the card stays and says so, instead
      // of the page being swapped for the error card.
      const res = await callOrLost(fn);
      setBusy(null);
      if (!res.ok) {
        setSaid({ text: cardSentence(res.error ?? "That didn't work. Nothing changed."), tone: "error" });
        if ("lost" in res) router.refresh();
        onChanged?.();
        return;
      }
      setPicking(null);
      if (gone) {
        toast(cardSentence(res.message ?? gone), "success");
      } else if (filedSentence) {
        const sentence = cardSentence(res.message ?? filedSentence);
        onFiled({ id: item.id, sentence: `${describePaper(item)}: ${sentence}` });
        toast(sentence, "success", {
          label: "Undo",
          onClick: () => {
            void undoPaperwork(item.id).then((u) => {
              toast(u.ok ? u.message ?? "Undone." : u.error ?? "Couldn't undo.", u.ok ? "success" : "error");
              router.refresh();
              onChanged?.();
            });
          },
        });
      } else if (res.message) {
        setSaid({ text: cardSentence(res.message), tone: "info" });
      }
      router.refresh();
      onChanged?.();
    });
  }

  /** ONE TAP FILES: a job, a bucket, a job photo, stock (its count sheet first), or kept in files. */
  function fileTo(value: string) {
    const d = parseDestination(value);
    if (!d) return;
    if (d.type === "stock") return setShelfSheet({ differentPurchase });
    if (d.type === "keep") return run("keep", () => keepPaperwork(item.id), "Kept in files.");
    if (d.type === "photo")
      return run(`file:${value}`, () => fileItem(item.id, { type: "photo", jobId: d.jobId }), `Filed as a job photo on ${labelOf(d.jobId)}.`);
    const sentence =
      d.type === "job" ? (isCost ? `Filed on ${labelOf(d.jobId)}.` : `Kept on ${labelOf(d.jobId)}.`) : `Filed as a business cost, ${d.category}.`;
    run(
      `file:${value}`,
      async () => {
        const res = await fileItem(item.id, d.type === "job" ? { type: "job", jobId: d.jobId } : { type: "overhead", category: d.category }, { differentPurchase });
        // The server's extra (the supplier document it linked, or that the link didn't save) rides
        // after where it went.
        return res.ok && res.message ? { ...res, message: `${sentence}${res.message.replace(/^Filed\./, "")}` } : res;
      },
      sentence,
    );
  }

  const toggle = (what: "job" | "bucket") => setPicking((cur) => (cur === what ? null : what));
  const spin = (key: string) => busy === key;

  // ── THE HEADLINE: the supplier card's grammar for a cost; the paper's own line otherwise ──
  const costCard = r.state === "ready" || r.state === "needs_total";
  const unread = r.state === "not_read" || r.state === "too_big";
  const says = paperSays(item);
  const headline = costCard
    ? `${String(item.vendor ?? "").trim() || paperTypeLabel(type)} · ${rowTotal === null ? "No Total Read" : formatCurrency(rowTotal)} · ${says ? `It Says ${says}` : "No Job Name On It"}`
    : unread
      ? String(item.title ?? "").trim() || "A Paper"
      : describePaper(item);
  const grey = costCard
    ? [item.doc_number ? `#${item.doc_number}` : null, item.item_date ? formatDate(item.item_date) : null, paperKindWords(item)]
    : [item.doc_number ? `#${item.doc_number}` : null, item.item_date ? `Dated ${formatDate(item.item_date)}` : null, `Added ${formatDate(item.created_at)}`];
  // A badge only when the paper needs something.
  const badge =
    r.state === "needs_total" ? (
      <Badge tone="amber">Needs A Total</Badge>
    ) : r.state === "not_read" ? (
      <Badge tone="slate">Not Read Yet</Badge>
    ) : r.state === "too_big" ? (
      <Badge tone="amber">Too Big To Read</Badge>
    ) : null;
  // The state's own sentence, where the card has no answers to say it with.
  const stateSentence =
    r.state === "keep" || r.state === "later" || r.state === "needs_total" || r.state === "too_big"
      ? r.sentence
      : r.state === "not_read" && p.readError
        ? r.sentence
        : null;

  /** Why it is back in the tray: its bill was deleted, maybe as a duplicate (review of wave 2, TD5). */
  const billBack = billDeletedSaid(item);
  /** Why the ⋯ may also say a door: what is already on the card. */
  const onCard: ("Fix Details" | "Read Again" | "Keep It In Files" | "Set Aside" | "Delete")[] = [];
  if (readAgainNamed) onCard.push("Read Again");
  if (mode === "keep") onCard.push("Keep It In Files");
  const menuRows = paperMenuRows(r.state, !!item.file_url, onCard);

  // A BANK DOWNLOAD is one card: how it sorted, the rows that need a person, Apply / Not Now.
  if (r.state === "bank_download") {
    return (
      <Card className="border-brand/30">
        <div className="flex gap-3 p-3 sm:gap-4 sm:p-4">
          <div className="min-w-0 flex-1">
            {/* Said once each: what it is here, the account and days in the card's headline (no
                badge repeating "Bank Download"). */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">{describePaper(item)}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
              <span>Added {formatDate(item.created_at)}</span>
              <span className="truncate">{item.title}</span>
            </div>
            <BankCard itemId={item.id} view={item.bank} run={run} busy={busy} working={working} />
            {said && (
              <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${said.tone === "error" ? "bg-red-50 text-red-700" : "bg-brand/5 text-brand-dark"}`} role={said.tone === "error" ? "alert" : "status"}>
                {said.text}
              </p>
            )}
          </div>
        </div>
      </Card>
    );
  }

  // A SUPPLIER'S OPEN LIST is one sentence and Apply / Not Now; nothing else on this row applies.
  if (r.state === "open_list") {
    return (
      <Card className="border-brand/30">
        <div className="flex gap-3 p-3 sm:gap-4 sm:p-4">
          <Thumb item={item} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">{describePaper(item)}</span>
              <Badge tone="blue">Supplier&apos;s List</Badge>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
              <span>Added {formatDate(item.created_at)}</span>
              <span className="truncate">{item.title}</span>
            </div>
            <OpenListCard itemId={item.id} view={item.open_list} run={run} busy={busy} working={working} />
            {said && (
              <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${said.tone === "error" ? "bg-red-50 text-red-700" : "bg-brand/5 text-brand-dark"}`} role={said.tone === "error" ? "alert" : "status"}>
                {said.text}
              </p>
            )}
          </div>
        </div>
      </Card>
    );
  }

  // ── THE ANSWERS ──────────────────────────────────────────────────────────────────────────
  const firstJobAnswer = firstFor.startsWith("job:") && firstJob;
  const firstButton = firstFor ? (
    firstJobAnswer ? (
      <Button onClick={() => fileTo(mode === "photo" ? `photo:${firstJob.id}` : `job:${firstJob.id}`)} disabled={working || !!jobRefusal} title={jobRefusal ?? undefined}>
        {spin(`file:${mode === "photo" ? "photo" : "job"}:${firstJob.id}`) ? <Loader2 className="animate-spin" /> : null}
        {mode === "photo" ? `Put Photo On ${firstJob.label}` : `Put It On ${firstJob.label}`}
        {first.isGuess && <GuessMark />}
      </Button>
    ) : firstFor === "stock" ? (
      <Button onClick={() => fileTo("stock")} disabled={working || !!stockRefusal} title={stockRefusal ?? undefined}>
        Record To Stock
        {first.isGuess && <GuessMark />}
      </Button>
    ) : firstFor.startsWith("cost:") ? (
      <Button onClick={() => fileTo(firstFor)} disabled={working || !!costRefusal} title={costRefusal ?? undefined}>
        {spin(`file:${firstFor}`) ? <Loader2 className="animate-spin" /> : null}
        {`Business Cost · ${firstFor.slice(5)}`}
        {first.isGuess && <GuessMark />}
      </Button>
    ) : null
  ) : null;
  /** The line under the first answer: why the paper picked it, or whose guess it is. */
  const becauseLine =
    firstButton && first.because ? (
      <p className={`flex items-start gap-1.5 text-sm ${first.isGuess ? "text-slate-600" : "text-emerald-800"}`}>
        {first.isGuess ? <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
        <span>{first.because}</span>
      </p>
    ) : null;
  const anotherJob = (
    <Button variant="outline" onClick={() => toggle("job")} disabled={working || !!jobRefusal} title={jobRefusal ?? undefined} aria-expanded={picking === "job"}>
      {firstJobAnswer ? "Another Job" : "Pick A Job"}
    </Button>
  );
  const jobPicker =
    picking === "job" ? (
      <JobPicker
        ariaLabel={mode === "photo" ? "Which job is this photo for?" : "Which job is this paper for?"}
        closest={closestJobs}
        jobs={pickJobs}
        value={pickedJob}
        onChange={setPickedJob}
        onPut={(j) => fileTo(mode === "photo" ? `photo:${j.id}` : `job:${j.id}`)}
        onCancel={() => setPicking(null)}
        busy={working}
        verb={mode === "photo" ? "Put Photo On" : "Put It On"}
        refusal={jobRefusal}
      />
    ) : null;
  // Every distinct reason an answer is shut, said once under the answers.
  const shutWhy = [...new Set([jobRefusal, costRefusal, stockRefusal, keepRefusal].filter((x): x is string => !!x))];
  const conflict = p.jobConflict ? (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
      {p.jobConflict}
    </p>
  ) : null;

  const costAnswers = (
    <div className="space-y-2" role="group" aria-label="Where does this go?">
      {conflict}
      {!firstButton && <p className="text-sm font-medium text-slate-900">Where does this go?</p>}
      <div className="flex flex-wrap gap-2">
        {firstButton}
        {anotherJob}
        {/* Shop Stock off (0352): the shelf isn't offered. A paper that already picked stock has it first. */}
        {shopStock && firstFor !== "stock" && (
          <Button variant="outline" onClick={() => fileTo("stock")} disabled={working || !!stockRefusal} title={stockRefusal ?? undefined}>
            Shop Stock
          </Button>
        )}
        <Button variant="outline" onClick={() => toggle("bucket")} disabled={working || !!costRefusal} title={costRefusal ?? undefined} aria-expanded={picking === "bucket"}>
          Business Cost
        </Button>
      </div>
      {becauseLine}
      {jobPicker}
      {picking === "bucket" && <BucketGrid onPick={(b) => fileTo(`cost:${b}`)} onCancel={() => setPicking(null)} busy={working} refusal={costRefusal} />}
    </div>
  );

  const changeAnswer = (
    <Button variant="outline" onClick={() => setAnswer(null)} disabled={working}>
      <Undo2 /> Change Answer
    </Button>
  );

  // NOT A COST: a job, or kept in files. AI Suggest's old idea for it rides as a chip.
  const suggestTask = mode === "keep" && answer !== "else" ? (p.suggestTask ?? null) : null;
  const suggestKeep = mode === "keep" && answer !== "else" && p.suggestKeep === true;
  const keepAnswers = (
    <div className="space-y-2" role="group" aria-label="Where does this go?">
      {conflict}
      {!firstButton && <p className="text-sm font-medium text-slate-900">Where does this go?</p>}
      <div className="flex flex-wrap gap-2">
        {firstButton}
        {anotherJob}
        <Button variant="outline" onClick={() => fileTo("keep")} disabled={working || !!keepRefusal} title={keepRefusal ?? undefined}>
          {spin("keep") ? <Loader2 className="animate-spin" /> : <Archive />} Keep It In Files
        </Button>
        {answer === "else" && changeAnswer}
      </div>
      {becauseLine}
      {jobPicker}
      {(suggestTask || suggestKeep) && (
        <div className="flex flex-wrap items-center gap-2">
          {suggestTask && (
            <button type="button" onClick={() => run("task", () => makeTaskFromPaper(item.id), `Added a Reminder: "${suggestTask.title}".`)} disabled={working} className={CHIP}>
              {spin("task") ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <ListTodo className="h-4 w-4 shrink-0 text-brand" />}
              <span className="min-w-0 break-words">Add A Reminder: {suggestTask.title}</span>
            </button>
          )}
          {suggestKeep && (
            <button type="button" onClick={() => run("note", () => keepAsNote(item.id), "Kept as a note.")} disabled={working} className={CHIP}>
              {spin("note") ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <StickyNote className="h-4 w-4 shrink-0 text-brand" />}
              Keep As Note
            </button>
          )}
          <span className="text-xs text-slate-500">A suggestion{p.why ? `: ${p.why}` : ""}. Nothing moves until you tap it.</span>
        </div>
      )}
    </div>
  );

  // A PICTURE ASKS WHAT IT IS FIRST.
  const askWhat = (
    <div className="space-y-2" role="group" aria-label="What is this?">
      <p className="text-sm font-medium text-slate-900">What is this?</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Button variant="outline" onClick={() => setAnswer("photo")} disabled={working}>
          <Camera /> Job Photo
        </Button>
        <Button variant="outline" onClick={() => run("cost", () => readAsCost(item.id))} disabled={working}>
          {spin("cost") ? <Loader2 className="animate-spin" /> : <Receipt />} {spin("cost") ? "Reading…" : "Bill Or Receipt"}
        </Button>
        <Button variant="outline" onClick={() => setAnswer("else")} disabled={working}>
          <FileText /> Something Else
        </Button>
      </div>
    </div>
  );

  // Job Photo: which job. A photo on a job, never a cost.
  const photoAnswers = (
    <div className="space-y-2" role="group" aria-label="Which job is this photo for?">
      {conflict}
      {!firstButton && <p className="text-sm font-medium text-slate-900">Which job is this photo for?</p>}
      <div className="flex flex-wrap gap-2">
        {firstButton}
        {anotherJob}
        {changeAnswer}
      </div>
      {becauseLine}
      {jobPicker}
    </div>
  );

  // THE ONE DOOR A PAPER THE READER COULDN'T FINISH NEEDS. Its answers come once it has a total.
  const neededDoor =
    r.state === "not_read" ? (
      <Button onClick={() => run("read", () => readPaperworkItem(item.id))} disabled={working}>
        {spin("read") ? <Loader2 className="animate-spin" /> : <Sparkles />} {spin("read") ? "Reading…" : "Read Now"}
      </Button>
    ) : r.state === "too_big" || r.state === "needs_total" ? (
      <Button onClick={() => setFixing(true)} disabled={working}>
        <Pencil /> Fix Details: Put The Total In
      </Button>
    ) : r.state === "supplier_documents" ? (
      <Button onClick={() => run("ced", () => addSupplierDocuments(item.id), "Added to the supplier documents.")} disabled={working}>
        {spin("ced") ? <Loader2 className="animate-spin" /> : <BookOpen />} Add To Supplier Documents
      </Button>
    ) : null;

  return (
    <Card className={r.state === "ready" || r.state === "supplier_documents" ? "border-emerald-200" : "border-amber-200"}>
      <div className="p-3 sm:p-4">
        <div className="flex gap-3">
          <Thumb item={item} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-words font-medium text-slate-900">{headline}</span>
              {badge}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">{grey.filter(Boolean).join(" · ")}</p>
          </div>
          {menuRows.length > 0 && (
            // THE ⋯: the rarer doors, one row each. The sheets they open (Fix Details) are drawn by
            // the card itself, so closing the menu never takes a half-filled sheet with it.
            <SectionActionsMenu tree={CARD_MENU}>
              {menuRows.includes("Fix Details") && (
                <button type="button" className={MENU_ROW} onClick={() => setFixing(true)} disabled={working}>
                  <Pencil className="h-4 w-4 shrink-0" /> Fix Details
                </button>
              )}
              {menuRows.includes("Read Again") && (
                <button type="button" className={MENU_ROW} onClick={() => run("read", () => readPaperworkItem(item.id))} disabled={working}>
                  {spin("read") ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <RotateCcw className="h-4 w-4 shrink-0" />} Read Again
                </button>
              )}
              {menuRows.includes("Keep It In Files") && (
                <button type="button" className={MENU_ROW} onClick={() => run("keep", () => keepPaperwork(item.id), "Kept in files.")} disabled={working}>
                  <Archive className="h-4 w-4 shrink-0" /> Keep It In Files
                </button>
              )}
              {menuRows.includes("Set Aside") && (
                <button type="button" className={MENU_ROW} onClick={() => run("archive", () => archiveItem(item.id), "Set aside. Find it in Organize, under Archive.")} disabled={working}>
                  <Archive className="h-4 w-4 shrink-0" /> Set Aside
                </button>
              )}
              {menuRows.includes("Delete") && (
                <button
                  type="button"
                  className={MENU_DANGER_ROW}
                  disabled={working}
                  onClick={() => {
                    if (confirm(`Delete this ${describePaper(item)}? The file goes too.`)) run("delete", () => deleteOrganizedItem(item.id), undefined, "Deleted.");
                  }}
                >
                  <Trash2 className="h-4 w-4 shrink-0" /> Delete
                </button>
              )}
            </SectionActionsMenu>
          )}
        </div>

        {item.pricing_provisional && (
          <p className="mt-2 text-xs text-amber-800">
            The prices on this paper look like a counter preview, not your account&apos;s own. The bill will say so.
          </p>
        )}
        {stateSentence && <p className="mt-2 text-sm text-slate-600">{stateSentence}</p>}

        {/* OPEN PAPER, the first row: the file and its lines inline, the supplier card's Open Bill. */}
        {(item.signedUrl || rowLines.length > 0) && (
          <div className="mt-2">
            <Button variant="outline" aria-expanded={paperOpen} onClick={() => setPaperOpen((o) => !o)}>
              {paperOpen ? "Close Paper" : "Open Paper"}
            </Button>
            {mismatch && !paperOpen && (
              <p className="mt-1 text-xs text-amber-800" role="status">
                Its lines don&apos;t add up to the total read. Open Paper shows both.
              </p>
            )}
            {paperOpen && (
              <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700">
                {item.signedUrl ? (
                  /\.pdf($|\?)/i.test(item.signedUrl) || /\.pdf$/i.test(String(item.file_url ?? "")) ? (
                    <a href={item.signedUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
                      Open The PDF
                    </a>
                  ) : (
                    <a href={item.signedUrl} target="_blank" rel="noopener noreferrer" className="block" title="Open The Paper">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.signedUrl} alt={item.title} className="max-h-[28rem] w-full rounded object-contain" />
                    </a>
                  )
                ) : (
                  <p className="py-1 text-slate-500">No file is on this one: it was typed in.</p>
                )}
                {rowLines.length > 0 && (
                  <div>
                    <p className="py-1 font-medium text-slate-900">Lines ({rowLines.length})</p>
                    <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
                      {rowLines.map((l) => (
                        <li key={l.index} className="flex items-start gap-2 px-3 py-1.5">
                          <span className="min-w-0 flex-1 break-words">
                            {l.quantity !== 1 ? `${l.quantity} × ` : ""}
                            {l.description}
                            {!l.billable ? <span className="text-slate-500"> (not billed to the customer)</span> : null}
                            {l.billable && l.billed_amount !== undefined ? (
                              <span className="text-slate-500"> (bills {formatCurrency(l.billed_amount)} of it)</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 tabular-nums">{formatCurrency(l.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {mismatch && addsUp && (
                  <p className="rounded bg-amber-50 px-2 py-1.5 text-sm text-amber-900" role="status">
                    The lines add up to {formatCurrency(addsUp.lineSum)}; the total read is {formatCurrency(addsUp.amount)}. If the total is
                    wrong, fix it with Fix Details. Filing records the total either way, and the bill says so.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* THE SAME PURCHASE: Tie Them per match, and one line saying what every other answer means. */}
        {samePurchase.length > 0 && (r.state === "ready" || r.state === "supplier_documents") && (
          <div className="mt-2 space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            {samePurchase.map((m) => (
              <div key={matchKey(m)}>
                <p>{m.sentence}</p>
                <Button
                  variant="outline"
                  className="mt-1.5"
                  disabled={working}
                  onClick={() => run("tie", () => tiePaperwork(item.id, { billId: m.billId }), "Tied to what was already on the books.")}
                >
                  {spin("tie") ? <Loader2 className="animate-spin" /> : <Link2 />} Same Purchase: Tie Them
                </Button>
              </div>
            ))}
            <p className="text-xs">{samePurchaseLine(r.state, onBooks.length)}</p>
          </div>
        )}
        {toLink.length > 0 && onBooks.length === 0 && r.state === "ready" && (
          <div className="mt-2 rounded-lg bg-brand/5 px-3 py-2 text-sm text-brand-dark">
            {toLink.map((m) => (
              <p key={matchKey(m)}>{m.sentence}</p>
            ))}
          </div>
        )}
        {p.ced?.refused?.length ? (
          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            {p.ced.refused.map((x, i) => (
              <p key={`${x.number ?? "none"}-${i}`}>Won&apos;t be added: {x.error}.</p>
            ))}
            <p className="text-xs">Only the documents that add up go on the list. Check the paper for the rest.</p>
          </div>
        ) : null}
        {papers.length > 0 && (
          <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {papers.map((m) => (
              <p key={matchKey(m)}>{m.sentence}</p>
            ))}
          </div>
        )}
        {billBack && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            {billBack}
          </p>
        )}
        {said && (
          <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${said.tone === "error" ? "bg-red-50 text-red-700" : "bg-brand/5 text-brand-dark"}`} role={said.tone === "error" ? "alert" : "status"}>
            {said.text}
          </p>
        )}

        {mode === "cost" && <div className="mt-2.5">{costAnswers}</div>}
        {mode === "keep" && <div className="mt-2.5">{keepAnswers}</div>}
        {mode === "ask" && <div className="mt-2.5">{askWhat}</div>}
        {mode === "photo" && <div className="mt-2.5">{photoAnswers}</div>}
        {neededDoor && <div className="mt-2.5 flex flex-wrap gap-2">{neededDoor}</div>}

        {/* WHY AN ANSWER IS SHUT, in the words the server would refuse with, once each. */}
        {(mode === "cost" || mode === "keep" || mode === "photo") && shutWhy.length > 0 && (
          <div className="mt-2 space-y-1">
            {shutWhy.map((why) => (
              <p key={why} className="text-xs text-slate-600">
                {why}
              </p>
            ))}
            {readAgainNamed && (
              <Button variant="outline" onClick={() => run("read", () => readPaperworkItem(item.id))} disabled={working}>
                {spin("read") ? <Loader2 className="animate-spin" /> : <Sparkles />} {spin("read") ? "Reading…" : "Read Again"}
              </Button>
            )}
          </div>
        )}
      </div>
      {shelfSheet && (
        <ShelfTicketSheet
          title="File It To Stock"
          lines={shelfRowsOf(item).map(
            (l): ShelfCountLine => ({
              key: String(l.index),
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unit_price,
              amount: l.amount,
              category: l.category,
            }),
          )}
          total={rowTotal}
          fileLabel="File It To Stock"
          onClose={() => setShelfSheet(null)}
          onFile={async (choices) => {
            const res = await fileItem(item.id, { type: "stock", lines: choices }, { differentPurchase: shelfSheet.differentPurchase });
            if (!res.ok) return { ...res, error: cardSentence(res.error) };
            setShelfSheet(null);
            const sentence = res.message ?? "Filed in shop stock.";
            onFiled({ id: item.id, sentence: `${describePaper(item)}: ${sentence}` });
            toast(sentence, "success", {
              label: "Undo",
              onClick: () => {
                void undoPaperwork(item.id).then((u) => {
                  toast(u.ok ? u.message ?? "Undone." : u.error ?? "Couldn't undo.", u.ok ? "success" : "error");
                  router.refresh();
                  onChanged?.();
                });
              },
            });
            router.refresh();
            onChanged?.();
            return res;
          }}
        />
      )}
      {fixing && (
        <FixDetails
          item={item}
          onClose={() => setFixing(false)}
          onSaved={() => {
            setFixing(false);
            router.refresh();
            onChanged?.();
          }}
        />
      )}
    </Card>
  );
}

/**
 * The list: every paper waiting, and what was filed from here this visit with its Undo. A filed
 * row leaves the waiting list on refresh, so its Undo lives here rather than on a row that is
 * about to disappear.
 */
export function PaperworkList({
  items,
  jobs,
  matches,
  empty,
  shopStock = true,
  onChange,
}: {
  items: PaperRowItem[];
  jobs: JobOption[];
  matches: Record<string, NumberMatch[]>;
  empty?: React.ReactNode;
  /** The Shop Stock switch (0352), for every row. Absent = on. */
  shopStock?: boolean;
  /** Something filed, came back, or changed: a holder that isn't a page reads its rows again. */
  onChange?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [filed, setFiled] = useState<Filed[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);

  async function undo(f: Filed) {
    setUndoing(f.id);
    const res = await undoPaperwork(f.id);
    setUndoing(null);
    if (!res.ok) {
      toast(res.error ?? "Couldn't undo.", "error", undefined, { sticky: true });
      return;
    }
    setFiled((all) => all.filter((x) => x.id !== f.id));
    toast(res.message ?? "Undone.", "success");
    router.refresh();
    onChange?.();
  }

  return (
    <div className="space-y-3">
      {filed.length > 0 && (
        <ul className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
          {filed.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm text-emerald-900">
              <Check className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{f.sentence}</span>
              <Button variant="outline" onClick={() => void undo(f)} disabled={undoing === f.id}>
                {undoing === f.id ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo
              </Button>
            </li>
          ))}
        </ul>
      )}
      {items.length === 0 ? (
        empty ?? null
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <PaperworkRow
                item={item}
                jobs={jobs}
                matches={matches[item.id] ?? []}
                shopStock={shopStock}
                onChanged={onChange}
                onFiled={(f) => setFiled((all) => [f, ...all.filter((x) => x.id !== f.id)])}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
