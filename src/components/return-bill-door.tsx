"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { CreditMemoDoorView, type CreditMemoDoorState } from "@/components/credit-memo-door";
import { fileReturnBillWithItsBill, returnBillHome, type CreditMemoHomeResult } from "@/app/(app)/organize/credit-memo-actions";
import { ALREADY_FILED } from "@/lib/return-bill-door";

/**
 * FILE WITH ITS BILL ON A CREDIT ALREADY ON A JOB (cn-v1184): the tray door's own view, on the credit's
 * row. The first tap finds what the credit would close on the job's bills and names it on ONE button
 * ("4 lines on T-543, T-576 and T-677"); it files ONLY on that tap (found by words, a hole asks). The
 * server takes the credit's own id, and (cn-v1188) the supplier account and the name the first tap offered
 * when the credit was read under a name that is on no supplier. After filing: the sentence as a sticky toast, the same
 * sentence in place, and the page refreshed. A refusal in red, in place. English: these rows are
 * English today.
 */
export const RETURN_ONE_BY_WORDS = "Its lines match these bills. Tap to file the credit with them.";

/**
 * cn-v1188: THE CREDIT WAS READ UNDER A NAME THAT IS ON NO SUPPLIER, and its lines sit on another
 * supplier's bills on the job. Said BEFORE the tap, because that tap also files the name: both names
 * are in the sentence, and what the tap does to each.
 */
export const joinQuestion = (j: { supplier: string; spelling: string }) =>
  `This credit was read as "${j.spelling}", a name that isn't on a supplier yet. Its lines match bills from ${j.supplier} on this job. Tap to file the credit with them, and to file that name under ${j.supplier} from now on.`;

/** What the server offered, handed back on the tap that files: it files a name only where the person
 *  was shown that supplier AND that name (skeptic #89, S6). */
export const joinShownOf = (home: CreditMemoHomeResult): { accountId: string; spelling: string } | null => {
  const join = home.ok && home.kind === "one" ? home.candidate.join : undefined;
  return join ? { accountId: join.accountId, spelling: join.spelling } : null;
};

/** What the door draws for where the credit's home was found. It never files by itself. */
export function returnHomeStep(home: CreditMemoHomeResult): CreditMemoDoorState {
  if (!home.ok) return { step: "said", words: home.error, tone: "refused" };
  if (home.kind === "none") return { step: "said", words: home.sentence, tone: "plain" };
  if (home.kind === "several") return { step: "pick", candidates: home.candidates, question: RETURN_ONE_BY_WORDS };
  return { step: "pick", candidates: [home.candidate], question: home.candidate.join ? joinQuestion(home.candidate.join) : RETURN_ONE_BY_WORDS };
}

/** What the door draws for the filing's answer: "already filed" is a plain fact (slate), never a
 *  refusal (skeptic #86, S7); any other refusal is red. */
export function fileAnswerStep(r: { ok: boolean; error?: string; message?: string }): CreditMemoDoorState {
  if (!r.ok) {
    const words = r.error ?? "The credit didn't file. Try again.";
    return { step: "said", words, tone: words === ALREADY_FILED ? "plain" : "refused" };
  }
  return { step: "said", words: r.message ?? "Filed with its bill.", tone: "plain" };
}

/** The door, on its own line of the row (the row says the slate line: lib/return-bill-door returnRowLine). */
export function ReturnBillDoorView({
  state,
  busy,
  onFind,
  onPick,
}: {
  state: CreditMemoDoorState;
  busy: boolean;
  onFind: () => void;
  onPick: (billId: string) => void;
}) {
  return (
    <div className="w-full">
      {/* The first tap only searches: "Finding…"; "Filing…" only on the tap that files (S10). */}
      <CreditMemoDoorView state={state} busy={busy} onFind={onFind} onPick={onPick} findingWords="Finding…" filingWords="Filing…" />
    </div>
  );
}

export function ReturnBillDoor({ billId }: { billId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, start] = useTransition();
  const [state, setState] = useState<CreditMemoDoorState>({ step: "idle" });

  // cn-v1188: the supplier and the name the first tap offered, when the credit was read under another name.
  const [shown, setShown] = useState<{ accountId: string; spelling: string } | null>(null);

  const find = () =>
    start(async () => {
      const home = await returnBillHome(billId);
      setShown(joinShownOf(home));
      setState(returnHomeStep(home));
    });

  // The button names what was found; the server is handed the credit, and what it offered.
  const file = () =>
    start(async () => {
      const r = await fileReturnBillWithItsBill(billId, shown);
      setState(fileAnswerStep(r));
      if (!r.ok) {
        // A name may have been filed before the credit was refused: the page is read again (S4).
        if (shown) router.refresh();
        return;
      }
      if (r.message) toast(r.message, "success", undefined, { sticky: true });
      router.refresh();
    });

  return <ReturnBillDoorView state={state} busy={busy} onFind={find} onPick={file} />;
}
