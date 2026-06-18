"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
}) {
  // Render via a portal to <body> so the dialog escapes any ancestor stacking
  // context (the glass app-shell) — otherwise its z-index can't beat the fixed
  // bottom nav on iOS and the Save button hides behind it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    lockBodyForModal();
    return () => {
      window.removeEventListener("keydown", onKey);
      unlockBodyForModal();
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const maxW =
    size === "sm" ? "max-w-sm" : size === "md" ? "max-w-md" : size === "xl" ? "max-w-2xl" : "max-w-lg";

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-start justify-center p-3 sm:items-center">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      {/* Cap the panel to the viewport: the HEADER and FOOTER are fixed (shrink-0)
          and only the middle BODY scrolls, so the action row is always reachable
          on a short phone (esp. with the keyboard up). */}
      <div className={`relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full ${maxW} flex-col rounded-2xl bg-white shadow-xl`}>
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-white px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
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
