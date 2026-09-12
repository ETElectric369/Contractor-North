"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Share, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";

/**
 * SHARE A CUSTOMER DOCUMENT — the tiny box-with-arrow at the corner of a document's title.
 *
 * The invoice screen offered Email, Collect Payment, Record Payment and Preview/Print. Nothing
 * for "text this to her" or "AirDrop it", which is how a contractor standing in a driveway
 * actually sends things. So the fallback was the OS share sheet from the PDF preview — and iOS
 * shares the PAGE, not the document: the customer got the app's own marketing description, a
 * link to app.contractornorth.com that shows a login screen, and the PDF. Vendor pitch plus a
 * locked door.
 *
 * The app has to hand the OS a payload instead of letting it scrape one. What goes out is the
 * customer's own token link on the CONTRACTOR'S domain, with the same sentence the SMS sends.
 *
 * `load` is a server action rather than props because the message carries a live balance — a
 * button rendered an hour ago must not text yesterday's number.
 *
 * WHY A TINY ICON, when the 60mph rule says an unlabeled glyph is a guess: this one glyph is
 * the OS's own — the box with the up-arrow every phone already teaches — and it was a full
 * labelled 44px button elbowing through the verb row (Erik 2026-09-11: "everywhere, things
 * like share can be this super tiny box with arrow icon… positioned intuitively"). It keeps
 * aria-label + title so VoiceOver and a mouse hover still say "Share", and Button's icon-sm
 * keeps the 44px finger target under the 32px box. It is a PURE share-sheet trigger: Text and
 * Email stay their own doors, the QR modal keeps its own menu.
 */
export function ShareIconButton({
  load,
  label = "Share",
  className,
}: {
  load: (opts?: { sendIt?: boolean }) => Promise<{ ok: boolean; error?: string; needsSend?: boolean; title?: string; text?: string; url?: string }>;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();

  async function go() {
    if (busy) return;
    setBusy(true);
    let flipped = false;
    try {
      let res = await load();
      /* A DRAFT ASKS, THEN GOES. The old refusal ("send it first") was a dead end for the exact
         person this button exists for — no email, no number, just a share sheet. Sharing IS
         sending, so one plain-words yes marks it sent and opens the sheet in the same motion. */
      if (!res.ok && res.needsSend) {
        const yes = confirm(`${res.error ?? "This is still a draft."}

Mark it sent and share the link now?`);
        if (!yes) return;
        res = await load({ sendIt: true });
        flipped = res.ok; // the page must show Sent, not yesterday's Draft
      }
      if (!res.ok || !res.url) {
        toast(res.error ?? "Couldn't build the link.", "error");
        return;
      }
      const payload = { title: res.title, text: res.text, url: res.url };
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share(payload);
          return; // shared, or the user cancelled — either way we're done
        } catch {
          return; // cancelling the sheet is not an error and must not fall through to a toast
        }
      }
      // Desktop and anything without the share sheet: the whole message, not just the URL, so a
      // paste into an email or a text reads as a sentence rather than a bare link.
      await navigator.clipboard.writeText(`${res.text} ${res.url}`);
      toast("Copied — paste it into a text or email.", "success");
    } catch {
      toast("Couldn't share that — try Email instead.", "error");
    } finally {
      setBusy(false);
      if (flipped) router.refresh();
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={go}
      disabled={busy}
      className={className}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Share />}
    </Button>
  );
}
