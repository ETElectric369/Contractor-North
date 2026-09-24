"use client";

import { createContext, useContext, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useFileDragActive } from "@/components/drop-target";
import { PaperworkList, type PaperRowItem } from "@/components/paperwork-row";
import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { sha256Hex } from "@/lib/content-hash";
import { isPdfBytes, readPdfText } from "@/lib/pdf-text";
import type { NumberMatch } from "@/lib/paperwork";
import { readPaperworkItem } from "@/app/(app)/organize/actions";
import { addPaperwork, fingerprintSeen } from "@/app/(app)/organize/paperwork-actions";

/**
 * DROP PAPERWORK (Justin, 2026-09-24 14:14: "drop PDF/JPEG/PNG onto Bills & Purchasing and have it
 * parsed"; dropbox plan, Phase 1).
 *
 * Any number of PDFs and photos at once: dragged anywhere onto the page on a desktop or an iPad,
 * or picked with the button (on a phone the picker offers Photo Library, Take Photo and Files, and
 * the share sheet hands files to the same picker). Each one gets ONE line that moves through
 * checking, reading and waiting, and every file is accounted for by name: read, already in,
 * refused and why. Nothing is filed here. Each paper waits in Sort These below with what was read,
 * and becomes money only when a person presses File It.
 *
 * Per file, in this order, because each step is cheaper than the next:
 *   1. the kind of file (PDF, JPEG, PNG; a HEIC this device can't convert is refused by name);
 *   2. the fingerprint of its ORIGINAL bytes, and "Already In" if this exact file is here, before
 *      anything is uploaded;
 *   3. a PDF's own text layer, read in the browser: CED documents in it go on the CED list, which
 *      is what they are, and never through a language model;
 *   4. upload, the row, and only then the reader.
 */

const MAX_FILE = 15 * 1024 * 1024;
const STRIPES = {
  backgroundImage:
    "repeating-linear-gradient(45deg, transparent 0 10px, color-mix(in srgb, var(--color-brand) 10%, transparent) 10px 20px)",
} as const;
const ACCEPT = "application/pdf,.pdf,image/*,.heic,.heif";

type Tone = "busy" | "ok" | "warn" | "error";
type Line = { id: number; name: string; text: string; tone: Tone };

type DropApi = { pick: () => void; take: (files: File[]) => void; busy: boolean; lines: Line[]; clear: () => void };
const DropCtx = createContext<DropApi | null>(null);

function useDrop(): DropApi {
  const api = useContext(DropCtx);
  if (!api) throw new Error("Drop Paperwork used outside its zone.");
  return api;
}

export function PaperworkDropZone({ orgId, children }: { orgId: string; children: React.ReactNode }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  // THE QUEUE (job-cost-capture's rule): every file gets its line the moment it arrives, and one
  // loop reads them in order, so a drop in the middle of a read is never discarded.
  const queue = useRef<{ id: number; file: File }[]>([]);
  const running = useRef(false);
  const seq = useRef(0);
  const dragging = useFileDragActive();

  const say = (id: number, name: string, text: string, tone: Tone) =>
    setLines((ls) => {
      const next = ls.some((l) => l.id === id) ? ls.map((l) => (l.id === id ? { id, name, text, tone } : l)) : [...ls, { id, name, text, tone }];
      return next;
    });

  async function one(id: number, file: File) {
    const name = file.name || "A file with no name";
    const type = (file.type || "").toLowerCase();
    const pdfByName = /\.pdf$/i.test(name);
    const heic = /image\/hei[cf]/.test(type) || /\.(heic|heif)$/i.test(name);
    const isImage = type.startsWith("image/") || heic;
    if (!(type === "application/pdf" || pdfByName || isImage)) {
      return say(id, name, "Not added: this takes PDFs, JPEGs and PNGs.", "error");
    }
    if (file.size > MAX_FILE) return say(id, name, "Not added: it is over 15 MB. Save a smaller copy and drop it again.", "error");

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
        return say(id, name, "Not added: this HEIC photo couldn't be converted on this device. Save it as JPEG and drop it again.", "error");
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
    if (upErr) return say(id, name, `Not added: the upload failed (${upErr.message}). Drop it again.`, "error");

    const added = await addPaperwork({
      path,
      name,
      mime: isPdf ? "application/pdf" : upload.type,
      size: upload.size,
      sha256: sha,
      source: "bills_drop",
      pdfText,
    });
    if (!added.ok || !added.id) {
      // The row didn't land, so the file must not linger in storage with nothing pointing at it.
      await supabase.storage.from("documents").remove([path]);
      return say(id, name, added.already ? `${added.already} Nothing was added twice.` : added.error ?? "Not added.", added.already ? "warn" : "error");
    }
    if (!added.needsRead) {
      say(id, name, added.line ?? "CED documents found in it. Waiting below: press Add To CED Documents.", added.line?.includes("didn't add up") ? "warn" : "ok");
      return;
    }
    say(id, name, "Reading…", "busy");
    const read = await readPaperworkItem(added.id);
    if (!read.ok) return say(id, name, `Saved, not read: ${read.error ?? "the reader didn't answer"} It is waiting below.`, "warn");
    const it = read.item;
    const total = it?.amount != null ? `$${it.amount.toFixed(2)}` : "no total read";
    say(id, name, `Read: ${it?.vendor ?? it?.title ?? "paper"}, ${total}. Waiting below for File It.`, "ok");
  }

  async function drain() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      while (queue.current.length) {
        const next = queue.current.shift()!;
        try {
          await one(next.id, next.file);
        } catch (e) {
          say(next.id, next.file.name, `Not added: ${(e as Error)?.message ?? "something went wrong"}.`, "error");
        }
        router.refresh();
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function take(files: File[]) {
    if (!files.length) return;
    for (const file of files) {
      const id = ++seq.current;
      queue.current.push({ id, file });
      say(id, file.name || "A file with no name", "Waiting…", "busy");
    }
    void drain();
  }

  const api: DropApi = {
    pick: () => inputRef.current?.click(),
    take,
    busy,
    lines,
    clear: () => setLines((ls) => ls.filter((l) => l.tone === "busy")),
  };

  return (
    <DropCtx.Provider value={api}>
      {/* No capture attribute, so iOS offers Photo Library, Take Photo AND Choose Files. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          take(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {children}
      {/* PAGE-WIDE, AND FIXED TO THE SCREEN. A wrapper zone the height of this page put its label
          halfway down a long list, off screen. This covers the viewport while a file is dragged
          anywhere over the window, and hands EVERY file to the same queue as the button: nothing
          is filtered out here, so a file this can't take gets its own line saying so by name
          instead of vanishing (the mixed-drop rule). No stopPropagation, so the window's own drop
          listener still clears the drag state. */}
      {dragging && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center border-4 border-dashed border-brand bg-white/90 p-4"
          style={STRIPES}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            take(Array.from(e.dataTransfer?.files ?? []));
          }}
        >
          <span className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-brand shadow">Drop Paperwork Here</span>
        </div>
      )}
    </DropCtx.Provider>
  );
}

/** The header button: the way in on a phone, where nothing can be dragged. */
export function DropPaperworkButton() {
  const { pick, busy } = useDrop();
  return (
    <Button onClick={pick}>
      {busy ? <Loader2 className="animate-spin" /> : <FileUp />} Drop Paperwork
    </Button>
  );
}

/** What happened to each file, then every paper waiting for File It. */
export function SortThese({
  items,
  jobs,
  matches,
}: {
  items: PaperRowItem[];
  jobs: { id: string; job_number: string; name: string }[];
  matches: Record<string, NumberMatch[]>;
}) {
  const { lines, clear, pick } = useDrop();
  if (!items.length && !lines.length) return null;
  const done = lines.some((l) => l.tone !== "busy");
  return (
    <Card className="mb-6 p-4" id="sort-these">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold text-slate-900">
          Sort These{items.length ? ` (${items.length})` : ""}
        </h2>
        <Button variant="outline" onClick={pick}>
          <FileUp /> Add More
        </Button>
      </div>
      {lines.length > 0 && (
        <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
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
      )}
      {done && (
        <div className="mb-3">
          <Button variant="outline" onClick={clear}>
            Clear Finished Lines
          </Button>
        </div>
      )}
      <p className="mb-3 text-sm text-slate-600">
        Nothing here is filed until you press File It. Pick a job or a business cost for each one; Undo takes it back. The same
        file is never filed twice, and a number already on the books offers to tie them together instead of making a second bill.
      </p>
      <PaperworkList
        items={items}
        jobs={jobs}
        matches={matches}
        empty={<p className="py-4 text-center text-sm text-slate-400">Everything dropped here is sorted.</p>}
      />
    </Card>
  );
}
