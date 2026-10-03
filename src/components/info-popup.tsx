"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { Modal } from "@/components/ui/modal";

/**
 * ── ONE LINE ON THE CARD; THE REST BEHIND AN INFO ICON, AS BULLETS (Erik, 2026-10-03) ──────────
 *
 *   "this huge box of text in front of me is hard for me to read and takes up a lot of space on the
 *    screen, valuable space for reconciling, so my idea is in places like this we can have a little
 *    info icon with a popup text box"
 *
 *   "inside the info box that wall of text will be a lot easier to read if its broken into bullet
 *    points"
 *
 * NOTHING IS CUT. Every fact that was in the paragraph is a bullet, one fact each, so the words are
 * still there — they are just not in his way while he is reconciling.
 *
 * IT IS THE REPO'S OWN OVERLAY, NOT A SECOND ONE. `Modal` already handles Escape, the backdrop, the
 * phone's back button, the safe area and a keyboard-reachable Close, and it gives the box a heading a
 * screen reader can say. A fold (`WhyFold`) would have pushed the statement card he is working on down
 * the screen, which is the complaint rather than the cure.
 *
 * THE ICON IS A REAL TARGET: 44px square, a <button> so Tab reaches it and Enter opens it, with an
 * aria-label that names what it explains rather than saying "info".
 */
export function InfoPopup({
  title,
  label,
  bullets,
  className = "",
}: {
  /** The box's own heading, Title Case. */
  title: string;
  /** What a screen reader says, and the tooltip: "About Bringing In A Statement". */
  label: string;
  /** One fact each. Nothing cut. */
  bullets: readonly string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-brand hover:bg-brand/10 ${className}`}
      >
        <Info aria-hidden className="h-5 w-5" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} size="md">
        <InfoBullets bullets={bullets} />
      </Modal>
    </>
  );
}

/**
 * WHAT THE BOX SAYS. Its own component for one reason: a Modal renders nothing until it is opened, and
 * these tests read static markup — so without this there would be no way to prove that every fact
 * really made it into the box, which is the whole promise ("nothing cut").
 */
export function InfoBullets({ bullets }: { bullets: readonly string[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
      {bullets.map((b) => (
        <li key={b}>{b}</li>
      ))}
    </ul>
  );
}
