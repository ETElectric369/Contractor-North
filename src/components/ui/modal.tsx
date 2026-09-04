"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./button";
import { lockBodyForModal, unlockBodyForModal } from "./modal-lock";
import { shouldGuardBack, shouldRemoveEntry } from "./overlay-history";

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "lg",
  dirty = false,
  portal = false,
  historyClose = true,
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
  /** Render the overlay into <body> via a portal. OFF by default (the overlay renders in place —
   *  required for the common `<form><Modal/></form>` pattern where Save submits the wrapping form by
   *  DOM nesting). Turn ON only when the Modal is mounted inside an ancestor with `backdrop-filter`,
   *  `transform`, or `filter` — those make the ancestor the containing block for the modal's
   *  `position:fixed` overlay, trapping + clipping it (e.g. a modal opened from a glass dropdown).
   *  When portaled, a form INSIDE the modal must submit via ModalActions `formId` (the `form=` attr),
   *  not DOM nesting. */
  portal?: boolean;
  /**
   * BACK CLOSES THE OVERLAY, not the page. ON by default — every Modal in the app inherits it.
   *
   * Erik: "this leaving page and back page is really frustrating … integrating interactive overlay
   * anywhere possible". Overlays are the right answer, but an overlay with no history entry makes
   * the problem WORSE on an installed PWA: there is no browser chrome, so a swipe-back or the
   * Android back button leaves the whole screen instead of closing the sheet. The more we build,
   * the more that hurts — so it gets fixed once, here, before the scheduler is built on top of it.
   *
   * `<Tabs urlSync>` already set this precedent in this codebase; this is the same idea for
   * overlays. Turn it OFF only for an overlay that is genuinely not a "place" — a transient toast
   * or an inline confirm that back should ignore.
   */
  historyClose?: boolean;
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
  // Anchor the overlay to the VISUAL viewport, not the layout viewport. On iOS the keyboard pans
  // the visual viewport DOWN (offsetTop grows) to lift a focused bottom field above the keyboard —
  // which shoves a `fixed inset-0` overlay off the top of the screen (the "address field pushes the
  // whole form off-screen" bug). Tracking vv geometry keeps the overlay pinned inside the visible
  // slice. Undefined off-iOS (no visualViewport) → the overlay falls back to `fixed inset-0`.
  const [vvRect, setVvRect] = useState<CSSProperties | undefined>(undefined);
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
  // Backdrop dismissal must START on the backdrop. A drag that begins INSIDE the
  // panel (selecting text in an input) and releases outside fires the click on the
  // WRAPPER (the DOM common ancestor) — the panel's stopPropagation never runs, so
  // the old bare onClick closed the window mid-use and ate the half-filled form
  // (the desktop "shuts the window" report). Track where the pointer went down and
  // only treat a click as a backdrop tap when it both started AND landed there.
  const downOnBackdrop = useRef(false);

  /**
   * A HISTORY ENTRY, SO THE SYSTEM BACK GESTURE CLOSES THIS AND NOT THE PAGE.
   *
   * Three cases have to stay separate or this eats navigation:
   *
   *  · CLOSED BY BACK — popstate fires. We must NOT then call history.back() again in cleanup,
   *    or we go back twice and leave the page anyway. `poppedRef` is that flag.
   *  · CLOSED BY A BUTTON (Cancel / X / Escape / backdrop) — our entry is still on the stack, so
   *    cleanup removes it. Otherwise the user's next back would "close" an already-closed modal
   *    and appear to do nothing.
   *  · CLOSED BY NAVIGATING AWAY (a link inside the modal) — cleanup runs too, and calling
   *    history.back() here would UNDO the navigation the user just asked for. Guarded by checking
   *    that our marker is still the CURRENT history state; once another page pushes its own, it
   *    isn't, and we leave the stack alone.
   *
   * DIRTY FORMS GET THE SAME TWO-TAP GUARD as every other dismissal: the first back re-pushes the
   * entry and arms "Tap again to discard", so a second back is what actually discards. Back
   * behaves exactly like tapping the backdrop twice, which is the point — one rule, not two.
   */
  const poppedRef = useRef(false);
  const pushedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const guardRef = useRef({ dirty, confirmDiscard });
  guardRef.current = { dirty, confirmDiscard };

  useEffect(() => {
    if (!open || !historyClose || typeof window === "undefined") return;
    poppedRef.current = false;
    const mark = () => window.history.pushState({ ...window.history.state, cnOverlay: true }, "");
    mark();
    pushedRef.current = true;

    const onPop = () => {
      if (shouldGuardBack(guardRef.current)) {
        // Put the entry back so the user is still "inside" the overlay, and arm the notice.
        mark();
        requestCloseRef.current();
        return;
      }
      poppedRef.current = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const stillOurs = !!(window.history.state && (window.history.state as { cnOverlay?: boolean }).cnOverlay);
      if (shouldRemoveEntry({ pushed: pushedRef.current, popped: poppedRef.current, stillOurs })) {
        window.history.back();
      }
      pushedRef.current = false;
    };
  }, [open, historyClose]);

  // Disarm whenever the modal opens or closes — a fresh open starts clean.
  useEffect(() => {
    setConfirmDiscard(false);
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, [open]);

  // Rendered IN-PLACE BY DEFAULT (opt into portaling via the `portal` prop — see its
  // docs above). While open, <body> gets `modal-open`, which hides the fixed mobile
  // bottom nav (globals.css) so it can't cover the Save button. Default in-place is
  // deliberate: many callers wrap the <Modal> in a <form>, and portaling to <body> moves
  // the fields + Save button out of that form, so Save silently does nothing — those
  // callers must leave `portal` off. Turn it ON only for a modal opened inside a
  // backdrop-filter/transform ancestor (which would otherwise clip the fixed overlay),
  // and then submit via ModalActions `formId` rather than DOM nesting. The nav-hide (and
  // so the body.modal-open flag other menus watch) runs in EITHER mode.
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

  // Follow the visual viewport (position the overlay) AND cap the panel to it. On iOS the keyboard
  // pans the visual viewport down rather than shrinking the layout viewport, so a `fixed inset-0`
  // overlay drifts off the top when a bottom field is focused. Update on BOTH resize AND scroll —
  // the pan arrives as scroll events, not just resize — rAF-throttled to avoid keyboard-animation
  // thrash. The panel cap (kbMaxH) still keeps the footer above the keyboard.
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Keyboard closed → viewport is full-height again; clamp any residual offset (an iOS
        // WebKit quirk can leave offsetTop stuck briefly after the keyboard dismisses).
        const kbClosed = vv.height >= window.innerHeight - 1;
        setVvRect({
          position: "fixed",
          top: kbClosed ? 0 : vv.offsetTop,
          left: kbClosed ? 0 : vv.offsetLeft,
          width: vv.width,
          height: vv.height,
        });
        setKbMaxH(`${Math.max(200, Math.round(vv.height - 24))}px`);
      });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setVvRect(undefined);
      setKbMaxH(undefined);
    };
  }, [open]);

  if (!open) return null;

  const maxW =
    size === "sm" ? "max-w-sm" : size === "md" ? "max-w-md" : size === "xl" ? "max-w-2xl" : "max-w-lg";

  const overlay = (
    // Scroll the WHOLE overlay so a panel taller than the *visible* viewport can never strand its
    // top off-screen: on iOS the keyboard shrinks the visual viewport and scrolls it, and some
    // installed PWAs miscompute 100dvh — either way a tall form (e.g. New Appointment) could run
    // off the top with no way back to the address/time fields. Now the overlay itself scrolls, so
    // the top is always reachable. In the normal case the panel fits, nothing scrolls here, and
    // the header/footer stay pinned via the panel's own flex layout.
    <div
      style={vvRect}
      className={`z-[120] overflow-y-auto overscroll-contain ${vvRect ? "" : "fixed inset-0"}`}
    >
      <div className="fixed inset-0 bg-slate-900/40" />
      <div
        onPointerDown={(e) => {
          downOnBackdrop.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          const startedHere = downOnBackdrop.current;
          downOnBackdrop.current = false;
          if (startedHere && e.target === e.currentTarget) requestClose();
        }}
        className="relative flex min-h-full items-start justify-center px-3 pb-3 pt-[max(0.75rem,var(--sat,0px))] sm:items-center"
      >
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

  // Portal to <body> to escape a backdrop-filter/transform ancestor's containing-block trap.
  // Only in the browser (createPortal needs a real document); off-portal renders in place as before.
  return portal && typeof document !== "undefined" ? createPortal(overlay, document.body) : overlay;
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
