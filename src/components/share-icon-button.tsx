"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Share, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";

type Payload = { ok: boolean; error?: string; needsSend?: boolean; title?: string; text?: string; url?: string };

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
 * ── THE SHARE SHEET NEEDS THE TAP THAT ASKED FOR IT (Erik, 2026-09-19) ─────────────────────────
 *
 *     "i had to hit the button twice, again, first time marks it sent and the second one opens
 *      up the mac share window"
 *
 * `navigator.share` may only be called while the browser still holds TRANSIENT USER ACTIVATION
 * from the click. A draft used to spend that activation before it got there: a `confirm()` — which
 * WebKit consumes activation on by design — and then a second server round-trip to mark the
 * invoice sent. By the time the sheet was asked for, the tap had expired, so it threw
 * NotAllowedError. And the catch below read every rejection as "the user closed the sheet" and
 * returned in silence, so the first tap marked his invoice SENT and then appeared to do nothing
 * at all. The second tap needed no confirm and no flip, one await fits inside the window, and it
 * worked — which is exactly why it looked like a button that wants pressing twice.
 *
 * So the question moved into a real Modal, and the answer button is a FRESH tap with exactly one
 * await between it and the sheet: the same shape as the second press that has always worked. And
 * a rejection that is not AbortError is no longer swallowed — it falls through to the clipboard,
 * with a sentence, because a share that silently did nothing is the thing being fixed.
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
  load: (opts?: { sendIt?: boolean }) => Promise<Payload>;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<string | null>(null);
  const toast = useToast();
  const router = useRouter();

  /** Hand the payload to the OS, or to the clipboard. Called with the tap still warm. */
  async function handOff(res: Payload) {
    if (!res.ok || !res.url) {
      toast(res.error ?? "Couldn't build the link.", "error");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: res.title, text: res.text, url: res.url });
        return;
      } catch (e) {
        // Closing the sheet without picking anything rejects with AbortError — that is a choice,
        // not a failure, and the only rejection this may pass over in silence. Anything else (a
        // tap that expired on the way here, a platform that refused) falls through to the
        // clipboard, so the link always ends up somewhere he can use it.
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    // Desktop and anything without the share sheet: the whole message, not just the URL, so a
    // paste into an email or a text reads as a sentence rather than a bare link.
    try {
      await navigator.clipboard.writeText(`${res.text} ${res.url}`);
      toast("Copied — paste it into a text or email.", "success");
    } catch {
      toast("Couldn't share that — try Email instead.", "error");
    }
  }

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await load();
      /* A DRAFT ASKS, THEN GOES. The old refusal ("send it first") was a dead end for the exact
         person this button exists for — no email, no number, just a share sheet. Sharing IS
         sending, so one plain-words yes marks it sent and opens the sheet in the same motion —
         but the yes has to be its own tap, or the sheet has no tap left to open on. */
      if (!res.ok && res.needsSend) {
        setAsk(res.error ?? "This is still a draft.");
        return;
      }
      await handOff(res);
    } catch {
      toast("Couldn't share that — try Email instead.", "error");
    } finally {
      setBusy(false);
    }
  }

  /** The second tap, and the only one that spends its activation on the sheet itself. */
  async function sendAndShare() {
    setBusy(true);
    try {
      // EXACTLY ONE AWAIT BETWEEN THE TAP AND THE SHEET. Nothing else goes in here - not closing
      // the modal, which pops a history entry, and not a refresh. Both happen after the OS has
      // the payload, because the browser only holds the tap for a moment and this is what it is
      // being spent on.
      const res = await load({ sendIt: true });
      await handOff(res);
      setAsk(null);
      if (res.ok) router.refresh(); // the page must show Sent, not yesterday's Draft
    } catch {
      toast("Couldn't share that — try Email instead.", "error");
      setAsk(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
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
        {busy && !ask ? <Loader2 className="animate-spin" /> : <Share />}
      </Button>

      <Modal
        open={!!ask}
        onClose={() => setAsk(null)}
        title="Share This Now?"
        footer={
          <ModalActions
            onCancel={() => setAsk(null)}
            onSave={sendAndShare}
            saveLabel="Mark Sent And Share"
            saving={busy}
            cancelLabel="Not Yet"
          />
        }
      >
        <p className="text-sm leading-relaxed text-slate-700">{ask}</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Sharing the link is sending it, so this marks it sent and opens your share sheet in the
          same motion. You can still change it afterwards.
        </p>
      </Modal>
    </>
  );
}
