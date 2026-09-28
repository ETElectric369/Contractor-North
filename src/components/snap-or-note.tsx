"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Camera, Check, FileUp, Loader2, Mic, Square, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { CameraCapture } from "@/components/camera-capture";
import { PaperworkList } from "@/components/paperwork-row";
import { ToastProvider } from "@/components/toast";
import { useFileDragActive } from "@/components/drop-target";
import { useDictation } from "@/lib/use-dictation";
import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { sha256Hex } from "@/lib/content-hash";
import { isPdfBytes, readPdfText } from "@/lib/pdf-text";
import { isListFile, LIST_ACCEPT, readListFile } from "@/lib/open-list-file";
import { captureReceipt } from "@/lib/receipt-capture";
import { formatCurrency } from "@/lib/utils";
import { addPaperwork, fingerprintSeen } from "@/app/(app)/organize/paperwork-actions";
import { saveVoiceNote, type OrganizedResult } from "@/app/(app)/organize/actions";
import { addOpenList } from "@/app/(app)/bills/open-list-actions";
import { routePastedText, snapContext, snapPaperRows, type PastedTextRoute, type SnapContext, type SnapRows } from "@/app/(app)/snap-or-note-actions";

/**
 * SNAP OR NOTE: ONE PAPER DOOR (W1-30). One sheet and one queue, opened from + anywhere in the app.
 * It takes a photo, a PDF or other file, or a typed or spoken note, reads each one on arrival and
 * hands back one card. Nothing becomes money until a person taps an answer on that card.
 *
 * THE QUEUE LIVES HERE, NOT IN THE SHEET. It was Drop Paperwork's on /bills (one line per file,
 * one loop reading them in order, so a drop in the middle of a read is never discarded); now it is
 * the app's, mounted once inside the top bar's + (every page has it). Closing the sheet never drops
 * a file: saved is saved, and the lines keep running. Other pages reach it through two window
 * events (openSnapOrNote, snapFiles) and draw its lines where they always did (useSnapLines).
 *
 * ONE SET OF RULES FOR EVERY WAY IN, per file, cheapest first:
 *   1. what it is: a PDF, a photo (a HEIC this device can't convert is refused by name), or a
 *      supplier's list or a bank download (Excel, CSV, OFX), which goes to addOpenList;
 *      anything else is named and refused;
 *   2. the 15 MB cap;
 *   3. the fingerprint of its ORIGINAL bytes, and "Already In" before anything is uploaded;
 *   4. a PDF's own text, read here in the browser: a supplier's portal PDF becomes its documents
 *      with no model call (addPaperwork reads the text);
 *   5. upload to the office's own folder, the row (addPaperwork, source organize), and only then
 *      the reader, through /api/paperwork/read so a read started from any page gets its 60 seconds.
 *      A read that never answers leaves "Saved, not read yet": the card waits with Read Now.
 *
 * THE CREW'S SHEET is Take Photo and a note, and never a price: a tech's photo asks Which Job? (his
 * open punch's job picked) and files on the job for the office through the job's own receipt door
 * (captureReceipt, read: false: the reader never runs for a tech), and his note is his own row.
 */

// ── THE STORE: one for the app, so the sheet and /bills draw the same lines ───────────────────

export type SnapTone = "busy" | "ok" | "warn" | "error";
export type SnapLine = { id: number; name: string; text: string; tone: SnapTone };
/** A tech's photo waiting for Which Job?. Kept here, not in the sheet: closing it drops nothing. */
export type PendingPhoto = { id: number; file: File; name: string };

type Store = {
  lines: SnapLine[];
  /** The papers this app took this visit, newest first: the sheet's cards. */
  papers: string[];
  pending: PendingPhoto[];
  open: boolean;
  /** Bumped when a file or a note finishes: pages refresh, the sheet reads its cards again. */
  version: number;
  ctx: SnapContext | null;
  /** Whose lines these are ("<user>:<company>"), from the first context that answered. */
  owner: string | null;
  /**
   * THE APP WAS LEFT (the + unmounted: sign-out goes to /login, outside the app). The store lives
   * in this page's memory and a sign-out is a soft navigation, so the next person on the device
   * would be handed the last one's lines (a supplier's name and amount) and waiting photos. Until a
   * fresh context says it is the same person in the same company, nothing in the store is drawn;
   * anyone else starts from an empty sheet.
   */
  held: boolean;
};
const START: Store = { lines: [], papers: [], pending: [], open: false, version: 0, ctx: null, owner: null, held: false };
let store: Store = START;
const listeners = new Set<() => void>();
function put(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
/** One field of the store, the same object back until it changes (useSyncExternalStore's rule). */
function useStore<K extends keyof Store>(key: K): Store[K] {
  return useSyncExternalStore(
    subscribe,
    () => store[key],
    () => START[key],
  );
}

const NO_LINES: SnapLine[] = [];
const NO_PAPERS: string[] = [];
const NO_PENDING: PendingPhoto[] = [];

/** The queue's lines, for any page that draws them (/bills' Needs You). None while held. */
export function useSnapLines(): SnapLine[] {
  const lines = useStore("lines");
  return useStore("held") ? NO_LINES : lines;
}
/** True while a file or a note is still being worked on. */
export function useSnapBusy(): boolean {
  return useSnapLines().some((l) => l.tone === "busy");
}
/**
 * HOW MANY FILES ARE STILL BEING SENT, right now (not a hook: the + asks at the moment of a tap,
 * before any full reload, which would drop them from this page's memory without a word).
 */
export function snapStillSending(): number {
  // The file being worked on has left the queue; the loop runs while it does.
  return running ? queue.length + 1 : queue.length;
}
/** Clear Finished Lines: every line that has its answer goes; the ones still working stay. */
export function clearFinishedSnapLines() {
  put({ lines: store.lines.filter((l) => l.tone === "busy") });
}

// ── THE DOORS OTHER PAGES USE ─────────────────────────────────────────────────────────────────

export const SNAP_OPEN_EVENT = "cn:snap-or-note:open";
export const SNAP_FILES_EVENT = "cn:snap-or-note:files";
/** What the sheet's Choose Files and a drop take (anything else still gets a line saying so). */
export const SNAP_ACCEPT = `application/pdf,.pdf,image/*,.heic,.heif,${LIST_ACCEPT}`;
const MAX_FILE = 15 * 1024 * 1024;

/** Open the sheet from any button on any page (Bills, Organize, the typed sheet's Shop Stock). */
export function openSnapOrNote() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SNAP_OPEN_EVENT));
}
/** Hand files to the queue (Bills' page-wide drop): every file gets its line, the sheet or not. */
export function snapFiles(files: File[]) {
  if (typeof window !== "undefined" && files?.length) window.dispatchEvent(new CustomEvent(SNAP_FILES_EVENT, { detail: files }));
}
export function closeSnapOrNote() {
  put({ open: false });
}

// ── THE QUEUE ─────────────────────────────────────────────────────────────────────────────────

let queue: { id: number; file: File; jobId?: string | null }[] = [];
let running: Promise<void> | null = null;
let seq = 0;
/** Every line id at or under this belongs to someone who is no longer signed in here: dropped. */
let floor = 0;

function say(id: number, name: string, text: string, tone: SnapTone) {
  if (id <= floor) return;
  const line = { id, name, text, tone };
  put({ lines: store.lines.some((l) => l.id === id) ? store.lines.map((l) => (l.id === id ? line : l)) : [...store.lines, line] });
}
function remember(id: number, paperId: string | null | undefined) {
  if (id <= floor) return;
  if (paperId && !store.papers.includes(paperId)) put({ papers: [paperId, ...store.papers] });
}
const finished = () => put({ version: store.version + 1 });

const ownerOf = (ctx: Extract<SnapContext, { ok: true }>) => `${ctx.userId}:${ctx.orgId}`;

/**
 * THE APP WAS LEFT: forget who was asking and draw nothing until a fresh context answers. The queue
 * keeps running (a file already sent is saved either way); its lines show again for the same person.
 */
function holdTillConfirmed() {
  if (!store.lines.length && !store.papers.length && !store.pending.length && !store.ctx) return;
  put({ held: true, ctx: null, open: false });
}

/**
 * A DIFFERENT PERSON (OR COMPANY) ON THIS DEVICE: everything the last one left goes, lines, cards,
 * waiting photos and files not yet sent, and anything still finishing for them says nothing here.
 */
function forgetEverything() {
  floor = seq;
  queue = [];
  put({ lines: [], papers: [], pending: [], ctx: null, owner: null, held: false });
}

/** Who is asking, asked once and kept (the sheet asks again each time it opens, for the punch). */
async function context(fresh = false): Promise<SnapContext> {
  if (!fresh && !store.held && store.ctx?.ok) return store.ctx;
  let ctx: SnapContext;
  try {
    ctx = await snapContext();
  } catch {
    // A dropped connection says nothing about who is signed in: a held store stays held.
    ctx = { ok: false, error: "No connection just now, so nothing could be sent. Check your signal and try again." };
    put({ ctx: store.held ? null : ctx });
    return ctx;
  }
  if (!ctx.ok) {
    // Signed out, or no seat: nothing of anyone's is shown to whoever holds the device (and what
    // they put in themselves after that still gets its line saying why it went nowhere).
    if (store.owner || store.held) forgetEverything();
    put({ ctx });
    return ctx;
  }
  if (store.owner && store.owner !== ownerOf(ctx)) forgetEverything();
  put({ ctx, owner: ownerOf(ctx), held: false });
  return ctx;
}

/** The line a read paper gets: what was read, where it may go, and that it waits for an answer. */
export function readLine(it: OrganizedResult["item"] | undefined): string {
  if (!it) return "Read. Waiting for your answer on its card.";
  if (it.destination === "note") return "Read: a note with no money on it, kept as a note.";
  if (it.picture) return `Read: a picture (${it.title}). Its card asks what it is.`;
  const total = it.amount != null ? formatCurrency(it.amount) : "no total read";
  const s = it.suggestion;
  const where =
    s?.picked && s.jobLabel
      ? `Picked from the paper: ${s.jobLabel}.`
      : s?.picked && s.bucket
        ? `Picked from the paper: Business Cost, ${s.bucket}.`
        : "Where does it go?";
  return `Read: ${it.vendor ?? it.title}, ${total}. ${where} Waiting for your answer.`;
}

/** The read, on its own route (60 seconds from any page). Never throws: a lost read is a sentence. */
async function readPaper(id: string): Promise<{ ok: true; item?: OrganizedResult["item"] } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/paperwork/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    const body = (await res.json().catch(() => null)) as OrganizedResult | null;
    if (!body) return { ok: false, error: "the reader didn't answer." };
    if (!body.ok) return { ok: false, error: body.error ?? "the reader didn't answer." };
    return { ok: true, item: body.item };
  } catch {
    return { ok: false, error: "the reader didn't answer." };
  }
}

/** A supplier's list or a bank download: rows, read here, then one card. */
async function oneList(id: number, file: File) {
  const name = file.name || "A file with no name";
  say(id, name, "Reading the list…", "busy");
  const read = await readListFile(file);
  if (!read.ok) return say(id, name, `Not added: ${read.error}`, "error");
  let sha: string | null = null;
  try {
    sha = await sha256Hex(await file.arrayBuffer());
  } catch {
    sha = null; // an old browser: the list still goes in, it just can't be matched as the same file
  }
  const added = await addOpenList({ name, sha256: sha, table: read.table, listDate: read.listDate, source: "organize" });
  if (!added.ok) return say(id, name, added.already ? `${added.already} Nothing was added twice.` : (added.error ?? "Not added."), added.already ? "warn" : "error");
  remember(id, added.id);
  say(id, name, added.line ?? "Waiting for your answer on its card.", "ok");
}

/** One file, the office's way: checked, fingerprinted, stored, a row, and read. */
async function oneStaff(id: number, file: File, orgId: string) {
  const name = file.name || "A file with no name";
  const type = (file.type || "").toLowerCase();
  const pdfByName = /\.pdf$/i.test(name);
  const heic = /image\/hei[cf]/.test(type) || /\.(heic|heif)$/i.test(name);
  const isImage = type.startsWith("image/") || heic;
  if (!(type === "application/pdf" || pdfByName || isImage) && isListFile(file)) return oneList(id, file);
  if (!(type === "application/pdf" || pdfByName || isImage))
    return say(id, name, "Not added: Snap Or Note takes PDFs, photos, and a supplier's list or a bank download (Excel, CSV or OFX).", "error");
  if (file.size > MAX_FILE) return say(id, name, "Not added: it is over 15 MB. Save a smaller copy and add it again.", "error");

  say(id, name, "Checking…", "busy");
  const raw = await file.arrayBuffer();
  let sha: string;
  try {
    sha = await sha256Hex(raw);
  } catch {
    return say(id, name, "Not added: this browser couldn't fingerprint it. Try again in Safari or Chrome.", "error");
  }
  const seen = await fingerprintSeen(sha);
  if (seen.seen) return say(id, name, `${seen.seen} Nothing was added twice.`, "warn");

  let upload: File = file;
  let pdfText: string | null = null;
  const isPdf = type === "application/pdf" || (pdfByName && !isImage);
  if (isPdf) {
    // A PDF by what is IN it. A file named .pdf that isn't one is refused by name, not read.
    if (!isPdfBytes(raw)) return say(id, name, "Not added: it is named like a PDF but isn't one inside.", "error");
    const t = await readPdfText(raw, name);
    if (t.ok) pdfText = t.text; // a scan has no text; the reader looks at it as a picture instead
  } else {
    upload = await prepareImageForUpload(file);
    if (/hei[cf]/i.test(upload.type) || (heic && upload === file)) {
      return say(id, name, "Not added: this HEIC photo couldn't be converted on this device. Save it as JPEG and add it again.", "error");
    }
  }

  say(id, name, "Uploading…", "busy");
  const supabase = createClient();
  let safe = (upload.name || name).replace(/[^a-zA-Z0-9._-]/g, "_");
  // The reader knows a stored file's kind by its extension, so the path always carries one.
  if (!/\.(pdf|jpe?g|png|webp|gif)$/i.test(safe))
    safe += isPdf ? ".pdf" : upload.type === "image/png" ? ".png" : upload.type === "image/webp" ? ".webp" : ".jpg";
  const path = `${orgId}/organize/${Date.now()}-${safe}`;
  const { error: upErr } = await supabase.storage.from("documents").upload(path, upload, { upsert: false });
  if (upErr) return say(id, name, `Not added: the upload failed (${upErr.message}). Add it again.`, "error");

  const added = await addPaperwork({ path, name, mime: isPdf ? "application/pdf" : upload.type, size: upload.size, sha256: sha, source: "organize", pdfText });
  if (!added.ok || !added.id) {
    // The row didn't land, so the file must not linger in storage with nothing pointing at it.
    await supabase.storage.from("documents").remove([path]);
    return say(id, name, added.already ? `${added.already} Nothing was added twice.` : (added.error ?? "Not added."), added.already ? "warn" : "error");
  }
  remember(id, added.id);
  if (!added.needsRead) {
    return say(id, name, added.line ?? "Supplier documents found in it. Press Add To Supplier Documents on its card.", added.line?.includes("didn't add up") ? "warn" : "ok");
  }
  say(id, name, "Reading…", "busy");
  // SAVED IS SAVED (audit v994, SI4): the row is in; a reader that never answers is a paper waiting
  // for Read Now on its card, never "Not added".
  const read = await readPaper(added.id);
  if (!read.ok) {
    return say(
      id,
      name,
      read.error === "the reader didn't answer."
        ? "Saved, not read yet: the reader didn't answer. Press Read Now on its card."
        : `Saved, not read: ${read.error}`,
      "warn",
    );
  }
  say(id, name, readLine(read.item), "ok");
}

/** A tech's photo, on the job he picked, for the office. The reader never runs; no amount is said. */
async function oneTechPhoto(id: number, file: File, jobId: string | null | undefined, ctx: Extract<SnapContext, { ok: true }>) {
  const name = file.name || "Photo";
  const job = ctx.jobs.find((j) => j.id === jobId) ?? null;
  if (!jobId || !job) return say(id, name, "Not sent: pick the job it's for first.", "error");
  if (file.size > MAX_FILE) return say(id, name, "Not sent: it is over 15 MB. Take it again.", "error");
  say(id, name, "Sending…", "busy");
  let photo = file;
  if (/image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(name)) {
    photo = await prepareImageForUpload(file);
    if (/hei[cf]/i.test(photo.type) || photo === file)
      return say(id, name, "Not sent: this HEIC photo couldn't be converted on this device. Take it again, or save it as JPEG.", "error");
  }
  let out: Awaited<ReturnType<typeof captureReceipt>>;
  try {
    out = await captureReceipt({ orgId: ctx.orgId, jobId: job.id, file: photo, read: false, category: "Receipt" });
  } catch {
    out = { kind: "lost", tone: "fail", sentence: "" };
  }
  if (out.kind === "lost") {
    // THE PHOTO COMES BACK TO WAIT, and the sentence is his: captureReceipt's own lost sentence
    // sends a person to Add Cost, the office's door he never sees, and a camera photo isn't in his
    // library to pick again. Only the reason is kept (it names no amount: nothing was read).
    const why = out.sentence.split(" — ")[0].trim().replace(/\.$/, "");
    if (id > floor) put({ pending: [...store.pending.filter((x) => x.id !== id), { id, file, name }] });
    const reason = why ? `${why[0].toLowerCase()}${why.slice(1)}` : "the connection dropped";
    return say(id, name, `Not sent: ${reason}. It's waiting above: tap Put It On ${job.label} again when you have a bar or two.`, "error");
  }
  say(id, name, `Filed On ${job.label} For The Office.`, "ok");
}

async function drain() {
  while (queue.length) {
    const next = queue.shift()!;
    try {
      const ctx = await context();
      // Someone else signed in while it waited: it was theirs, and it goes nowhere.
      if (next.id <= floor) continue;
      if (!ctx.ok) say(next.id, next.file.name || "A file", `Not added: ${ctx.error}`, "error");
      else if (ctx.staff) await oneStaff(next.id, next.file, ctx.orgId);
      else await oneTechPhoto(next.id, next.file, next.jobId, ctx);
    } catch (e) {
      say(next.id, next.file.name || "A file", `Not added: ${(e as Error)?.message ?? "something went wrong"}.`, "error");
    }
    finished();
  }
}
function run() {
  if (!running) running = drain().finally(() => (running = null));
  return running;
}

/**
 * TAKE FILES: every file gets its line the moment it arrives, and one loop works through them in
 * order. The office's files go straight in; a tech's photos wait for Which Job? first.
 */
export async function snapTake(files: File[]) {
  if (!files?.length) return;
  const ctx = await context();
  if (ctx.ok && !ctx.staff) {
    const images = files.filter((f) => String(f.type).startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    for (const f of files.filter((x) => !images.includes(x))) say(++seq, f.name || "A file", "Not sent: the office adds files. Take a photo instead.", "error");
    put({ pending: [...store.pending, ...images.map((file) => ({ id: ++seq, file, name: file.name || "Photo" }))] });
    return;
  }
  for (const file of files) {
    const id = ++seq;
    queue.push({ id, file });
    say(id, file.name || "A file with no name", "Waiting…", "busy");
  }
  await run();
}

/** A tech's waiting photo, sent with the job he picked. */
export async function sendTechPhoto(pendingId: number, jobId: string | null) {
  const p = store.pending.find((x) => x.id === pendingId);
  if (!p) return;
  put({ pending: store.pending.filter((x) => x.id !== pendingId) });
  queue.push({ id: p.id, file: p.file, jobId });
  say(p.id, p.name, "Waiting…", "busy");
  await run();
}
export function dropPendingPhoto(pendingId: number) {
  put({ pending: store.pending.filter((x) => x.id !== pendingId) });
}

/**
 * THE READ OF AN OFFICE NOTE THAT IS ALREADY SAVED, on the reader's own route (60 seconds from any
 * page). Never throws: a read that fails or never answers is only ever "Saved, Not Read".
 */
async function readNote(id: string): Promise<boolean> {
  try {
    const res = await fetch("/api/paperwork/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, note: true }) });
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Where a saved note waits: the sheet draws papers' cards, never a note's. */
const NOTE_WAITS = "It waits in Organize under Needs Attention";

/**
 * A NOTE. The office's first goes past the pasted-text router (a supplier's invoices, statement or
 * open list pasted in are imported, not kept as a note); every other note is saved through the one
 * note writer, and read once for the office.
 *
 * SAVED IS SAVED (audit v994, SI4, for notes): the save is its own quick call and the read is a
 * second one. A read that fails, runs out of time or loses signal leaves the note saved and its line
 * says "Saved, Not Read"; the words are never handed back for a second copy. Only a save whose
 * answer never came back is unknown, and the line says exactly that. Answers true when the words are
 * safe (saved, or imported), so the box can let them go.
 */
export async function snapNote(text: string): Promise<boolean> {
  const clean = String(text ?? "").trim();
  if (!clean) return false;
  const id = ++seq;
  const name = clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
  say(id, name, "Saving…", "busy");
  try {
    const ctx = await context();
    if (!ctx.ok) {
      say(id, name, `Not saved: ${ctx.error}`, "error");
      return false;
    }
    let route: PastedTextRoute = { kind: "note" };
    if (ctx.staff) {
      try {
        route = await routePastedText(clean);
      } catch {
        route = { kind: "note" };
      }
      if (route.kind === "imported") {
        say(id, name, route.line, route.ok ? "ok" : "error");
        return route.ok;
      }
    }
    // A pasted supplier paper that wouldn't read is kept as a note, and the line says why.
    const unread = route.kind === "note" && route.unread ? ` It didn't import as a supplier's paper: ${route.unread}` : "";
    let res: Awaited<ReturnType<typeof saveVoiceNote>>;
    try {
      res = await saveVoiceNote(clean);
    } catch {
      // Organize is the office's; a tech is sent to the people who can see it.
      say(
        id,
        name,
        `Couldn't tell whether it saved: the connection dropped before the answer came back. ${ctx.staff ? "Check Organize" : "Ask the office if it came in"} before you save it again; your words are still in the box.`,
        "error",
      );
      return false;
    }
    if (!res.ok || !res.id) {
      say(id, name, `Not saved: ${res.error ?? "the note didn't save."}`, "error");
      return false;
    }
    if (!ctx.staff) {
      say(id, name, "Saved for the office.", "ok");
      return true;
    }
    say(id, name, "Saved. Reading…", "busy");
    const read = await readNote(res.id);
    say(
      id,
      name,
      read ? `Saved as a note and read. ${NOTE_WAITS} with what the read suggests.${unread}` : `Saved, Not Read. ${NOTE_WAITS}.${unread}`,
      read && !unread ? "ok" : "warn",
    );
    return true;
  } catch {
    say(id, name, "Not saved: the connection dropped. Your words are back in the box.", "error");
    return false;
  } finally {
    finished();
  }
}

/** Tests only: start clean, or say who is asking without a server. */
export function resetSnapForTest(ctx: SnapContext | null = null) {
  queue = [];
  running = null;
  seq = 0;
  floor = 0;
  store = { ...START, ctx, owner: ctx?.ok ? ownerOf(ctx) : null };
  listeners.forEach((l) => l());
}
/** Tests only: the + unmounted (the app was left, as a sign-out does) or mounted again. */
export function leaveAppForTest() {
  holdTillConfirmed();
}
export function snapStateForTest() {
  return store;
}
export function openSnapOrNoteForTest() {
  put({ open: true });
}

// ── THE PROVIDER: mounted once, inside the top bar's + ─────────────────────────────────────────

let wired = 0;

/**
 * Listens for the doors (openSnapOrNote, snapFiles), keeps pages in step as files finish, and draws
 * the sheet while it is open. Its own toasts, because the top bar sits outside the page's.
 */
export function SnapOrNoteProvider({ isStaff }: { isStaff: boolean }) {
  const router = useRouter();
  const open = useStore("open");
  const version = useStore("version");
  const [holder, setHolder] = useState(false);

  useEffect(() => {
    // ONE HOLDER: two mounts would read every file twice.
    if (wired > 0) return;
    wired += 1;
    setHolder(true);
    const onOpen = () => {
      put({ open: true });
      void context(true); // who is asking, and the job on the punch, fresh each time
    };
    const onFiles = (e: Event) => {
      const files = (e as CustomEvent<File[]>).detail;
      if (Array.isArray(files) && files.length) void snapTake(files);
    };
    window.addEventListener(SNAP_OPEN_EVENT, onOpen);
    window.addEventListener(SNAP_FILES_EVENT, onFiles);
    // BACK IN THE APP after leaving it (a sign-out and a sign-in): whose lines are these? Nothing
    // is drawn until the answer says the same person, in the same company.
    if (store.held) void context(true);
    return () => {
      wired -= 1;
      // The app was left (the + is gone from every page: /login is outside the app).
      if (wired === 0) holdTillConfirmed();
      setHolder(false);
      window.removeEventListener(SNAP_OPEN_EVENT, onOpen);
      window.removeEventListener(SNAP_FILES_EVENT, onFiles);
    };
  }, []);

  // A FILE OR A NOTE FINISHED: the page under the sheet reads again, so its lists follow.
  const seen = useRef(version);
  useEffect(() => {
    if (version === seen.current) return;
    seen.current = version;
    router.refresh();
  }, [version, router]);

  if (!holder || !open) return null;
  return (
    <ToastProvider>
      <SnapOrNoteSheet isStaff={isStaff} onClose={closeSnapOrNote} />
    </ToastProvider>
  );
}

/** A page's own door to the sheet (Bills' and Organize's headers). */
export function SnapOrNoteButton({ variant = "primary" }: { variant?: "primary" | "outline" }) {
  const busy = useSnapBusy();
  return (
    <Button variant={variant} onClick={openSnapOrNote}>
      {busy ? <Loader2 className="animate-spin" /> : <Camera />} Snap Or Note
    </Button>
  );
}

/** What happened to each file and note, one line each, by name. */
export function SnapLinesList({ lines }: { lines: SnapLine[] }) {
  if (!lines.length) return null;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {lines.map((l) => (
        <li key={l.id} className="flex items-start gap-2 px-3 py-2 text-sm">
          {l.tone === "busy" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-brand" />}
          {l.tone === "ok" && <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />}
          {(l.tone === "warn" || l.tone === "error") && (
            <AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${l.tone === "error" ? "text-red-500" : "text-amber-500"}`} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-slate-800">{l.name}</span>
            <span className={l.tone === "error" ? "text-red-700" : l.tone === "warn" ? "text-amber-800" : "text-slate-600"}>{l.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A phone or a tablet, where Take Photo is the camera app; a desktop gets the in-page camera. */
function touchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    !!window.matchMedia?.("(pointer: coarse)").matches ||
    navigator.maxTouchPoints > 0 ||
    /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent)
  );
}

/**
 * THE SHEET. Take Photo (the camera, one picture: never `multiple` beside `capture`, or iOS opens the
 * library), Choose Files for the office (several at once: PDFs, photos, Excel, CSV, OFX), and a note
 * box with a mic. On a desktop or an iPad the whole sheet is also a drop area. Then each file's line,
 * and each paper's card as soon as it has one.
 */
export function SnapOrNoteSheet({ isStaff, onClose }: { isStaff: boolean; onClose: () => void }) {
  // Nothing of the last person's is drawn until a fresh context says it is still them (held).
  const lines = useSnapLines();
  const held = useStore("held");
  const allPapers = useStore("papers");
  const allPending = useStore("pending");
  const papers = held ? NO_PAPERS : allPapers;
  const pending = held ? NO_PENDING : allPending;
  const ctx = useStore("ctx");
  const version = useStore("version");
  const dragging = useFileDragActive();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [rows, setRows] = useState<SnapRows | null>(null);
  const [rowsAsked, setRowsAsked] = useState(0);
  const [jobFor, setJobFor] = useState<Record<number, string>>({});
  const captureRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dictation = useDictation((heard) => setNote((t) => (t.trim() ? `${t.trim()} ${heard}` : heard)));
  const crew = ctx?.ok && !ctx.staff ? ctx : null;

  // THE OFFICE'S CARDS: the papers this app took, read again whenever one finishes or a card moves.
  useEffect(() => {
    if (!isStaff || !papers.length) {
      setRows(null);
      return;
    }
    let live = true;
    snapPaperRows(papers).then(
      (r) => live && setRows(r),
      () => live && setRows({ ok: false, error: "Couldn't load their cards just now: the connection dropped. They wait in Organize." }),
    );
    return () => {
      live = false;
    };
  }, [isStaff, papers, version, rowsAsked]);

  function take(files: File[]) {
    if (files.length) void snapTake(files);
  }

  function takePhoto() {
    if (touchDevice()) captureRef.current?.click();
    else setShowCamera(true);
  }

  async function saveNote() {
    const text = note.trim();
    if (!text || saving) return;
    setSaving(true);
    setNote("");
    const safe = await snapNote(text);
    setSaving(false);
    // Not saved: the words come back into the box (when he hasn't started another note).
    if (!safe) setNote((cur) => (cur.trim() ? cur : text));
  }

  const done = lines.some((l) => l.tone !== "busy");
  return (
    <>
      {/* Only typed words can be lost by closing: files, lines and a tech's waiting photos live in the
          queue, not in the sheet, and are all still here when it opens again. */}
      <Modal open onClose={onClose} title="Snap Or Note" size="lg" dirty={note.trim().length > 0}>
        <div
          className="relative space-y-3"
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            // EVERY file goes to the queue: one it can't take gets its own line saying so, by name.
            take(Array.from(e.dataTransfer.files ?? []));
          }}
        >
          <div className={`grid gap-2 ${isStaff ? "grid-cols-2" : "grid-cols-1"}`}>
            <Button onClick={takePhoto}>
              <Camera /> Take Photo
            </Button>
            {isStaff && (
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <FileUp /> Choose Files
              </Button>
            )}
          </div>
          {/* One picture from the camera: `capture` and never `multiple` (together iOS opens the library). */}
          <input
            ref={captureRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              take(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {isStaff && (
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={SNAP_ACCEPT}
              className="hidden"
              onChange={(e) => {
                take(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          )}

          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveNote();
            }}
          >
            <Textarea
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                // Enter saves; Shift+Enter is a new line (a pasted supplier invoice keeps its lines).
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void saveNote();
                }
              }}
              enterKeyHint="send"
              // NO maxLength: a browser trims an over-long paste without a word, and this box is
              // the one place a month of pasted supplier invoices goes in (the importer reads them
              // all; the server takes far more than any paste).
              placeholder="Type A Note…"
              aria-label="Type A Note"
              className="max-h-40 min-h-11 flex-1 overflow-y-auto"
            />
            <Button
              type="button"
              size="icon"
              variant={dictation.recording ? "destructive" : "outline"}
              aria-label={dictation.recording ? "Stop Listening" : "Say A Note"}
              title={dictation.recording ? "Stop Listening" : "Say A Note"}
              onClick={() => (dictation.recording ? dictation.stop() : void dictation.start())}
            >
              {dictation.recording ? <Square /> : <Mic />}
            </Button>
            <Button type="submit" disabled={!note.trim() || saving}>
              {saving ? <Loader2 className="animate-spin" /> : null} Save
            </Button>
          </form>
          {dictation.recording && <p className="text-xs font-medium text-red-600">Listening… tap the square to stop.</p>}
          {dictation.transcribing && <p className="text-xs text-slate-500">Writing down what you said…</p>}
          {dictation.error && (
            <p className="text-xs text-red-700" role="alert">
              {dictation.error}
            </p>
          )}
          {isStaff && dragging && (
            <p className="rounded-lg border-2 border-dashed border-brand px-3 py-4 text-center text-sm font-semibold text-brand">Drop Papers Here</p>
          )}
          {ctx && !ctx.ok && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {ctx.error}
            </p>
          )}
          {crew?.jobsError && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
              {crew.jobsError}
            </p>
          )}

          {/* A TECH'S PHOTO ASKS WHICH JOB (his punch's job picked); nothing on it says a price. */}
          {pending.map((p) => {
            const jobs = crew?.jobs ?? [];
            const pick = jobFor[p.id] ?? (crew?.punchJobId && jobs.some((j) => j.id === crew.punchJobId) ? crew.punchJobId : "");
            const job = jobs.find((j) => j.id === pick) ?? null;
            return (
              <div key={p.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
                <p className="text-sm font-medium text-slate-900">Which Job? {p.name}</p>
                {jobs.length ? (
                  <Select
                    aria-label="Which Job?"
                    value={pick}
                    onChange={(e) => setJobFor((m) => ({ ...m, [p.id]: e.target.value }))}
                    className="min-h-11"
                  >
                    <option value="">— Pick The Job —</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.label}
                      </option>
                    ))}
                  </Select>
                ) : !ctx ? (
                  <p className="text-sm text-slate-600" role="status">
                    Loading the jobs…
                  </p>
                ) : crew?.jobsError ? null : (
                  <p className="text-sm text-slate-600">No job is going right now, so this photo can&apos;t go on one. Type a note for the office instead.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!job} onClick={() => void sendTechPhoto(p.id, job?.id ?? null)}>
                    {job ? `Put It On ${job.label}` : "Put It On This Job"}
                  </Button>
                  <Button variant="ghost" onClick={() => dropPendingPhoto(p.id)}>
                    <X /> Don&apos;t Send
                  </Button>
                </div>
              </div>
            );
          })}

          <SnapLinesList lines={lines} />
          {done && (
            <Button variant="outline" onClick={clearFinishedSnapLines}>
              Clear Finished Lines
            </Button>
          )}

          {isStaff && rows && !rows.ok && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
              {rows.error}
            </p>
          )}
          {isStaff && rows?.ok && rows.jobsError && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
              {rows.jobsError}
            </p>
          )}
          {isStaff && rows?.ok && (
            <PaperworkList
              items={rows.items}
              jobs={rows.jobs}
              matches={rows.matches}
              shopStock={rows.shopStock}
              onChange={() => setRowsAsked((n) => n + 1)}
            />
          )}
          {!lines.length && !pending.length && !(rows?.ok && rows.items.length) && (
            <p className="text-sm text-slate-500">
              {isStaff
                ? "Snap a receipt, choose a bill's PDF or a supplier's list, or type a note. Each paper is read and waits here for your answer; a note is read and waits in Organize. Nothing is filed until you tap an answer."
                : "Snap a receipt for the job you're on, or type a note for the office."}
            </p>
          )}
        </div>
      </Modal>
      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setShowCamera(false);
            take([file]);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
    </>
  );
}
