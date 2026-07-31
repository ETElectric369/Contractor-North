"use client";

import { useState } from "react";
import { Share2, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";

/**
 * SHARE A CUSTOMER DOCUMENT — the button that wasn't there.
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
 */
export function ShareDocButton({
  load,
  label = "Share",
}: {
  load: () => Promise<{ ok: boolean; error?: string; title?: string; text?: string; url?: string }>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await load();
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
    }
  }

  return (
    <button
      onClick={go}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />} {label}
    </button>
  );
}
