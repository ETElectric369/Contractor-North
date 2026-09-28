"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Landmark, Loader2 } from "lucide-react";
import { sha256Hex } from "@/lib/content-hash";
import { LIST_ACCEPT, readListFile } from "@/lib/open-list-file";
import { addOpenList } from "@/app/(app)/bills/open-list-actions";

/**
 * DROP YOUR BANK DOWNLOAD (Erik, 2026-09-27): one plain line on Money, for the monthly export from
 * the bank's website (CSV, Excel old or new, OFX/QFX). It is the same door as Snap Or Note (addOpenList
 * recognises a bank's columns); the file is read on this device and only its rows go to the server,
 * which keeps the last 4 of the account and never a long number. The download then waits under Needs
 * You on Bills as one card. Nothing is written until a person presses Apply there.
 */
export function BankDropLine() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  /** `waiting`: the download is under Needs You on Bills now, so the link there leads somewhere. An
   *  "Already In" (applied, or set aside in files) is not there, and gets no link. */
  const [said, setSaid] = useState<{ text: string; ok: boolean; waiting?: boolean } | null>(null);

  async function take(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setSaid(null);
    try {
      const read = await readListFile(file);
      if (!read.ok) return setSaid({ text: `Not added: ${read.error}`, ok: false });
      let sha: string | null = null;
      try {
        sha = await sha256Hex(await file.arrayBuffer());
      } catch {
        sha = null;
      }
      const added = await addOpenList({ name: file.name || "Bank download", sha256: sha, table: read.table, listDate: read.listDate, source: "bills_drop", expect: "bank" });
      if (!added.ok) return setSaid({ text: added.already ? `${added.already} Nothing was added twice.` : (added.error ?? "Not added."), ok: !!added.already });
      setSaid({ text: (added.line ?? "Waiting under Needs You on Bills.").replace("Waiting below", "Waiting under Needs You on Bills"), ok: true, waiting: true });
      router.refresh();
    } catch (e) {
      setSaid({ text: `Not added: ${(e as Error)?.message ?? "something went wrong"}.`, ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-6"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void take(e.dataTransfer?.files?.[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={LIST_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-white px-4 text-left text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand" /> : <Landmark className="h-4 w-4 shrink-0 text-brand" />}
        Drop Your Bank Download
      </button>
      {said && (
        <p className={`mt-2 flex items-start gap-2 text-sm ${said.ok ? "text-slate-700" : "text-red-700"}`} role={said.ok ? "status" : "alert"}>
          {said.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>
            {said.text}{" "}
            {said.waiting && (
              <Link href="/bills#sort-these" className="inline-flex min-h-11 items-center font-medium text-brand underline">
                Open Needs You On Bills
              </Link>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
