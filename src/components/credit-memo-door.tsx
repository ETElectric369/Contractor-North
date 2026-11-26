"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { CREDIT_MEMO_DOOR } from "@/lib/paperwork";
import {
  creditMemoHome,
  fileCreditMemoWithItsBill,
  type CreditMemoCandidate,
  type CreditMemoHomeResult,
} from "@/app/(app)/organize/credit-memo-actions";

/**
 * A CREDIT MEMO'S ONE DOOR IN THE TRAY: File With Its Bill (cn-v1181). One press finds the purchase
 * the memo reverses: the one its own printed reversal names, and it files at once and says where; one
 * found by its lines' words, and it names that bill on a button and files on that tap (a hole asks, it
 * never guesses: skeptic #84, M7); several, and it asks which (each a
 * 44px button naming the bill as bills are named elsewhere); none, and it says so in one sentence
 * (Fix Details can still file it on a job, as before). English: the tray row is English today.
 */
export type CreditMemoDoorState =
  | { step: "idle" }
  | { step: "pick"; candidates: CreditMemoCandidate[]; question?: string }
  | { step: "said"; words: string; tone: "plain" | "refused" };

const WHICH_BILL = "Which bill does this credit memo reverse?";
export const ONE_BY_WORDS = "Its lines match this bill. Tap it to file the memo there.";

/**
 * WHAT THE DOOR DOES WITH WHERE THE MEMO'S HOME WAS FOUND: file at once only when the paper's own
 * reversed number named the bill; anything found by words is put to a person on a button.
 */
export function homeStep(home: CreditMemoHomeResult): { file: string } | CreditMemoDoorState {
  if (!home.ok) return { step: "said", words: home.error, tone: "refused" };
  if (home.kind === "none") return { step: "said", words: home.sentence, tone: "plain" };
  if (home.kind === "several") return { step: "pick", candidates: home.candidates };
  if (home.by === "number") return { file: home.candidate.billId };
  return { step: "pick", candidates: [home.candidate], question: ONE_BY_WORDS };
}

export function CreditMemoDoorView({
  state,
  busy,
  onFind,
  onPick,
  findingWords = "Filing…",
  filingWords,
}: {
  state: CreditMemoDoorState;
  busy: boolean;
  onFind: () => void;
  onPick: (billId: string) => void;
  /** What the first button says while busy. The tray's first tap may file at once, so "Filing…";
   *  a door whose first tap only searches passes "Finding…" (cn-v1184 fixer, skeptic #86 S10). */
  findingWords?: string;
  /** What a found bill's button says while it files; unset keeps the bill's label (the tray). */
  filingWords?: string;
}) {
  return (
    <div className="mt-2 space-y-2">
      {state.step !== "pick" && (
        <button
          type="button"
          onClick={onFind}
          disabled={busy}
          className="h-11 min-w-[44px] rounded-lg bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? findingWords : CREDIT_MEMO_DOOR}
        </button>
      )}
      {state.step === "pick" && (
        <div className="space-y-2">
          <p className="text-sm text-slate-700">{state.question ?? WHICH_BILL}</p>
          {state.candidates.map((c) => (
            <button
              key={c.billId}
              type="button"
              onClick={() => onPick(c.billId)}
              disabled={busy}
              className="block min-h-[44px] w-full rounded-lg border border-slate-300 px-3 py-2 text-left text-sm text-slate-900 disabled:opacity-60"
            >
              {busy && filingWords ? filingWords : c.label}
            </button>
          ))}
        </div>
      )}
      {state.step === "said" && (
        <p role="status" className={`text-sm ${state.tone === "refused" ? "text-red-700" : "text-slate-700"}`}>
          {state.words}
        </p>
      )}
    </div>
  );
}

export function CreditMemoDoor({ itemId }: { itemId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, start] = useTransition();
  const [state, setState] = useState<CreditMemoDoorState>({ step: "idle" });

  const file = (billId: string) =>
    start(async () => {
      const r = await fileCreditMemoWithItsBill(itemId, billId);
      if (!r.ok) {
        setState({ step: "said", words: r.error ?? "The memo didn't file. Try again.", tone: "refused" });
        return;
      }
      if (r.message) toast(r.message, "success", undefined, { sticky: true });
      setState({ step: "said", words: r.message ?? "Filed with its bill.", tone: "plain" });
      router.refresh(); // kept: the paper row also opens on Reconcile and in Snap or Note on any page, which this action does not revalidate
    });

  const find = () =>
    start(async () => {
      const home = await creditMemoHome(itemId);
      const next = homeStep(home);
      if (!("file" in next)) return setState(next);
      const r = await fileCreditMemoWithItsBill(itemId, next.file);
      if (!r.ok) return setState({ step: "said", words: r.error ?? "The memo didn't file. Try again.", tone: "refused" });
      if (r.message) toast(r.message, "success", undefined, { sticky: true });
      setState({ step: "said", words: r.message ?? "Filed with its bill.", tone: "plain" });
      router.refresh(); // kept: the paper row also opens on Reconcile and in Snap or Note on any page, which this action does not revalidate
    });

  return <CreditMemoDoorView state={state} busy={busy} onFind={find} onPick={file} />;
}
