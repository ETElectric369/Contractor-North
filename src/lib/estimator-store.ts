import { useSyncExternalStore } from "react";
import type { AgentDraft } from "@/lib/assistant-protocol";

/** A tiny shared store for the live estimate the assistant is building, so the COMPACTED
 *  Estimator (the total + a stop control) can live on the topbar Talk button while the full
 *  panel sits in the chat drawer. The chat writes the draft + speaking state here; the topbar
 *  reads it. Module-level so it survives the chat drawer mounting/unmounting. */
export type EstimatorState = { draft: AgentDraft | null; speaking: boolean; streaming: boolean; listening: boolean };

let state: EstimatorState = { draft: null, speaking: false, streaming: false, listening: false };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const estimatorStore = {
  snapshot: () => state,
  setDraft(d: AgentDraft | null) {
    if (d !== state.draft) {
      state = { ...state, draft: d };
      emit();
    }
  },
  setSpeaking(s: boolean) {
    if (s !== state.speaking) {
      state = { ...state, speaking: s };
      emit();
    }
  },
  setStreaming(s: boolean) {
    if (s !== state.streaming) {
      state = { ...state, streaming: s };
      emit();
    }
  },
  setListening(s: boolean) {
    if (s !== state.listening) {
      state = { ...state, listening: s };
      emit();
    }
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
};

const SERVER_SNAPSHOT: EstimatorState = { draft: null, speaking: false, streaming: false, listening: false };

/** Subscribe a client component to the live estimate (total/items) + speaking state. */
export function useEstimator(): EstimatorState {
  return useSyncExternalStore(estimatorStore.subscribe, estimatorStore.snapshot, () => SERVER_SNAPSHOT);
}

/** The running total of a draft (sum of lines + tax), for the compact pill. */
export function draftTotal(d: AgentDraft | null): number {
  if (!d) return 0;
  const sub = (d.items ?? []).reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
  return sub * (1 + (Number(d.tax_rate) || 0));
}
