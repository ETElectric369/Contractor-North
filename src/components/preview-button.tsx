"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { useToast } from "@/components/toast";
import { translator } from "@/lib/i18n";
import { pdfPreviewHref, type PreviewedDoc } from "@/lib/pdf-preview-back";
import { savesInFlight, whenSavesSettle } from "@/lib/saves-in-flight";

/**
 * PREVIEW, IN THE HEADER, BESIDE SEND (Erik, 2026-11-10: "lets add a preview button on the top bar
 * next to send on all estimates and invoices converting to pdf so i dont have to search for it").
 *
 * The door is not new, only where it stands. Every invoice and every estimate already opened as its
 * real PDF at /print/pdf-preview (the server's own bytes from /api/pdf, drawn page by page, with
 * Margins, Print and Download PDF in that screen's bar), but the row that went there sat under the
 * ⋯: "Preview / Print" on an invoice, "Print / PDF" on an estimate. Those two rows are gone and this
 * is the one place, so a page has one door to its paper and not a twin of it (the nav doctrine:
 * never a Print twin of a visible button). There is still one way to make the PDF; this only goes
 * to it.
 *
 * THE ADDRESS is byte for byte the one those rows carried, `back=` included: the viewer sits outside
 * the app shell, and on a cold open its Back lands on the page named there. One function writes it
 * (lib/pdf-preview-back pdfPreviewHref), from the same table that Back reads.
 *
 * A LINK, NEVER window.open: the rows it replaces were in-app navigations and so is this, in a
 * browser, in the installed app and in the iOS shell alike. A new window is the trap the viewer's
 * own Print already walked into once (the dialog opened behind the app).
 *
 * THE LOOK is Button's outline variant at its default size, on an <a>: 44px tall, level with Send.
 * The row it sits in wraps; this never shrinks (whitespace-nowrap).
 *
 * IT SHOWS WHAT IS SAVED, SO IT WAITS FOR THE SAVE. Both pages save a box as a person leaves it, and
 * this button is one tap from the box: the tap blurs it, its save goes out, and a link that left in
 * the same instant drew the paper WITHOUT the change just typed. So the tap asks whether a save is on
 * its way (lib/saves-in-flight, the one count the editors feed); with none it is the plain link it
 * always was; with one it says Saving…, waits for the quiet and then goes; and if the save has not
 * landed in twelve seconds it stays and says so — never a paper one edit old, never a stuck button.
 */
const LOOK =
  "btn-gloss inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 transition-colors hover:border-[rgb(var(--glass-ink))]/40 hover:bg-[rgb(var(--glass-tint))]/10 hover:text-[rgb(var(--glass-ink))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--glass-ink))] focus-visible:ring-offset-2";

/** `id` is the SAVED document's. With none yet (an estimate nobody has saved) there is no paper to
 *  open, so nothing is drawn: never a door onto a refusal. */
export function PreviewButton({ doc, id }: { doc: PreviewedDoc; id: string | null | undefined }) {
  const t = translator(useLang());
  const router = useRouter();
  const toast = useToast();
  const [waiting, setWaiting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!id) return null;
  const href = pdfPreviewHref(doc, id);
  return (
    <Link
      href={href}
      className={LOOK}
      aria-busy={waiting || undefined}
      onClick={(e) => {
        if (waiting) {
          e.preventDefault(); // already waiting for that save: one navigation, not two
          return;
        }
        if (savesInFlight() === 0) return; // nothing on its way: the link is a link
        e.preventDefault();
        setWaiting(true);
        void whenSavesSettle().then((settled) => {
          if (!mounted.current) return;
          setWaiting(false);
          if (settled) router.push(href);
          else toast(t("qt_previewStillSaving"), "info");
        });
      }}
    >
      <Eye className="h-4 w-4 shrink-0" /> {waiting ? t("qt_btn_saving") : t("qt_btn_preview")}
    </Link>
  );
}
