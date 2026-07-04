"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { QrCode, Share2, Copy, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { getShareLink } from "@/app/(app)/share-actions";

/**
 * "Forward the QR" — every employee's personal request-an-estimate link, one tap from the topbar.
 * The bar scenario: a tech meets someone who needs work → show the QR to scan on the spot, or
 * send the link through the native share sheet. Leads that arrive through it are tagged
 * referred_by that employee (the commission trail), which the blurb tells them plainly.
 */
export function ShareQrButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const toast = useToast();

  const launch = async () => {
    setOpen(true);
    if (link || busy) return;
    setBusy(true);
    try {
      const res = await getShareLink();
      if (res.error || !res.url) toast(res.error || "Couldn't build your link.", "error");
      else setLink({ url: res.url, qr: res.qr });
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!link) return;
    // Native share sheet where available (iOS PWA has it); clipboard as the fallback.
    try {
      if (navigator.share) {
        await navigator.share({ title: "Request an estimate", text: "Need electrical work? Request an estimate here:", url: link.url });
        return;
      }
    } catch {
      /* user cancelled the sheet — fall through to nothing */
      return;
    }
    try {
      await navigator.clipboard.writeText(link.url);
      toast("Link copied — paste it anywhere.", "success");
    } catch {
      toast("Couldn't copy — long-press the link below instead.", "error");
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast("Link copied.", "success");
    } catch {
      toast("Couldn't copy — long-press the link below instead.", "error");
    }
  };

  return (
    <>
      <button
        onClick={launch}
        className="flex items-center rounded-lg border border-slate-200 px-2.5 py-2 text-slate-500 hover:bg-slate-50 sm:px-3"
        title="Share your estimate QR"
        aria-label="Share your estimate QR"
      >
        <QrCode className="h-4 w-4" />
      </button>
      {/* PORTALED to <body> — the deliberate exception to the in-place Modal doctrine.
          This button's only mount is a row INSIDE the account-menu glass panel, and
          .glass/.glass-menu's backdrop-filter makes that panel the CONTAINING BLOCK for
          fixed-position descendants (filter-effects-2 spec) — so the Modal's fixed
          inset-0 overlay was laid out inside the 240px panel and clipped by its
          overflow-hidden (Erik's "QR alignment" bug: the QR card squeezed hard-right
          and cut off). The portal lifts the overlay back to the viewport. Safe here
          because NO <form> wraps this Modal (the documented no-portal hazard), the
          Modal still sets body.modal-open, and the account menu already bails out of
          its close handlers while that class is present — the host stays mounted. */}
      {open &&
        createPortal(
          <Modal open={open} onClose={() => setOpen(false)} title="Share — request an estimate">
            {busy || !link ? (
              <div className="flex items-center justify-center py-10 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex justify-center">
                  {/* Big enough to scan across a bar table; tappable when this screen is shared. */}
                  <a href={link.url} target="_blank" rel="noopener noreferrer" className="mx-auto max-w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={link.qr} alt="Request an estimate QR — tap to open" className="h-56 w-56 max-w-full rounded-xl border border-slate-200" />
                  </a>
                </div>
                <p className="text-center text-sm text-slate-600">
                  Have them scan it right here, or send them the link.
                  <br />
                  <span className="font-medium text-slate-800">Leads from your link are credited to you.</span>
                </p>
                <div className="flex gap-2">
                  <Button onClick={share} className="flex-1">
                    <Share2 className="mr-1.5 h-4 w-4" /> Send the Link
                  </Button>
                  <Button onClick={copy} variant="outline" className="shrink-0">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="break-all text-center text-[11px] text-slate-400">{link.url}</p>
              </div>
            )}
          </Modal>,
          document.body,
        )}
    </>
  );
}
