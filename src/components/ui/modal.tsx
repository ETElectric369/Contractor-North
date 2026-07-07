"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { lockBodyForModal, unlockBodyForModal } from "./modal-lock";

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "lg",
  dirty = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Pinned action row. Lives BELOW the scroll area, so the Save button is
   *  always visible — it never scrolls away or hides behind the bottom nav,
   *  even on a short phone with the keyboard up. Use <ModalActions>. */
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Pass the form's "has the user typed anything" flag. While true, a
   *  backdrop tap / Escape / the header X can't close silently: the first
   *  attempt arms an inline "Tap again to discard" notice and only a second
   *  dismissal within a few seconds actually closes — a fat-finger mis-tap on
   *  a phone can't eat a half-filled form. Footer buttons (Cancel/Save) are
   *  caller-owned and bypass the guard. Default (absent) behavior unchanged. */
  dirty?: boolean;
}) {
  // Two-tap discard guard state. Auto-disarms after a beat so a stray first
  // tap doesn't leave the modal permanently one tap away from discarding.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // KEYBOARD FIX: on an installed iOS PWA, 100dvh does NOT shrink when the keyboard
  // opens, so the pinned footer (Save) ends up UNDER the keyboard. The visualViewport
  // API DOES track the keyboard — cap the panel to it so the footer always stays above
  // it. Undefined (no visualViewport) → fall back to the max-h-[100dvh] class.
  const [kbMaxH, setKbMaxH] = useState<string | undefined>(undefined);
  const requestClose = () => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setConfirmDiscard(false), 3000);
      return;
    }
    onClose();
  };
  // Ref so the Escape listener below always sees the CURRENT dirty/armed state
  // without re-binding the listener on every render.
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // Disarm whenever the modal opens or closes — a fresh open starts clean.
  useEffect(() => {
    setConfirmDiscard(false);
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, [open]);

  // Rendered IN-PLACE (not portaled). While open, <body> gets `modal-open`, which
  // hides the fixed mobile bottom nav (globals.css) so it can't cover the Save
  // button. NOTE: do NOT portal this to <body> — many callers wrap the <Modal> in
  // a <form>, and portaling moves the fields + Save button out of that form, so
  // Save silently does nothing. The nav-hide alone fixes the original bug.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestCloseRef.current();
    window.addEventListener("keydown", onKey);
    lockBodyForModal();
    return () => {
      window.removeEventListener("keydown", onKey);
      unlockBodyForModal();
    };
  }, [open]);

  // Track the visual viewport (which shrinks under the keyboard) and cap the panel
  // to it, so the pinned footer sits ABOVE the keyboard instead of under it.
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => setKbMaxH(`${Math.max(200, Math.round(vv.height - 24))}px`);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setKbMaxH(undefined);
    };
  }, [open]);

  if (!open) return null;

  const maxW =
    size === "sm" ? "max-w-sm" : size === "md" ? "max-w-md" : size === "xl" ? "max-w-2xl" : "max-w-lg";

  return (
    // Scroll the WHOLE overlay so a panel taller than the *visible* viewport can never strand its
    // top off-screen: on iOS the keyboard shrinks the visual viewport and scrolls it, and some
    // installed PWAs miscompute 100dvh — either way a tall form (e.g. New Appointment) could run
    // off the top with no way back to the address/time fields. Now the overlay itself scrolls, so
    // the top is always reachable. In the normal case the panel fits, nothing scrolls here, and
    // the header/footer stay pinned via the panel's own flex layout.
    <div className="fixed inset-0 z-[120] overflow-y-auto overscroll-contain">
      <div className="fixed inset-0 bg-slate-900/40" />
      <div onClick={requestClose} className="relative flex min-h-full items-start justify-center p-3 sm:items-center">
        {/* Cap the panel to the viewport: the HEADER and FOOTER are fixed (shrink-0)
            and only the middle BODY scrolls, so the action row is always reachable
            on a short phone (esp. with the keyboard up). stopPropagation so a tap inside
            the panel never bubbles to the backdrop-close on the wrapper. */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={kbMaxH ? { maxHeight: kbMaxH } : undefined}
          className={`relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full ${maxW} flex-col rounded-2xl bg-white shadow-xl`}
        >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button
            onClick={requestClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Armed discard notice — fixed (shrink-0) so it can't scroll away. */}
        {confirmDiscard && (
          <div className="shrink-0 border-b border-amber-100 bg-amber-50 px-6 py-2 text-sm font-medium text-amber-700">
            Tap again to discard what you typed
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-white px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/**
 * The one and only modal action row. Cancel (outline, left) + a primary action
 * (right). Drop it into a Modal's `footer` prop so Save is always pinned and
 * reachable. Single source of truth: change button styling/spacing here once and
 * every modal in the app updates. Also gives the voice agent a stable target —
 * every dialog's primary action is the same named control.
 */
export function ModalActions({
  onCancel,
  onSave,
  saveLabel = "Save",
  cancelLabel = "Cancel",
  saving = false,
  disabled = false,
  destructive = false,
  /** When the modal body is a <form> that submits itself, set submit and give
   *  the <form> an id, then pass that id as formId. The footer lives OUTSIDE the
   *  <form> (it's pinned below the scroll area), so the primary button uses the
   *  HTML `form="<id>"` attribute to submit it from outside. */
  submit = false,
  formId,
  extra,
  hideCancel = false,
}: {
  onCancel: () => void;
  onSave?: () => void;
  saveLabel?: string;
  cancelLabel?: string;
  saving?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  submit?: boolean;
  formId?: string;
  /** Optional extra control rendered at the far left (e.g. a Delete button). */
  extra?: React.ReactNode;
  /** Single-button footer (e.g. an acknowledge "Done") — no Cancel. */
  hideCancel?: boolean;
}) {
  return (
    <>
      {extra && <div className="mr-auto">{extra}</div>}
      {!hideCancel && (
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {cancelLabel}
        </Button>
      )}
      <Button
        type={submit ? "submit" : "button"}
        form={submit ? formId : undefined}
        variant={destructive ? "destructive" : "primary"}
        onClick={submit ? undefined : onSave}
        disabled={saving || disabled}
      >
        {saving ? "Saving…" : saveLabel}
      </Button>
    </>
  );
}
