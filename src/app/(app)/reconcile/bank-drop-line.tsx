"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Landmark, Loader2 } from "lucide-react";
import { sha256Hex } from "@/lib/content-hash";
import { STATEMENT_ACCEPT, readStatementFile } from "@/lib/open-list-file";
import { addOpenList } from "@/app/(app)/bills/open-list-actions";

/**
 * DROP A BANK OR SUPPLIER STATEMENT (Erik, 2026-09-27; moved to Reconcile 2026-10-02; the PDF
 * 2026-10-02): one plain line for the month off the bank's website or a supplier's portal — CSV, TSV,
 * a text table, Excel old or new, a bank's OFX/QFX/QBO, AND the PDF a supplier emails, whose pages
 * are read as a table here on the device (readStatementFile → pdf-table.ts). Erik asked for exactly
 * that: "i want to upload my bank statement and supplier statement, every item will either match or
 * need a category."
 *
 * THE ONE PDF THIS STILL CANNOT DO ANYTHING WITH IS A SCAN — no text on its pages at all — and the
 * copy beside the button names it and names the door that can, so nobody finds that out by being
 * turned away. A PDF that is ONE paper is not turned away into nowhere either: the refusal names the
 * + button, which reads a paper.
 *
 * It is the same door as Snap Or Note (addOpenList reads a bank's columns as a bank download and
 * anything else as a supplier's open list); the file is read on this device and only its rows go to
 * the server, which keeps the last 4 of an account and never a long number. It then waits under
 * Needs You on Bills as one card, and nothing is written until a person presses Apply there.
 *
 * WHY IT LIVES ON RECONCILE AND NOT ON MONEY. Erik asked twice: "i want to upload my bank statement
 * and supplier statement, every item will either match or need a category", and then, seeing this
 * line on /analytics, "this should be in reconcile too i imagine". Reconcile's law is that it FILLS
 * IN DOTS, it never CONTROLS SYSTEMS — a peace maker. Bringing a paper IN is an intake, not a
 * control, so the door belongs on the page named for the job; ANSWERING it still happens on the
 * paper's own card under Needs You, which is the one place every paper is answered.
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
      const read = await readStatementFile(file);
      if (!read.ok) return setSaid({ text: `Not added: ${read.error}`, ok: false });
      let sha: string | null = null;
      try {
        sha = await sha256Hex(await file.arrayBuffer());
      } catch {
        sha = null;
      }
      // NO `expect` HERE, AND THAT IS THE POINT. `expect: "bank"` turned a supplier's own open list
      // away at this door, and the two statements Erik names in one breath are what this page is
      // for. addOpenList tells them apart by what is in the file — a bank's columns become a bank
      // download (and only whoever sorts the bank may bring one in, checked on the server), and
      // anything else is read as a supplier's open list.
      //
      // WIDENING THE DOOR DID ADD A PATH, AND THE SERVER CLOSED IT. A bank table the reader could not
      // make a download of used to be kept as a supplier's list — a class of paper the whole office
      // may read, with four of its lines sampled onto the card — so `expect: "bank"` had been the
      // only thing refusing it here. The refusal is now `unreadBankTable` inside addOpenList, where
      // every door gets it, because this door cannot tell the two files apart and nor could the next.
      const added = await addOpenList({ name: file.name || "Statement", sha256: sha, table: read.table, listDate: read.listDate, source: "bills_drop", pdf: read.pdf });
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
      // INSIDE A CARD NOW, NOT A LINE OF ITS OWN ON A PAGE: the old mb-6 left a card's worth of
      // white space between the button and the sentence under it.
      className="mb-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void take(e.dataTransfer?.files?.[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={STATEMENT_ACCEPT}
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
        Drop A Bank Or Supplier Statement
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
