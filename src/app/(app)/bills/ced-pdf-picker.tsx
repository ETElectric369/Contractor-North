"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readPdfText } from "@/lib/pdf-text";
import { importCedInvoices } from "./supplier-import-actions";

/**
 * THE CED CARD TAKES THE PDFs THEMSELVES (dropbox plan, Phase 0).
 *
 * The card used to say "open the document, select all, paste". Billtrust hands him PDFs, so this
 * reads their text in the browser (lib/pdf-text) and posts it to the same importer the paste box
 * uses, with every one of its rules: each document checked against its own arithmetic, a
 * re-import changes nothing, a job a person set is never touched. The documents land when he
 * picks them, exactly as the paste door does today, and the sentence below says what landed.
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
    const read: { name: string; text: string }[] = [];
    const unread: string[] = [];
    for (const file of files) {
      const r = await readPdfText(await file.arrayBuffer(), file.name);
      if (r.ok) read.push({ name: file.name, text: r.text });
      else unread.push(r.error);
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
