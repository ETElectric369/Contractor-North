"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { DropTarget } from "@/components/drop-target";
import { useRouter } from "next/navigation";
import { Wallet, DollarSign, Camera, Check, Paperclip, Keyboard, FileUp } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { SegmentedControl } from "@/components/ui/segmented";
import { Fold } from "@/components/why-fold";
import { todayStrInTz } from "@/lib/tz";
import { getOrgSettings } from "@/lib/org-settings";
import { formatCurrency, formatDate } from "@/lib/utils";
import { callOrLost } from "@/lib/lost-signal";
import { DIFFERENT_PURCHASE_DOOR, fileReceiptDocument } from "@/lib/receipt-capture";
import { createBill, deleteBill, linkReceiptToBill } from "@/app/(app)/jobs/actions";
import { billJobReceipt } from "@/app/(app)/organize/actions";
import { jobLabel } from "@/lib/schedule-options";
import { jobPickLabel } from "@/lib/job-pick-label";
import { useToast } from "@/components/toast";
import { openSnapOrNote } from "@/components/snap-or-note";
import { BUSINESS_COST_BUCKETS, type BusinessCostBucket } from "@/lib/business-cost-buckets";

// What a cost ON A JOB is. A cost with no job is a business cost and picks from the business-cost buckets
// instead (lib/business-cost-buckets), the same list every other no-job door uses.
const CATEGORIES = ["Materials", "Fuel", "Shop supplies", "Tools", "Subcontractor", "Permit", "Equipment rental", "Office", "Other"];
// A PRE-prep sanity ceiling on the raw pick, not the reader's cap: the reader's 8 MB applies to
// the file AFTER prepareImageForUpload shrinks it (a 12 MB phone shot preps to ~1 MB), so gating
// the raw pick at 8 would refuse photos the reader takes happily. The reader's own refusal, when
// it comes, is said in its words by the save path below.
const MAX_PHOTO = 15 * 1024 * 1024;
// A Snap in flight, stamped in sessionStorage as "<instance>:<ms>" the moment the camera door is
// tapped. A reload keeps sessionStorage; the photo, a cancel, a close or a client-side navigation
// clears it. So a page that mounts with the stamp still there came back from a reload that
// happened while the camera was open (see the notice effect in the component).
const SNAP_KEY = "cn-quick-cost-snap";
const SNAP_STALE_MS = 10 * 60 * 1000;
// Once per page load, however many Add Cost doors the page mounts.
let reloadAnnounced = false;

/** Same test JobDocuments uses: a touch device gets a straight-to-camera door. */
function onPhone() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent))
  );
}

const DEFAULT_TRIGGER =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50";

type QuickCostProps = {
  orgId?: string;
  jobId?: string;
  jobs?: { id: string; label: string }[];
  label?: string;
  /** On a phone, open the sheet camera first: Snap the Bill leads the sheet and the Supplier
   *  field doesn't grab focus, so no keyboard comes up over the camera door. My Day sets it (the
   *  person there is standing at the truck with the paper in hand). */
  snapFirst?: boolean;
  /** Trigger glyph. A STRING (not a LucideIcon reference) so server components can
   *  pick it across the RSC boundary. The job action dock passes "dollar": at icon
   *  size a wallet and the Materials tab's Package box share the same rounded-rect
   *  silhouette — $ is unmistakable at a glance (Erik's 60mph feedback, 7/14). "none" is a plain
   *  text link (/bills' Add By Hand). */
  icon?: "wallet" | "dollar" | "keyboard" | "none";
  className?: string;
  /** Fired when the modal OPENS. Do NOT unmount this component here (it would kill
   *  the modal) — use it for side effects only. */
  onOpen?: () => void;
  /** Fired when the modal CLOSES — e.g. a host dropdown closes itself then. */
  onClose?: () => void;
  /** The Nort switch (0352, rule k). The receipt reader works either way; with Nort off it is
   *  never called Nort. Default on: a mount that doesn't pass it reads as today. */
  nortOn?: boolean;
  /**
   * TYPE IT IN (W1-23, W1-32): THE ONE TYPED COST SHEET, for a cost with no paper to snap. The job's
   * Costs tab ⋯ opens it with the job preselected; /bills' Add By Hand opens it with the job picker.
   * No receipt block here: a paper goes in through Snap The Bill or Snap Or Note.
   */
  typeOnly?: boolean;
  /** The Shop Stock switch (0352), for the typed sheet's What's It For?. Absent = off (no row). */
  shopStock?: boolean;
  /** The host's read of the jobs failed (its `jobs` is empty for that reason, not because there are
   *  none): the typed sheet says it couldn't load them, never "no jobs yet". */
  jobsUnread?: boolean;
};

/**
 * THE one "add a cost" everywhere. Two sheets behind one button:
 *
 *   · the snap sheet (My Day's Now card): supplier + amount + category + an optional receipt photo
 *     (the camera on mobile), with Read the Receipt / Type It In once a paper is attached;
 *   · TYPE IT IN (`typeOnly`): the one typed cost sheet, for a cost with no paper (the job's Costs
 *     tab ⋯, and /bills' Add By Hand).
 *
 * Both save through createBill (a cost = a bill), so every surface logs a cost the same way.
 *
 * Drop it anywhere: pass `jobId` to pre-scope it, or `jobs` for a picker. If
 * neither `orgId` nor `jobs` is supplied (e.g. the global + menu), it self-loads
 * the org id and the job list on open. `onOpen` lets a host (a dropdown) close
 * itself when the modal opens.
 *
 * The cost is saved first; the photo is attached after. A photo that fails to
 * upload is never silently dropped — the modal stays open with a notice and a
 * one-tap retry (the cost is already safe).
 */
export function QuickCostButton(props: QuickCostProps) {
  return props.typeOnly ? <TypeItInButton {...props} /> : <SnapCostButton {...props} />;
}

/** The trigger's glyph, by name. */
function TriggerIcon({ icon }: { icon: QuickCostProps["icon"] }) {
  if (icon === "none") return null;
  if (icon === "dollar") return <DollarSign className="h-4 w-4 shrink-0" />;
  if (icon === "keyboard") return <Keyboard className="h-4 w-4 shrink-0" />;
  return <Wallet className="h-4 w-4 shrink-0" />;
}

function SnapCostButton({
  orgId,
  jobId,
  jobs,
  label = "Add Cost",
  icon = "wallet",
  className,
  snapFirst = false,
  onOpen,
  onClose,
  nortOn = true,
}: QuickCostProps) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  // THE CAMERA DOOR SPEAKS (Erik, 2026-09-16, "Add cost can't take photo", filed from My Day). A
  // hidden <input capture> clicked from a button is the same door JobPhotos and JobDocuments use,
  // and when the OS refuses it (the shell's camera permission, a picker that never presents),
  // nothing in JS throws: the tap just does nothing, and a button that does nothing is a dead end.
  // So Snap arms a short timer. If neither a photo (change) nor a cancel comes back and the page
  // never left the screen, the sheet says so under the buttons and names the other door. While a
  // real camera is up it covers the sheet, and the photo or the cancel clears the line on return,
  // so a slow camera can never read as a false alarm.
  const [cameraHint, setCameraHint] = useState<string | null>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The listeners a Snap arms, so clearing the watch can also unarm them.
  const snapListeners = useRef<(() => void) | null>(null);
  const snapId = useRef(Math.random().toString(36).slice(2));
  // Read on the client after mount (navigator is not on the server), so the camera door can't
  // cause a hydration mismatch on the mounts that server-render this button.
  const [phone, setPhone] = useState(false);
  useEffect(() => setPhone(onPhone()), []);
  const [open, setOpen] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [amount, setAmount] = useState(0);
  // Default the date to today so a cost lands on the right day in one tap — blank
  // was dropping a known value. Seeded to the browser's local day immediately,
  // then refined to the org's timezone once settings load on open.
  const [billDate, setBillDate] = useState(() => todayStrInTz(getOrgSettings(null).timezone));
  // Did a PERSON set the date? Today is only a seed. When Nort reads a receipt, the date printed
  // on the paper wins unless someone changed this field (an Aug 29 receipt read on Sep 24 was
  // filed as Sep 24, because the seed was being sent as if it were a fact).
  const [dateTouched, setDateTouched] = useState(false);
  const [category, setCategory] = useState("Materials");
  // The bucket, when the cost has no job. Nothing is picked for the person (see onSave).
  const [bucket, setBucket] = useState("");
  const [paid, setPaid] = useState(false);
  const [job, setJob] = useState(jobId ?? "");
  const [receipt, setReceipt] = useState<File | null>(null);
  // How a receipt gets recorded: Nort reads it, or the person types it. null = decided by the
  // form (blank supplier + amount → read; anything typed → type), until the person picks.
  const [readMode, setReadMode] = useState<"read" | "type" | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // The cost row is saved; only the photo may still be pending (retry mode).
  const [costSaved, setCostSaved] = useState(false);
  // The bill the first save created, kept so a later successful receipt upload can LINK to
  // it. Without the link, re-uploading that same photo files a second bill for the same money.
  const [savedBillId, setSavedBillId] = useState<string | null>(null);
  // SAME NUMBER, NOTHING WRITTEN (review of audit v994's fix). The reader found a bill already
  // carrying this paper's printed number and wrote nothing. The paper is filed on the job (this
  // id); the sheet stays open and offers Different Purchase: Record It Anyway right here, since
  // the button under Receipts & Papers only appears after another paid read.
  const [sameAsDoc, setSameAsDoc] = useState<string | null>(null);
  // Self-loaded context when not passed in (global + menu use).
  const [autoOrg, setAutoOrg] = useState("");
  const [autoJobs, setAutoJobs] = useState<{ id: string; label: string }[] | null>(null);
  // The org's timezone, loaded once on first open, so the seeded cost date is the
  // org's "today" (not the device's). Falls back to the default tz until loaded.
  const orgTz = useRef<string | null>(null);

  const effectiveOrg = orgId || autoOrg;
  const pickerJobs = jobs ?? autoJobs ?? undefined;
  const targetJob = jobId ?? job;
  // THE READER IS A CHOICE, NOT A SIDE EFFECT OF BLANK FIELDS. It used to run only when both
  // supplier and amount were empty — type "CED" first, attach the photo, and the extraction
  // silently never happened (Erik: "who's going to manually type it anymore once they've
  // tried mr Nort processing machine"). With a receipt on a job the form now shows the
  // choice; the blank-fields rule is only the default.
  const canRead = !!receipt && !!targetJob;
  const autoRead = !supplier.trim() && (!amount || amount <= 0);
  const useReader = canRead && (readMode ?? (autoRead ? "read" : "type")) === "read";

  function reset() {
    setSupplier("");
    setAmount(0);
    setBillDate(todayStrInTz(orgTz.current ?? getOrgSettings(null).timezone));
    setDateTouched(false);
    setCategory("Materials");
    setBucket("");
    setPaid(false);
    setJob(jobId ?? "");
    setReceipt(null);
    setReadMode(null);
    setError(null);
    setWarn(null);
    setCostSaved(false);
    setSameAsDoc(null);
    if (fileRef.current) fileRef.current.value = "";
    if (captureRef.current) captureRef.current.value = "";
  }

  /** One gate for every way a file arrives (camera, library, drop): the 15 MB storage
   *  ceiling, refused at selection so nothing is silently dropped on save. */
  function pick(f: File | null) {
    if (f && f.size > MAX_PHOTO) {
      setError("That file is over 15 MB — attach a smaller one.");
      setReceipt(null);
      if (fileRef.current) fileRef.current.value = "";
      if (captureRef.current) captureRef.current.value = "";
      return;
    }
    setError(null);
    setReceipt(f);
  }

  /** Forget a Snap in flight: the timer, its listeners, the hint, and this instance's reload stamp. */
  function clearSnapWatch() {
    if (snapTimer.current) {
      clearTimeout(snapTimer.current);
      snapTimer.current = null;
    }
    snapListeners.current?.();
    snapListeners.current = null;
    setCameraHint(null);
    try {
      if (sessionStorage.getItem(SNAP_KEY)?.startsWith(`${snapId.current}:`)) sessionStorage.removeItem(SNAP_KEY);
    } catch {}
  }

  /** The camera door. Never a dead tap: no input to click means the library door, or a sentence. */
  function snap() {
    const input = captureRef.current;
    if (!input) {
      if (fileRef.current) return fileRef.current.click();
      return setError(NO_PICKER_LINE("the camera or your photos"));
    }
    clearSnapWatch();
    try {
      sessionStorage.setItem(SNAP_KEY, `${snapId.current}:${Date.now()}`);
    } catch {}
    // A cancel (iOS 16.4+ fires it on the input) or a return to the screen after the camera had
    // it means the door DID open; drop the watch so the hint never shows over a working camera.
    const onCancel = () => clearSnapWatch();
    const onVisible = () => {
      if (document.visibilityState === "visible") clearSnapWatch();
    };
    input.addEventListener("cancel", onCancel);
    document.addEventListener("visibilitychange", onVisible);
    snapListeners.current = () => {
      input.removeEventListener("cancel", onCancel);
      document.removeEventListener("visibilitychange", onVisible);
    };
    input.click();
    snapTimer.current = setTimeout(() => {
      snapTimer.current = null;
      // The page is covered (the camera, most likely): nothing to say, keep listening for the return.
      if (document.visibilityState !== "visible") return;
      snapListeners.current?.();
      snapListeners.current = null;
      // Nothing opened and nothing covers us. No reload is coming from this tap either.
      try {
        if (sessionStorage.getItem(SNAP_KEY)?.startsWith(`${snapId.current}:`)) sessionStorage.removeItem(SNAP_KEY);
      } catch {}
      setCameraHint("Camera didn't open? Tap Photo or PDF to pick from your photos, or allow the camera for North in your phone's Settings.");
    }, 2500);
  }

  /** The library door (Photo or PDF). Choosing it ends any camera hint. */
  function pickFromLibrary() {
    setCameraHint(null);
    if (fileRef.current) return fileRef.current.click();
    setError(NO_PICKER_LINE("your photos"));
  }

  // THE RELOAD THAT EATS THE SHEET. In the iOS shell the camera can push the web view out of
  // memory; the shell reloads the page (Capacitor's webViewWebContentProcessDidTerminate) and this
  // sheet, its typed fields and the photo just taken are gone with no console line and no
  // sentence. Snap stamps sessionStorage before the camera opens (a reload keeps it; the normal
  // photo / cancel / close paths clear it), so the first Add Cost door to mount after such a
  // reload says what happened. Unmounting (a client-side navigation, not a reload) drops this
  // instance's stamp so a later page load can't misread it.
  useEffect(() => {
    let at = 0;
    try {
      const raw = sessionStorage.getItem(SNAP_KEY);
      if (raw) {
        at = Number(raw.split(":")[1] || 0);
        sessionStorage.removeItem(SNAP_KEY);
      }
    } catch {}
    if (at && Date.now() - at < SNAP_STALE_MS && !reloadAnnounced) {
      reloadAnnounced = true;
      toast("The app reloaded while the camera was open, so that receipt photo didn't land. Open Add Cost again and try Photo or PDF.", "error");
    }
    const id = snapId.current;
    return () => {
      if (snapTimer.current) clearTimeout(snapTimer.current);
      try {
        if (sessionStorage.getItem(SNAP_KEY)?.startsWith(`${id}:`)) sessionStorage.removeItem(SNAP_KEY);
      } catch {}
    };
  }, [toast]);

  async function openModal() {
    reset();
    onOpen?.();
    setOpen(true);
    // Load the org's timezone once so the seeded date is the org's "today" — even
    // when orgId was passed in (job-scoped use), where the id self-load is skipped.
    if (orgTz.current == null) {
      const supabase = createClient();
      const { data } = await supabase.from("organizations").select("id, settings").limit(1).maybeSingle();
      if (!orgId && (data as any)?.id) setAutoOrg((data as any).id);
      orgTz.current = getOrgSettings((data as any)?.settings).timezone;
      setBillDate(todayStrInTz(orgTz.current));
    }
    if (!jobId && !jobs && !autoJobs) {
      const supabase = createClient();
      const { data } = await supabase
        .from("jobs")
        .select("id, job_number, name")
        .order("created_at", { ascending: false })
        .limit(200);
      if (data) setAutoJobs((data as any[]).map((j) => ({ id: j.id, label: jobLabel(j) })));
    }
  }

  function closeModal() {
    clearSnapWatch();
    setDateTouched(false);
    setOpen(false);
    onClose?.();
  }

  function finishOk() {
    clearSnapWatch();
    setOpen(false);
    reset();
    onClose?.();
    router.refresh();
  }

  // Why the last attach failed, in the pipeline's words — so the two "didn't upload" notices
  // below can say WHAT went wrong instead of only that it did.
  const attachFailure = useRef<string | null>(null);

  /** Upload the receipt + file it on the job — THE receipt pipeline (lib/receipt-capture: prep,
   *  path, storage, documents row), the same one the Costs tab and Receipts & Papers run. This
   *  door used to upload the raw file, so an iPhone HEIC reached the reader as a name it refuses
   *  and a 12 MB shot tripped its 8 MB cap — two of the reasons the receipt-only save kept
   *  landing on the $0 placeholder. Returns the new document id (what the reader and the bill
   *  link need), or null on any failure so the caller can tell the user instead of swallowing it. */
  async function attachReceipt(forJob: string): Promise<string | null> {
    if (!receipt || !effectiveOrg) return null;
    attachFailure.current = null;
    try {
      const filed = await fileReceiptDocument({ orgId: effectiveOrg, jobId: forJob, file: receipt });
      if (!filed.ok) {
        attachFailure.current = filed.error;
        return null;
      }
      return filed.docId;
    } catch (e: any) {
      attachFailure.current = e?.message ?? null;
      return null;
    }
  }
  /** "didn't upload (storage said …)" — the clause after "the receipt", with the reason when
   *  there is one. */
  const attachClause = () => attachFailure.current ?? "didn't upload";

  /** What the PERSON stated on the form, handed to the reader: attestation beats inference. */
  function stated(differentPurchase = false) {
    return {
      paid,
      category: category || null,
      // Only a date a person set is a fact; the seeded "today" would outrank the paper's own
      // date (organize/actions.ts: `stated?.billDate || itemDate`). The seeded day still
      // lands when the paper has no legible date, so the bill is never dateless.
      billDate: dateTouched ? billDate || null : null,
      fallbackBillDate: billDate || null,
      ...(differentPurchase ? { differentPurchase: true } : {}),
    };
  }

  /** What the sheet does with the reader's answer for the paper filed as `docId`. */
  async function afterRead(docId: string, res: Awaited<ReturnType<typeof billJobReceipt>>) {
    if (!res.ok) {
      // Reader failed (unreadable file) — fall back to a bill so the cost isn't lost,
      // with the receipt attached and linked for later. Whatever the person typed is
      // the bill; nothing typed is a $0 placeholder that names its own gap.
      const typedAmount = amount > 0 ? amount : 0;
      const fb = await createBill({
        job_id: targetJob, supplier: supplier.trim() || "From receipt — add supplier", bill_number: "",
        amount: typedAmount, status: paid ? "paid" : "unpaid", bill_date: billDate || null,
        notes: "", category, receipt_document_id: docId,
      });
      if (!fb.ok) return setError(res.error ?? "Couldn't read the receipt.");
      setSameAsDoc(null);
      setSavedBillId(fb.id ?? null);
      setWarn(
        typedAmount > 0
          ? `${nortOn ? "Nort couldn't" : "Couldn't"} read it (${res.error ?? "unreadable"}) — saved your typed ${formatCurrency(typedAmount)} instead, receipt attached.`
          : `Couldn't read a total (${res.error ?? "unreadable"}) — saved as $0. Open the bill to enter the amount.`,
      );
      setCostSaved(true);
      return;
    }
    // A BILL ALREADY CARRIES THIS NUMBER: NOTHING WAS SAVED. Not the "saved with a warning" branch
    // below: that one labels the footer Retry Receipt, and here there is no cost to retry. The
    // receipt is filed on the job, so it is cleared from the form and never uploaded again; the
    // footer offers the one real choice, and Done closes.
    if (res.already && res.sameAs) {
      setReceipt(null);
      setSameAsDoc(docId);
      setWarn(`${res.sameAs} ${DIFFERENT_PURCHASE_DOOR}`);
      return;
    }
    setSameAsDoc(null);
    // THE READER COULDN'T MAKE ITS OWN NUMBERS AGREE. The cost IS saved and the warning is
    // on the bill's notes permanently — but a person standing at the truck should hear it
    // now, not discover it in an argument three months later. finishOk() resets state, so
    // the sheet stays open to say so. Clearing the receipt first makes the costSaved branch
    // above fall straight to finishOk() on the next tap: no path can re-attach or re-bill.
    if (res.warning) {
      setReceipt(null);
      setWarn(res.warning);
      setCostSaved(true);
      return;
    }
    finishOk();
  }

  function onSave() {
    setError(null);
    setWarn(null);
    // A person looked at "already on the books" and says it is a different purchase: the paper
    // already filed on the job is read once more, and recorded.
    if (sameAsDoc) {
      const docId = sameAsDoc;
      start(async () => {
        const res = await billJobReceipt(docId, stated(true));
        await afterRead(docId, res);
      });
      return;
    }
    // Retry mode: the cost already saved last time; only the photo needs a retry.
    if (costSaved) {
      if (!receipt || !targetJob) return finishOk();
      start(async () => {
        const docId = await attachReceipt(targetJob);
        if (!docId) return setWarn(`Still couldn't attach it — the receipt ${attachClause()}. ${RETRY_HERE_LINE}`);
        // Link it to the cost we already saved, so this file can never be read as a NEW cost.
        if (savedBillId) await linkReceiptToBill(savedBillId, docId);
        finishOk();
      });
      return;
    }
    // Read the Receipt (the default when nothing is typed, or the person's pick): don't invent
    // a $0 bill — run the SAME receipt-reader the Costs tab uses, so ONE pipeline reads the
    // total/vendor/lines and the file can never be double-entered later ("already recorded").
    // This was the two-door bug: the quick path saved $0 placeholders, then the Costs-tab
    // upload recorded the real amounts as SEPARATE bills.
    if (useReader && targetJob) {
      start(async () => {
        const docId = await attachReceipt(targetJob);
        if (!docId) return setError(`The receipt ${attachClause()} — try again.`);
        // Pass what the user actually stated — the AI reads the paper, but if they ticked
        // "Already paid", chose a category, or set a date, those are facts, not guesses.
        // (Supplier and amount are the paper's to read in this mode — the form says so and
        // greys them; if they typed any, they come back below when the reader fails.)
        const res = await billJobReceipt(docId, stated());
        await afterRead(docId, res);
      });
      return;
    }
    // Fragment-first: snapping a receipt must NEVER be blocked by a missing supplier —
    // the photo IS the capture, and the supplier can be read off it / filled in later.
    // Require the supplier only when there's no receipt to carry the detail.
    if (!supplier.trim() && !receipt) return setError("Who was it paid to? (supplier)");
    // TYPE IT IN TYPES A NUMBER. With a receipt attached the supplier may stay blank — the paper
    // carries it — but the amount may not: Type It In with nothing typed used to save a $0 bill,
    // receipt attached, and say "Cost saved ✓". That is not a cost, it is a figure invented for
    // a bill that doesn't have one yet (MONEY law: never invent a figure), and the person walked
    // away believing it was recorded. The reader is the door that gets the number off the paper
    // without typing, so the refusal names it — or, off a job (where Nort can't read), the field.
    if (receipt && !(amount > 0))
      return setError(canRead ? "Type the amount, or switch to Read the Receipt." : `Type the amount — or pick a job and ${nortOn ? "Nort can read it" : "it can be read"} off the receipt.`);
    // No job means a business cost, and a business cost goes in a bucket the person picked. A
    // preselected bucket would file every cost nobody looked at under the same word.
    if (!targetJob && !bucket) return setError("Pick the bucket this business cost goes in, or pick a job.");
    const finalSupplier = supplier.trim() || "From receipt — add supplier";
    start(async () => {
      // With a receipt in hand, upload it FIRST so the bill can be created already linked
      // to its file — the link is what makes a later "Record as cost" tap on the same file
      // answer "already recorded" instead of double-entering it. Upload failure falls back
      // to the old order (save the cost, retry the file).
      let docId: string | null = null;
      if (receipt && targetJob) docId = await attachReceipt(targetJob);
      const res = await createBill({
        job_id: targetJob || null,
        supplier: finalSupplier,
        bill_number: "",
        amount,
        status: paid ? "paid" : "unpaid",
        bill_date: billDate || null,
        notes: "",
        category: targetJob ? category : bucket,
        receipt_document_id: docId,
      });
      if (!res.ok) return setError(res.error ?? "Couldn't save the cost.");
      setCostSaved(true);
      setSavedBillId(res.id ?? null);
      if (receipt && targetJob && !docId) {
        setWarn(`Cost saved ✓ — but the receipt ${attachClause()}. ${RETRY_HERE_LINE}`);
        return;
      }
      finishOk();
    });
  }

  // SNAP FIRST, FROM MY DAY (Erik 2026-09-23, f79b48d9: My Day's Add Cost opened a typing form
  // with the camera at the bottom, under a focused Supplier field whose keyboard could cover it).
  // With snapFirst on a phone the receipt block below leads the sheet as a full-width Snap the
  // Bill, the Costs tab's own verb, and Supplier doesn't take focus. It is the SAME block in
  // either place, hidden inputs and all, so the typed path and the reader behave identically.
  const snapTop = snapFirst && phone;
  const receiptBlock = (
    <div>
      {!snapTop && <Label>Receipt</Label>}
      {/* TWO inputs, because one `capture` attribute lied somewhere on every platform:
          it forced iOS STRAIGHT to the camera (no library, no files) while desktop
          ignored it and opened a folder. So the camera door (capture="environment") is
          its own input that only a phone gets a button for, and the no-capture input
          keeps the native Take Photo / Photo Library / Choose File sheet on mobile and
          the file picker on desktop — the emailed-PDF case stays covered. */}
      <input
        ref={captureRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          clearSnapWatch();
          pick(e.target.files?.[0] ?? null);
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          setCameraHint(null);
          pick(e.target.files?.[0] ?? null);
        }}
      />
      <DropTarget
        onFiles={(files) => pick(files[0] ?? null)}
        accept="image/*,application/pdf,.pdf"
        multiple={false}
        label="Drop the Receipt"
      >
        {receipt ? (
          <button
            type="button"
            onClick={pickFromLibrary}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-600 hover:bg-slate-50"
          >
            <Check className="h-4 w-4 text-green-600" /> <span className="truncate">{receipt.name || "Receipt attached"}</span>
          </button>
        ) : snapTop ? (
          <div className="space-y-2">
            <Button type="button" size="lg" onClick={snap} className="w-full">
              <Camera /> Snap the Bill
            </Button>
            <button
              type="button"
              onClick={pickFromLibrary}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-600 hover:bg-slate-50"
            >
              <Paperclip className="h-4 w-4" /> Photo or PDF
            </button>
          </div>
        ) : (
          <div className={phone ? "grid grid-cols-2 gap-2" : ""}>
            {phone && (
              <button
                type="button"
                onClick={snap}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-600 hover:bg-slate-50"
              >
                <Camera className="h-4 w-4" /> Snap the Receipt
              </button>
            )}
            <button
              type="button"
              onClick={pickFromLibrary}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-600 hover:bg-slate-50"
            >
              {phone ? (
                <><Paperclip className="h-4 w-4" /> Photo or PDF</>
              ) : (
                <><Camera className="h-4 w-4" /> Add Receipt: Photo or PDF</>
              )}
            </button>
          </div>
        )}
      </DropTarget>
      {cameraHint && !receipt && <p className="mt-1 text-xs text-amber-600">{cameraHint}</p>}
      {receipt && !targetJob && <p className="mt-1 text-xs text-amber-600">Pick a job to file the receipt with it.</p>}
      {/* The "Read the Receipt" affordance — a choice the person can see and flip, not a
          rule buried in which fields happen to be blank. */}
      {canRead && !costSaved && (
        <div className="mt-2 space-y-1.5">
          <SegmentedControl
            stretch
            activeId={useReader ? "read" : "type"}
            onSelect={(id) => setReadMode(id === "read" ? "read" : "type")}
            items={[
              { id: "read", label: "Read the Receipt" },
              { id: "type", label: "Type It In" },
            ]}
          />
          <p className="text-xs text-slate-500">
            {useReader
              ? `${nortOn ? "Nort reads" : "Reads"} the supplier, total, lines and date off the paper; change the date to override it. Category and Already Paid are yours.`
              : `Saves the amount you type, with the receipt attached. ${nortOn ? "Nort won't read it." : "It won't be read."}`}
          </p>
        </div>
      )}
    </div>
  );

  return (
    <>
      <button type="button" className={className ?? DEFAULT_TRIGGER} onClick={openModal}>
        <TriggerIcon icon={icon} /> {label}
      </button>
      {/* portal: one mount of this button sits INSIDE the job action dock's
          `glass glass-menu` bar — backdrop-filter makes that bar the containing
          block for an in-place fixed overlay, trapping/crushing the modal in the
          bar on fine-pointer browsers (the cn-v463 physics). Portaling is safe for
          every mount: no <form> wraps this Modal (footer uses onSave callbacks). */}
      <Modal
        open={open}
        onClose={closeModal}
        title="Add a cost"
        portal
        footer={
          <ModalActions
            onCancel={sameAsDoc ? finishOk : closeModal}
            onSave={onSave}
            saving={pending}
            cancelLabel={sameAsDoc ? "Done" : undefined}
            saveLabel={sameAsDoc ? "Different Purchase: Record It Anyway" : costSaved ? "Retry Receipt" : useReader ? "Read the Receipt" : "Save Cost"}
          />
        }
      >
        <div className="space-y-4">
          {snapTop && !sameAsDoc && receiptBlock}
          <div>
            {/* The asterisk is the truth of the save path: a supplier is REQUIRED only when
                there is no receipt to carry it (fragment-first) — with a photo attached, Nort
                reads it (Read the Receipt) or the bill says "From receipt — add supplier"
                (Type It In), so a greyed, starred field was a demand the form never made. */}
            <Label htmlFor="qc-supplier">Paid to / supplier{receipt ? "" : " *"}</Label>
            <Input id="qc-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={useReader ? (nortOn ? "Nort reads it off the receipt" : "Read off the receipt") : "e.g. Main Street Supply"} autoFocus={!snapTop} disabled={costSaved || useReader} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="qc-amt">Amount</Label>
              <NumberInput id="qc-amt" value={amount} onValueChange={setAmount} disabled={costSaved || useReader} />
            </div>
            <div>
              <Label htmlFor="qc-date">Date</Label>
              <Input id="qc-date" type="date" value={billDate} onChange={(e) => { setBillDate(e.target.value); setDateTouched(true); }} />
            </div>
          </div>
          {!jobId && pickerJobs && pickerJobs.length > 0 && (
            <div>
              <Label htmlFor="qc-job">Job</Label>
              <Select id="qc-job" value={job} onChange={(e) => setJob(e.target.value)} disabled={costSaved || !!sameAsDoc}>
                <option value="">Business Cost (No Job)</option>
                {pickerJobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.label}</option>
                ))}
              </Select>
            </div>
          )}
          {targetJob ? (
            <div>
              <Label htmlFor="qc-cat">Category</Label>
              <Select id="qc-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
          ) : (
            <div>
              <Label htmlFor="qc-bucket">Bucket</Label>
              <Select id="qc-bucket" className="h-11" value={bucket} onChange={(e) => setBucket(e.target.value)} disabled={costSaved}>
                <option value="">Pick a Bucket</option>
                {BUSINESS_COST_BUCKETS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </Select>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="h-4 w-4 rounded border-slate-300" disabled={costSaved} />
            Already paid (cash / card) — skip the bill
          </label>
          {!snapTop && !sameAsDoc && receiptBlock}
          {warn && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{warn}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </>
  );
}

// ── TYPE IT IN: THE ONE TYPED COST SHEET ───────────────────────────────────────────────────────

/** What's It For?, besides a job's id: a cost of running the business, or stock for the shop. */
const BUSINESS = "__business";
const STOCK = "__stock";

/**
 * STOCK GOES IN BY THE PIECE, FROM THE TICKET'S LINES (Shop Stock, 0303): each line a person counts
 * becomes a roll with its own cost, which a typed amount has none of. So Shop Stock here is a door,
 * never a guessed save: the paper goes in through Snap Or Note, whose card has Shop Stock.
 */
/**
 * WHERE A RECEIPT GOES WHEN THIS SHEET CAN'T TAKE IT (review of W1-23: Receipts & Papers has no
 * uploader any more, so the old sentences sending a receipt there named a door that isn't there).
 * Before the cost is saved: the job's Costs tab's Snap The Bill reads the cost off the paper, so it is
 * one door or the other, never both. After it is saved: only Retry Receipt ties the paper to THIS cost;
 * Snap The Bill or Upload would read it into a second bill for the same money.
 */
export const NO_PICKER_LINE = (what: string) =>
  `Couldn't open ${what} on this device. Type the cost here without the receipt, or close this and use Snap The Bill on the job's Costs tab, which reads the cost off the paper. Not both: that would record it twice.`;
export const RETRY_HERE_LINE =
  "The cost is saved: tap Retry Receipt when you have signal. Don't put this receipt in through the job's Snap The Bill or Upload, which would record the cost a second time.";

/** The typed sheet's jobs couldn't be read: a job's cost waits for a reload, never becomes a business cost. */
export const JOBS_UNREAD_LINE = "Couldn't load your jobs just now. Reload the page to put this cost on a job.";

export const SHOP_STOCK_BY_PAPER =
  "Stock goes in by the piece, from the ticket's lines, so it comes in on paper: snap or drop the ticket in Snap Or Note, then tap Shop Stock on its card.";

export { jobPickLabel };

export type TypedCostFields = {
  amount: number;
  date: string;
  /** A job's id, BUSINESS, STOCK, or "" (nothing picked yet). */
  target: string;
  bucket: BusinessCostBucket | null;
  where: string;
  paid: "paid" | "unpaid";
  billNumber: string;
  poId: string;
};

/**
 * WHY A TYPED COST CAN'T BE SAVED YET, in plain words; null when it can. Pure, so the rules are
 * pinned: A BLANK JOB IS NOT A BUSINESS COST (no job has to be said out loud, with its bucket), NO
 * BUCKET IS PICKED FOR HIM (a preselected one files every cost nobody looked at under the same
 * word), and a job's cost says where it was bought (createBill needs a supplier).
 */
export function typedCostProblem(f: Pick<TypedCostFields, "amount" | "date" | "target" | "bucket" | "where">): string | null {
  if (!(f.amount > 0)) return "Type the amount.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return "Pick the day it was bought.";
  if (!f.target) return "Pick the job it's for, or Business Cost and its bucket.";
  if (f.target === STOCK) return SHOP_STOCK_BY_PAPER;
  if (f.target === BUSINESS) return f.bucket ? null : "Tap the bucket this business cost goes in.";
  if (!f.where.trim()) return "Say where it was bought (the supplier).";
  return null;
}

/**
 * WHAT createBill IS HANDED for a typed cost. Pure: ON ACCOUNT IS NEVER SAVED AS PAID; a business
 * cost with no Where is saved under its bucket's own name (one fixed placeholder per bucket, never
 * a made-up supplier per month; /bills keeps those out of its supplier-spelling list); a job's cost
 * is Materials, and says which of the job's orders it pays when one is picked.
 */
export function typedCostBill(f: TypedCostFields): Parameters<typeof createBill>[0] {
  const business = f.target === BUSINESS;
  return {
    job_id: business ? null : f.target,
    supplier: f.where.trim() || (business && f.bucket ? f.bucket : ""),
    bill_number: f.billNumber.trim(),
    amount: f.amount,
    status: f.paid === "unpaid" ? "unpaid" : "paid",
    bill_date: f.date,
    notes: "",
    category: business ? f.bucket : "Materials",
    po_id: business ? null : f.poId || null,
  };
}

/** A purchase order on the chosen job that a bill may say it pays: a real order, never a draft
 *  that was never sent or a cancelled one (neither is a cost, so paying one would mean nothing). */
type LivePo = { id: string; po_number: string | null; vendor: string | null; total: number };

/** A 44px either-or button, filled when it is the one picked. */
const choiceCls = (on: boolean) =>
  `flex min-h-11 w-full items-center justify-center rounded-lg border px-3 py-2 text-center text-sm font-medium leading-tight ${
    on ? "border-brand bg-brand text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
  }`;

/**
 * THE ONE TYPED COST SHEET (W1-23, W1-32). Amount, the day, What's It For? (a job, Business Cost and
 * its bucket, or Shop Stock while that switch is on), Where, Paid? (Already Paid, or On Account and
 * still owed), a Bill # under More, and the job's own purchase order when it has one. It saves
 * through createBill as it is, then says what landed where, with an Undo (deleteBill).
 */
function TypeItInButton({
  jobId,
  jobs,
  label = "Type It In",
  icon = "keyboard",
  className,
  onOpen,
  onClose,
  shopStock = false,
  jobsUnread = false,
}: QuickCostProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(() => todayStrInTz(getOrgSettings(null).timezone));
  // Today is only a seed until a person changes the day; the company's today replaces it once read.
  const dateTouched = useRef(false);
  const [target, setTarget] = useState<string>(jobId ?? "");
  const [bucket, setBucket] = useState<BusinessCostBucket | null>(null);
  const [where, setWhere] = useState("");
  const [paid, setPaid] = useState<"paid" | "unpaid">("paid");
  const [billNumber, setBillNumber] = useState("");
  const [poId, setPoId] = useState("");
  // The chosen job's live orders, read by the sheet itself so no page has to hand them over.
  const [pos, setPos] = useState<{ jobId: string; list: LivePo[]; failed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [autoJobs, setAutoJobs] = useState<{ id: string; label: string }[] | null>(null);
  // The sheet's own jobs read failed (no signal): said as that, never as "no jobs yet".
  const [autoJobsFailed, setAutoJobsFailed] = useState(false);
  const orgTz = useRef<string | null>(null);

  const pickerJobs = jobs ?? autoJobs ?? [];
  const jobTarget = target && target !== BUSINESS && target !== STOCK ? target : null;
  const dirty = amount > 0 || !!where.trim() || !!bucket || !!billNumber.trim() || (!jobId && !!target);

  function reset() {
    setAmount(0);
    dateTouched.current = false;
    setDate(todayStrInTz(orgTz.current ?? getOrgSettings(null).timezone));
    setTarget(jobId ?? "");
    setBucket(null);
    setWhere("");
    setPaid("paid");
    setBillNumber("");
    setPoId("");
    setError(null);
  }

  async function openSheet() {
    reset();
    onOpen?.();
    setOpen(true);
    // Best effort, both: the day stays the device's today and the picker offers Business Cost when
    // either read can't be made (no signal), and the save itself says what happened. A jobs read that
    // failed says so on the sheet, so an empty picker is never read as "no jobs yet".
    const loadJobs = !jobId && !jobs && !autoJobs;
    try {
      const supabase = createClient();
      if (orgTz.current == null) {
        const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
        orgTz.current = getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone;
        if (!dateTouched.current) setDate(todayStrInTz(orgTz.current));
      }
      if (loadJobs) {
        const { data } = await supabase
          .from("jobs")
          .select("id, job_number, name")
          .neq("status", "cancelled")
          .order("created_at", { ascending: false })
          .limit(200);
        if (data) {
          setAutoJobsFailed(false);
          setAutoJobs((data as { id: string; job_number: string | null; name: string | null }[]).map((j) => ({ id: j.id, label: jobPickLabel(j) })));
        } else setAutoJobsFailed(true);
      }
    } catch {
      // Nothing to undo: the sheet is open with what it has, and says the jobs couldn't load.
      if (loadJobs) setAutoJobsFailed(true);
    }
  }

  function close() {
    setOpen(false);
    onClose?.();
  }

  // THE JOB'S OWN ORDERS: the Purchase Order picker is drawn only when the chosen job has one.
  useEffect(() => {
    if (!open || !jobTarget || pos?.jobId === jobTarget) return;
    let live = true;
    void (async () => {
      try {
        const { data, error: readErr } = await createClient()
          .from("purchase_orders")
          .select("id, po_number, vendor, total, status")
          .eq("job_id", jobTarget)
          .not("status", "in", "(draft,cancelled)")
          .order("created_at", { ascending: false })
          .limit(50);
        if (!live) return;
        const list = ((data ?? []) as { id: string; po_number: string | null; vendor: string | null; total: number | string | null }[]).map((p) => ({
          id: String(p.id),
          po_number: p.po_number ?? null,
          vendor: p.vendor ?? null,
          total: Number(p.total) || 0,
        }));
        setPos({ jobId: jobTarget, list, failed: !!readErr });
      } catch {
        // No signal: said under the fields, never a quiet missing picker.
        if (live) setPos({ jobId: jobTarget, list: [], failed: true });
      }
    })();
    return () => {
      live = false;
    };
  }, [open, jobTarget, pos?.jobId]);
  const jobPos = pos && pos.jobId === jobTarget ? pos : null;

  function pickTarget(next: string) {
    setTarget(next);
    setPoId("");
    setError(null);
    if (next !== BUSINESS) setBucket(null);
  }

  function save() {
    setError(null);
    const fields: TypedCostFields = { amount, date, target, bucket, where, paid, billNumber, poId };
    const problem = typedCostProblem(fields);
    if (problem) return setError(problem);
    const bill = typedCostBill(fields);
    const jobName = jobTarget ? (pickerJobs.find((j) => j.id === jobTarget)?.label ?? null) : null;
    const owed = paid === "unpaid" ? ", On Account (still owed)" : "";
    const said =
      target === BUSINESS
        ? `${where.trim() ? `${where.trim()} ` : ""}${formatCurrency(amount)} saved as a Business Cost: ${bucket}, ${formatDate(date)}${owed}.`
        : `${where.trim()} ${formatCurrency(amount)} saved on ${jobName ?? "this job"}, ${formatDate(date)}${owed}.`;
    start(async () => {
      // A dropped signal rejects (audit v994 SI2): the sheet and what was typed stay put, and the
      // sentence says it MAY have saved, because a lost answer can hide a bill that landed.
      const res = await callOrLost(() => createBill(bill), "Couldn't reach the server, so this may not have saved. Check the list before saving it again.");
      if (!res.ok) {
        if ("lost" in res) router.refresh();
        return setError(res.error ?? "The cost didn't save. Nothing was recorded.");
      }
      const id = res.id;
      toast(
        said,
        "success",
        id
          ? {
              label: "Undo",
              onClick: () => {
                void deleteBill(id, bill.job_id ?? "").then((undone) => {
                  toast(undone.ok ? (undone.warning ?? "Cost removed.") : (undone.error ?? "Couldn't remove it. Delete it from the list."), undone.ok ? "success" : "error");
                  router.refresh();
                });
              },
            }
          : undefined,
      );
      close();
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className={className ?? DEFAULT_TRIGGER} onClick={openSheet}>
        <TriggerIcon icon={icon} /> {label}
      </button>
      {/* Portaled: this sheet opens from the Costs tab's ⋯ panel, a glass (backdrop-filter) box that
          would otherwise trap its fixed overlay. No <form> wraps it (the footer calls save). */}
      <Modal
        open={open}
        onClose={close}
        title="Type It In"
        size="md"
        portal
        dirty={dirty}
        footer={<ModalActions onCancel={close} onSave={save} saving={pending} saveLabel="Save Cost" />}
      >
        <div className="space-y-4">
          {jobId && <p className="text-sm text-slate-500">A cost on this job, with no paper to snap.</p>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ti-amount">Amount</Label>
              <NumberInput id="ti-amount" value={amount} onValueChange={setAmount} placeholder="0.00" autoFocus />
            </div>
            <div>
              <Label htmlFor="ti-date">Date</Label>
              <Input
                id="ti-date"
                type="date"
                value={date}
                onChange={(e) => {
                  dateTouched.current = true;
                  setDate(e.target.value);
                }}
              />
            </div>
          </div>

          {!jobId && (
            <div className="space-y-2">
              <Label htmlFor="ti-job">What&apos;s It For?</Label>
              {/* THE JOB PICKER FIRST, then the two things a cost can be besides a job. Nothing is
                  picked for him: a blank job is not a business cost. */}
              <Select id="ti-job" className="h-11" value={jobTarget ?? ""} onChange={(e) => pickTarget(e.target.value)}>
                <option value="">Pick A Job</option>
                {pickerJobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.label}
                  </option>
                ))}
              </Select>
              {jobsUnread || (autoJobsFailed && pickerJobs.length === 0) ? (
                <p className="text-xs text-amber-800" role="alert">
                  {JOBS_UNREAD_LINE}
                </p>
              ) : (
                pickerJobs.length === 0 && <p className="text-xs text-slate-500">No jobs to pick from yet. A cost with no job is a Business Cost.</p>
              )}
              <div className={`grid gap-2 ${shopStock ? "grid-cols-2" : "grid-cols-1"}`} role="radiogroup" aria-label="Or">
                <button type="button" role="radio" aria-checked={target === BUSINESS} onClick={() => pickTarget(BUSINESS)} className={choiceCls(target === BUSINESS)}>
                  Business Cost
                </button>
                {shopStock && (
                  <button type="button" role="radio" aria-checked={target === STOCK} onClick={() => pickTarget(STOCK)} className={choiceCls(target === STOCK)}>
                    Shop Stock
                  </button>
                )}
              </div>
            </div>
          )}

          {target === BUSINESS && (
            <div>
              <p className="mb-2 text-sm text-slate-600">A cost of running the business, on no job. Which bucket?</p>
              <div role="radiogroup" aria-label="Business cost bucket" className="grid grid-cols-2 gap-2">
                {BUSINESS_COST_BUCKETS.map((b) => (
                  <button key={b} type="button" role="radio" aria-checked={bucket === b} onClick={() => setBucket(b)} className={choiceCls(bucket === b)}>
                    {b}
                  </button>
                ))}
              </div>
              {bucket === "Fees" && (
                <p className="mt-2 text-xs text-slate-500">
                  Bank and permit fees, or card fees from anything but Stripe (Stripe&apos;s fee is recorded on each payment on its own). A
                  supplier&apos;s late interest comes in with that supplier&apos;s own papers on Bills, so don&apos;t add it here.
                </p>
              )}
            </div>
          )}

          {target === STOCK ? (
            <div className="space-y-2 rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-700">
              <p>{SHOP_STOCK_BY_PAPER}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  close();
                  openSnapOrNote();
                }}
              >
                <FileUp /> Open Snap Or Note
              </Button>
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="ti-where">{target === BUSINESS ? "Where (Optional)" : "Where"}</Label>
                <Input id="ti-where" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="The store or company" />
              </div>

              <div>
                <Label>Paid?</Label>
                <div role="radiogroup" aria-label="Paid?" className="grid grid-cols-2 gap-2">
                  <button type="button" role="radio" aria-checked={paid === "paid"} onClick={() => setPaid("paid")} className={choiceCls(paid === "paid")}>
                    Already Paid
                  </button>
                  <button type="button" role="radio" aria-checked={paid === "unpaid"} onClick={() => setPaid("unpaid")} className={choiceCls(paid === "unpaid")}>
                    On Account (Still Owed)
                  </button>
                </div>
                {paid === "unpaid" && <p className="mt-1 text-xs text-slate-500">It counts in what you owe that supplier until you pay it.</p>}
              </div>

              {jobPos && jobPos.list.length > 0 && (
                <div>
                  <Label htmlFor="ti-po">Purchase Order</Label>
                  <Select id="ti-po" className="h-11" value={poId} onChange={(e) => setPoId(e.target.value)}>
                    <option value="">Not A PO, A Cost Of Its Own</option>
                    {jobPos.list.map((p) => (
                      <option key={p.id} value={p.id}>
                        {[p.po_number || "PO", p.vendor || "No Vendor", formatCurrency(p.total)].join(" · ")}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-slate-500">Pick the order this bill pays and it takes that order&apos;s place in the job&apos;s cost, so the delivery counts once.</p>
                </div>
              )}
              {jobPos?.failed && (
                <p className="text-xs text-amber-700">Couldn&apos;t check this job&apos;s purchase orders just now, so this can&apos;t say it pays one. Edit the bill later to link it.</p>
              )}

              <Fold summary={<span className="text-sm font-medium text-slate-700">More</span>}>
                <div className="pb-1">
                  <Label htmlFor="ti-number">Bill #</Label>
                  <Input id="ti-number" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
                </div>
              </Fold>
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
