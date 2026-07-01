"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Short enough that a surprise teardown mid-typing loses at most a keystroke
// or two; long enough not to serialize on every keypress.
const DEBOUNCE_MS = 400;

/**
 * Session-scoped draft persistence for form state — the safety net for the two
 * ways an open form loses what Erik typed: a deploy's service-worker reload and
 * iOS killing a backgrounded PWA tab. Debounce-mirrors `state` to
 * sessionStorage and rehydrates it on mount, so the half-filled form comes back
 * exactly as it was. This is the client-side generalization of the assistant's
 * server-side AgentDraft pattern.
 *
 *   const [form, setForm] = useState(EMPTY);
 *   const draft = useDraft("invoice-new", form, setForm);
 *   // ...on successful submit:
 *   draft.clear();
 *   if (draft.restored) { ...optionally tell the user their draft came back }
 *
 * `key` must be unique per form — include the entity id when editing (e.g.
 * `"invoice-edit:" + invoice.id`) so two records never share a draft. `state`
 * must be JSON-serializable. sessionStorage (not localStorage) on purpose:
 * drafts survive a reload but not the browser session, so a weeks-old
 * half-typed form can never resurface as a stale surprise.
 */
export function useDraft<T>(key: string, state: T, setState: (t: T) => void) {
  const storageKey = "draft:" + key;
  // True when a draft existed and was rehydrated on mount (callers can toast it).
  const [restored, setRestored] = useState(false);
  const armed = useRef(false); // mirroring starts on the first CHANGE, not on mount
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | null>(null); // serialized state awaiting write
  const setStateRef = useRef(setState);
  setStateRef.current = setState;

  const write = useCallback(() => {
    if (pending.current == null) return;
    try {
      window.sessionStorage.setItem(storageKey, pending.current);
    } catch {
      /* private mode / quota — drafts are best-effort */
    }
    pending.current = null;
  }, [storageKey]);

  // Rehydrate once on mount (client-only — effects never run on the server).
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw != null) {
        setStateRef.current(JSON.parse(raw) as T);
        setRestored(true);
      }
    } catch {
      /* unreadable/corrupt draft — treat as none */
    }
  }, [storageKey]);

  // Debounce-mirror every state change. The mount pass is skipped so merely
  // OPENING a form never plants a pristine "draft" (which would make every
  // subsequent open look like a restore).
  useEffect(() => {
    if (!armed.current) {
      armed.current = true;
      return;
    }
    pending.current = JSON.stringify(state);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(write, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, write]);

  // On unmount, FLUSH (not drop) a still-pending write so the last keystrokes
  // survive a teardown that lands inside the debounce window.
  useEffect(
    () => () => {
      write();
      armed.current = false; // re-arm cleanly (also keeps dev strict-mode honest)
    },
    [write]
  );

  // Call after a successful submit: drops the draft AND cancels the pending
  // write so the just-saved values can't resurrect as a stale draft.
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = null;
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      /* nothing to do — storage unavailable means no draft was kept anyway */
    }
  }, [storageKey]);

  return { restored, clear };
}
