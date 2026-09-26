"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readPdfText } from "@/lib/pdf-text";
import { importCedInvoices } from "./supplier-import-actions";

/** How much PDF one import sends with its text. Under the 22 MB server-action ceiling, with room. */
const PDF_BUDGET = 16 * 1024 * 1024;

/**
 * THE CED CARD TAKES THE PDFs THEMSELVES (dropbox plan, Phase 0).
 *
 * The card used to say "open the document, select all, paste". Billtrust hands him PDFs, so this
 * reads their text in the browser (lib/pdf-text) and posts it to the same importer the paste box
 * uses, with every one of its rules: each document checked against its own arithmetic, a
 * re-import changes nothing, a job a person set is never touched. The documents land when he
 * picks them, exactly as the paste door does today, and the sentence below says what landed.
 *
 * The bytes ride along too: the importer stores each PDF once (lib/ced-pdf-store), so Open Bill on
 * a supplier bill card can open the paper itself, not only the lines read off it.
 */
export function CedPdfPicker() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  async function take(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setSaid(null);
    const read: { name: string; text: string; pdf?: Uint8Array }[] = [];
    const unread: string[] = [];
    // One import carries at most this much PDF (the server takes 22 MB a request). Past it, the
    // documents still land; those PDFs are named below so he can choose them again to keep them.
    let budget = PDF_BUDGET;
    const tooMany: string[] = [];
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      // readPdfText reads a copy, so these bytes are still whole: the importer keeps the PDF
      // itself (once per file, by content), so Open Bill can open it.
      const r = await readPdfText(bytes, file.name);
      if (!r.ok) {
        unread.push(r.error);
        continue;
      }
      if (bytes.byteLength <= budget) {
        budget -= bytes.byteLength;
        read.push({ name: file.name, text: r.text, pdf: new Uint8Array(bytes) });
      } else {
        tooMany.push(file.name);
        read.push({ name: file.name, text: r.text });
      }
    }
    if (tooMany.length) {
      unread.push(
        `Too much PDF for one go, so these were read but not kept: ${tooMany.join(", ")}. Choose ${tooMany.length === 1 ? "it" : "them"} again to keep the PDF.`,
      );
    }
    if (!read.length) {
      setBusy(false);
      setSaid({ ok: false, text: `Nothing was imported. ${unread.join(" ")}` });
      return;
    }
    const result = await importCedInvoices({ files: read });
    setBusy(false);
    const head = result.ok ? result.message ?? "Imported." : result.error ?? "Nothing was imported.";
    setSaid({ ok: result.ok, text: [head, ...unread].join(" ") });
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          void take(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <Button onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <FileText />} {busy ? "Reading The PDFs…" : "Choose CED PDFs"}
      </Button>
      {said && (
        <p
          className={`rounded-lg px-3 py-2 text-sm ${said.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}
          role={said.ok ? "status" : "alert"}
        >
          {said.text}
        </p>
      )}
    </div>
  );
}
