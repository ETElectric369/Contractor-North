"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Landmark, Loader2 } from "lucide-react";
import { sha256Hex } from "@/lib/content-hash";
import { STATEMENT_ACCEPT, readStatementFile } from "@/lib/open-list-file";
import { addOpenList } from "@/app/(app)/bills/open-list-actions";
import { readStatementScan } from "@/app/(app)/bills/statement-scan-actions";

/**
 * DROP A BANK OR SUPPLIER STATEMENT (Erik, 2026-09-27; moved to Reconcile 2026-10-02; the PDF
 * 2026-10-02): one plain line for the month off the bank's website or a supplier's portal — CSV, TSV,
 * a text table, Excel old or new, a bank's OFX/QFX/QBO, AND the PDF a supplier emails, whose pages
 * are read as a table here on the device (readStatementFile → pdf-table.ts). Erik asked for exactly
 * that: "i want to upload my bank statement and supplier statement, every item will either match or
 * need a category."
 *
 * AND A SCAN READS NOW TOO (2026-10-02). His own bank prints a statement whose transaction table is an
 * IMAGE: 125 text marks over three pages, every one of them the back-page legal notice, and July's
 * file has no text at all. A text reader can never get those lines, so a PDF the text lane cannot
 * tabulate goes to the reader that can SEE it (statement-scan-actions.ts) — and code holds what it
 * read against the statement's own printed beginning balance, ending balance and totals before a
 * single line is proposed. A read those figures disagree with is not shown at all; a paper that prints
 * no figures says so on the card. A PDF that is ONE paper is still not turned away into nowhere: the
 * refusal names the + button, which reads a paper.
 *
 * It is the same door as Snap Or Note (addOpenList reads a bank's columns as a bank download and
 * anything else as a supplier's open list); the file is read on this device and only its rows go to
 * the server, which keeps the last 4 of an account and never a long number. It then waits ON THIS
 * PAGE as one card, directly under this line, and nothing is written until a person presses Apply.
 *
 * WHY IT LIVES ON RECONCILE AND NOT ON MONEY. Erik asked twice: "i want to upload my bank statement
 * and supplier statement, every item will either match or need a category", and then, seeing this
 * line on /analytics, "this should be in reconcile too i imagine". Reconcile's law is that it FILLS
 * IN DOTS, it never CONTROLS SYSTEMS — a peace maker. Bringing a paper IN is an intake, not a
 * control, so the door belongs on the page named for the job.
 *
 * AND ANSWERING IT HAPPENS HERE TOO, SINCE 2026-10-03. Erik: "so it still doesnt make sense to me that
 * all this reconcile stuff is on the bills page." The card used to wait on /bills, so this line's one
 * link sent him to another page to finish what he had just started. A document comparing two records
 * is answered where it is dropped; a paper that becomes a cost is still answered on Bills
 * (lib/paperwork answeredOnReconcile). So the words say "below" and the router refresh draws it.
 */
export function BankDropLine() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  /** `waiting`: the statement's own card is on this page now (the refresh below draws it), so the line
   *  says where to look. An "Already In" (applied, or set aside in files) has no card, and says nothing. */
  const [said, setSaid] = useState<{ text: string; ok: boolean; waiting?: boolean } | null>(null);

  async function take(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setSaid(null);
    try {
      const read = await readStatementFile(file);
      if (!read.ok && !("scan" in read)) return setSaid({ text: `Not added: ${read.error}`, ok: false });
      let sha: string | null = null;
      try {
        sha = await sha256Hex(await file.arrayBuffer());
      } catch {
        sha = null;
      }
      // THE PAGES ARE PICTURES, SO A READER LOOKS AT THEM (2026-10-02). The text lane has already had
      // its go, which is the cheap, deterministic, no-model answer and still the first one tried. What
      // comes back is the same bank card a CSV makes: every line with its proposed answer, nothing
      // written until a person presses Apply there — and the server holds the read against the
      // statement's own printed totals before it proposes anything at all.
      if (!read.ok) {
        // NOTHING SILENT, AND NOTHING THAT FEELS BROKEN: a spinner with no words beside it is how a
        // person decides the button doesn't work.
        //
        // AND NOTHING UNTRUE EITHER. This said "There is no text on these pages" for EVERY scan, and
        // the file this lane was built for — his September statement, 125 text marks of back-page
        // legal notice — has text on it; it is the TABLE that is a picture. A claim on screen has to
        // trace to the code (the onboarding-truth law), so `noText` decides which clause is shown.
        // "A few seconds" was untrue too: the careful look is an Opus transcription of a whole
        // statement, which is tens of seconds and more. A wrong duration reads as a hung button.
        setSaid({
          text: read.scan.noText
            ? "There is no text on these pages, so they are being read as pictures. That takes a minute, and a long statement takes a few."
            : "These pages don't read as a table of text, so they are being read as pictures. That takes a minute, and a long statement takes a few.",
          ok: true,
        });
        const got = await readStatementScan({ name: file.name || "Statement", base64: read.scan.base64, pages: read.scan.pages, sha256: sha, listDate: read.scan.listDate });
        if (!got.ok) return setSaid({ text: got.already ? `${got.already} Nothing was added twice.` : (got.error ?? "Not added."), ok: !!got.already });
        setSaid({ text: got.line ?? "Waiting below.", ok: true, waiting: true });
        router.refresh();
        return;
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
      const added = await addOpenList({ name: file.name || "Statement", sha256: sha, table: read.table, heading: read.heading, listDate: read.listDate, source: "bills_drop", pdf: read.pdf });
      if (!added.ok) return setSaid({ text: added.already ? `${added.already} Nothing was added twice.` : (added.error ?? "Not added."), ok: !!added.already });
      setSaid({ text: added.line ?? "Waiting below.", ok: true, waiting: true });
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
            {said.text}
            {said.waiting ? " Its card is right below." : ""}
          </span>
        </p>
      )}
    </div>
  );
}
