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
 * server takes only the credit's own id. After filing: the sentence as a sticky toast, the same
 * sentence in place, and the page refreshed. A refusal in red, in place. English: these rows are
 * English today.
 */
export const RETURN_ONE_BY_WORDS = "Its lines match these bills. Tap to file the credit with them.";

/** What the door draws for where the credit's home was found. It never files by itself. */
export function returnHomeStep(home: CreditMemoHomeResult): CreditMemoDoorState {
  if (!home.ok) return { step: "said", words: home.error, tone: "refused" };
  if (home.kind === "none") return { step: "said", words: home.sentence, tone: "plain" };
  if (home.kind === "several") return { step: "pick", candidates: home.candidates, question: RETURN_ONE_BY_WORDS };
  return { step: "pick", candidates: [home.candidate], question: RETURN_ONE_BY_WORDS };
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

  const find = () =>
    start(async () => {
      setState(returnHomeStep(await returnBillHome(billId)));
    });

  // The button names what was found; the credit is the only thing the server is handed.
  const file = () =>
    start(async () => {
      const r = await fileReturnBillWithItsBill(billId);
      setState(fileAnswerStep(r));
      if (!r.ok) return;
      if (r.message) toast(r.message, "success", undefined, { sticky: true });
      router.refresh();
    });

  return <ReturnBillDoorView state={state} busy={busy} onFind={find} onPick={file} />;
}
