"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, BookOpen, Check, FileText, Link2, Loader2, Pencil, Sparkles, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { jobLabel } from "@/lib/schedule-options";
import {
  PAPER_BUCKETS,
  describePaper,
  fileRefusal,
  paperTypeOfItem,
  parseDestination,
  proposalOf,
  readinessOf,
  shownDestination,
  suggestedDestination,
  type NumberMatch,
  type PaperItem,
} from "@/lib/paperwork";
import {
  aiReviewItem,
  archiveItem,
  deleteOrganizedItem,
  fileItem,
  readPaperworkItem,
  tiePaperwork,
  undoPaperwork,
} from "@/app/(app)/organize/actions";
import { addSupplierDocuments, keepPaperwork, updatePaperwork } from "@/app/(app)/organize/paperwork-actions";

/**
 * ONE ROW FOR ONE PIECE OF PAPER, ON EVERY PAGE THAT HOLDS PAPER (0295).
 *
 * The Organize tray and Drop Paperwork on /bills render THIS, so a receipt is filed the same way
 * whichever door it came in by: one line saying what was read, where it could go (the reader's
 * suggestion picked, never pressed), and File It. The button asks the same fileRefusal the server
 * asks, so a door that looks open is open, and a closed one says why in the words the server
 * would refuse with.
 *
 * Nothing on this row files anything on its own. Choosing in the picker only picks.
 */

export type PaperRowItem = PaperItem & {
  title: string;
  created_at: string;
  signedUrl: string | null;
  file_url?: string | null;
};

type JobOption = { id: string; job_number: string; name: string };
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

function matchKey(m: NumberMatch): string {
  if (m.kind === "bill") return `bill:${m.billId}`;
  if (m.kind === "supplier_invoice") return `si:${m.supplierInvoiceId}`;
  return `paper:${m.itemId}`;
}

function badgeFor(item: PaperItem) {
  const r = readinessOf(item);
  switch (r.state) {
    case "ready":
    case "supplier_documents":
      return <Badge tone="green">Ready To File</Badge>;
    case "needs_total":
      return <Badge tone="amber">Needs A Total</Badge>;
    case "not_read":
      return <Badge tone="slate">Not Read Yet</Badge>;
    case "too_big":
      return <Badge tone="amber">Too Big To Read</Badge>;
    case "later":
      return <Badge tone="slate">Not Filed</Badge>;
    case "keep":
      return <Badge tone="blue">Not A Cost</Badge>;
    default:
      return <Badge tone="slate">Filed</Badge>;
  }
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
  const isCost = type === "receipt" || type === "bill";

  async function save() {
    setSaving(true);
    setError(null);
    const res = await updatePaperwork(item.id, {
      doc_type: type,
      vendor: vendor.trim() || null,
      amount: amount.trim() === "" ? null : Number(amount.replace(/[$,\s]/g, "")),
      item_date: date || null,
      doc_number: number.trim() || null,
      payment: isCost ? paid : null,
    });
    setSaving(false);
    if (!res.ok) return setError(res.error ?? "Couldn't save.");
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title="Fix Details" footer={<ModalActions onCancel={onClose} onSave={save} saving={saving} />}>
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
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
            <Label htmlFor={`fd-vendor-${item.id}`}>Supplier Or Store</Label>
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
  showAiSuggest = false,
}: {
  item: PaperRowItem;
  jobs: JobOption[];
  matches: NumberMatch[];
  onFiled: (filed: Filed) => void;
  /** Organize's "AI Suggest" (a second look that suggests a job or bucket; never files). */
  showAiSuggest?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [said, setSaid] = useState<{ text: string; tone: "error" | "info" } | null>(null);
  const jobIds = jobs.map((j) => j.id);
  // null until a person picks: until then the picker FOLLOWS the suggestion, which may arrive after
  // this row is on screen (Drop Paperwork adds the row, then reads it; AI Suggest writes later).
  const [picked, setDest] = useState<string | null>(null);
  const dest = shownDestination(picked, item, jobIds);

  const r = readinessOf(item);
  const p = proposalOf(item);
  const type = paperTypeOfItem(item);
  const isCost = type === "receipt" || type === "bill";
  // Only a BILL is "already on the books". A CED document no bill covers is linked by File It.
  const onBooks = matches.filter((m): m is Extract<NumberMatch, { kind: "bill" }> => m.kind === "bill");
  const toLink = matches.filter((m): m is Extract<NumberMatch, { kind: "supplier_invoice" }> => m.kind === "supplier_invoice");
  const papers = matches.filter((m) => m.kind === "paper");
  const parsedDest = parseDestination(dest);
  const blocked = fileRefusal(item, parsedDest);
  const suggestion = suggestedDestination(item, jobIds);
  const suggestedJob = p.jobId ? jobs.find((j) => j.id === p.jobId) : null;
  const working = pending || busy !== null;

  function whereSaid(value: string): string {
    const d = parseDestination(value);
    if (!d) return "";
    if (d.type === "job") {
      const j = jobs.find((x) => x.id === d.jobId);
      return j ? `on ${jobLabel(j)}` : "on the job";
    }
    if (d.type === "overhead") return `as a business cost, ${d.category}`;
    return "in files";
  }

  function run(key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, filedSentence?: string) {
    setSaid(null);
    setBusy(key);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) {
        setSaid({ text: res.error ?? "That didn't work. Nothing changed.", tone: "error" });
        return;
      }
      if (filedSentence) {
        const sentence = `${res.message ?? filedSentence}`;
        onFiled({ id: item.id, sentence: `${describePaper(item)}: ${sentence}` });
        toast(sentence, "success", {
          label: "Undo",
          onClick: () => {
            void undoPaperwork(item.id).then((u) => {
              toast(u.ok ? u.message ?? "Undone." : u.error ?? "Couldn't undo.", u.ok ? "success" : "error");
              router.refresh();
            });
          },
        });
      } else if (res.message) {
        setSaid({ text: res.message, tone: "info" });
      }
      router.refresh();
    });
  }

  function fileIt(differentPurchase = false) {
    const d = parseDestination(dest);
    if (!d) return setSaid({ text: "Pick where it goes first: a job, or a business cost bucket.", tone: "error" });
    if (d.type === "keep") return run("keep", () => keepPaperwork(item.id), "Kept in files.");
    const where = whereSaid(dest);
    const said = isCost ? `Filed ${where}.` : `Kept ${where}.`;
    run(
      differentPurchase ? "anyway" : "file",
      async () => {
        const res = await fileItem(item.id, d.type === "job" ? { type: "job", jobId: d.jobId } : { type: "overhead", category: d.category }, { differentPurchase });
        // The server's extra (the CED link, or that it didn't save) rides after where it went.
        return res.ok && res.message ? { ...res, message: `${said}${res.message.replace(/^Filed\./, "")}` } : res;
      },
      said,
    );
  }

  const picker = (
    <Select
      value={dest}
      onChange={(e) => setDest(e.target.value)}
      disabled={working}
      className="h-11 min-w-0 flex-1 sm:w-64 sm:flex-none"
      aria-label="Where It Goes"
    >
      <option value="">Where Does It Go?</option>
      <optgroup label="A Job">
        {jobs.map((j) => (
          <option key={j.id} value={`job:${j.id}`}>
            {jobLabel(j)}
            {suggestion === `job:${j.id}` ? " (Suggested)" : ""}
          </option>
        ))}
      </optgroup>
      {isCost ? (
        <optgroup label="Business Cost (No Job)">
          {PAPER_BUCKETS.map((b) => (
            <option key={b} value={`cost:${b}`}>
              {b}
              {suggestion === `cost:${b}` ? " (Suggested)" : ""}
            </option>
          ))}
        </optgroup>
      ) : (
        <option value="keep">Keep It In Files</option>
      )}
    </Select>
  );

  return (
    <Card className={r.state === "ready" || r.state === "supplier_documents" ? "border-emerald-200" : "border-amber-200"}>
      <div className="flex gap-3 p-3 sm:gap-4 sm:p-4">
        <Thumb item={item} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">{describePaper(item)}</span>
            {badgeFor(item)}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
            {item.doc_number && <span>#{item.doc_number}</span>}
            {item.item_date && <span>Dated {formatDate(item.item_date)}</span>}
            <span>Added {formatDate(item.created_at)}</span>
            <span className="truncate">{item.title}</span>
          </div>
          {item.pricing_provisional && (
            <p className="mt-1 text-xs text-amber-800">
              The prices on this paper look like a counter preview, not your account&apos;s own. The bill will say so.
            </p>
          )}
          {r.state !== "ready" && r.state !== "supplier_documents" && (
            <p className="mt-1 text-sm text-slate-600">{r.sentence}</p>
          )}
          {(suggestedJob || (p.bucket && isCost)) && r.state !== "later" && (
            <p className="mt-1 text-xs text-slate-600">
              <Sparkles className="mr-1 inline h-3 w-3 text-brand" />
              Suggested:{" "}
              {suggestedJob ? jobLabel(suggestedJob) : `Business Cost, ${p.bucket}`}
              {p.jobHint && suggestedJob ? ` (the paper says “${p.jobHint}”)` : ""}
              {p.why ? `. ${p.why}` : ""}.{" "}
              {dest === suggestion ? "It is picked below; nothing" : "Nothing"} is filed until you press File It.
            </p>
          )}

          {onBooks.length > 0 && (r.state === "ready" || r.state === "supplier_documents") && (
            <div className="mt-2 space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {onBooks.map((m) => (
                <div key={matchKey(m)}>
                  <p>{m.sentence}</p>
                  <Button
                    variant="outline"
                    className="mt-1.5"
                    disabled={working}
                    onClick={() => run(`tie`, () => tiePaperwork(item.id, { billId: m.billId }), "Tied to what was already on the books.")}
                  >
                    {busy === "tie" ? <Loader2 className="animate-spin" /> : <Link2 />} Same Purchase: Tie Them
                  </Button>
                </div>
              ))}
              <p className="text-xs">Tying files this paper against it and adds nothing new. If it is a different purchase with the same number, pick where it goes and press Different Purchase: File It Anyway.</p>
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

          {said && (
            <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${said.tone === "error" ? "bg-red-50 text-red-700" : "bg-brand/5 text-brand-dark"}`} role={said.tone === "error" ? "alert" : "status"}>
              {said.text}
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {(r.state === "ready" || r.state === "needs_total" || r.state === "keep") && (
              <>
                {picker}
                {onBooks.length > 0 && r.state === "ready" ? (
                  <Button onClick={() => fileIt(true)} disabled={working || !!blocked} title={blocked ?? undefined}>
                    {busy === "anyway" ? <Loader2 className="animate-spin" /> : <Check />} Different Purchase: File It Anyway
                  </Button>
                ) : (
                  <Button onClick={() => fileIt(false)} disabled={working || !!blocked} title={blocked ?? undefined}>
                    {busy === "file" || busy === "keep" ? <Loader2 className="animate-spin" /> : <Check />}{" "}
                    {isCost ? (toLink.length && r.state === "ready" ? `File It And Link To CED ${toLink.map((m) => m.invoiceNumber).join(", ")}` : "File It") : "Keep It"}
                  </Button>
                )}
              </>
            )}
            {r.state === "supplier_documents" && (
              <Button onClick={() => run("ced", () => addSupplierDocuments(item.id), "Added to the CED documents.")} disabled={working}>
                {busy === "ced" ? <Loader2 className="animate-spin" /> : <BookOpen />} Add To CED Documents
              </Button>
            )}
            {r.state === "not_read" && (
              <Button onClick={() => run("read", () => readPaperworkItem(item.id))} disabled={working}>
                {busy === "read" ? <Loader2 className="animate-spin" /> : <Sparkles />} {busy === "read" ? "Reading…" : "Read Now"}
              </Button>
            )}
            {(r.state === "later" || r.state === "supplier_documents") && (
              <Button variant="outline" onClick={() => run("keep", () => keepPaperwork(item.id), "Kept in files.")} disabled={working}>
                <Archive /> Keep It In Files
              </Button>
            )}
            {showAiSuggest && (r.state === "ready" || r.state === "needs_total" || r.state === "keep") && (
              <Button
                variant="outline"
                onClick={() => run("ai", async () => { const a = await aiReviewItem(item.id); return { ok: a.ok, error: a.message, message: a.message }; })}
                disabled={working}
              >
                {busy === "ai" ? <Loader2 className="animate-spin" /> : <Sparkles />} AI Suggest
              </Button>
            )}
            {r.state !== "supplier_documents" && (
              <Button variant="outline" onClick={() => setFixing(true)} disabled={working}>
                <Pencil /> Fix Details
              </Button>
            )}
            {r.state !== "later" && r.state !== "supplier_documents" && (
              <Button variant="outline" onClick={() => run("archive", () => archiveItem(item.id))} disabled={working} title="Set it aside in Organize's Archive">
                <Archive /> Set Aside
              </Button>
            )}
            {r.state === "later" && (
              <Button
                variant="outline"
                onClick={() => {
                  if (confirm(`Delete this ${describePaper(item)}? The file goes too.`)) run("delete", () => deleteOrganizedItem(item.id));
                }}
                disabled={working}
              >
                <Trash2 /> Delete
              </Button>
            )}
          </div>
          {blocked && parsedDest && (r.state === "ready" || r.state === "needs_total" || r.state === "keep") && (
            <p className="mt-1 text-xs text-slate-500">{blocked}</p>
          )}
        </div>
      </div>
      {fixing && (
        <FixDetails
          item={item}
          onClose={() => setFixing(false)}
          onSaved={() => {
            setFixing(false);
            router.refresh();
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
  showAiSuggest = false,
  empty,
}: {
  items: PaperRowItem[];
  jobs: JobOption[];
  matches: Record<string, NumberMatch[]>;
  showAiSuggest?: boolean;
  empty?: React.ReactNode;
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
                showAiSuggest={showAiSuggest}
                onFiled={(f) => setFiled((all) => [f, ...all.filter((x) => x.id !== f.id)])}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

