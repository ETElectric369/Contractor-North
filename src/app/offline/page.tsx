import { NO_INDEX } from "@/lib/no-index";
import { OfflineWords } from "./offline-words";

/**
 * The PWA offline fallback. It is deliberately unauthenticated (the service worker has to be able
 * to serve it with no session) — but "unauthenticated" was silently doing double duty as
 * "indexable", and the same 21 lines answered 200 on FIVE hostnames with no canonical and no
 * robots directive:
 *     etelectricity.com/offline · tahoedeck.com/offline · app.contractornorth.com/offline
 *     et-electric.contractornorth.com/offline · contractor-north.vercel.app/offline
 * Identical content on multiple hosts with nothing declaring a primary is the exact shape Google
 * files under "Duplicate without user-selected canonical" — the message on Erik's Search Console
 * as of 2026-07-27. Google can find it, too: "/offline" is a string literal in the public sw.js.
 *
 * noindex rather than a canonical, because there is no "primary" copy worth indexing: this page
 * says "you're offline" under the SOFTWARE VENDOR's name, on the contractor's own domain.
 *
 * THE WORDS (cn-v1138) are OfflineWords: with no session to read a language from, they follow the
 * phone's own language. The document title is the vendor's name and stays as it is.
 */
export const metadata = { title: "Offline · Contractor North", robots: NO_INDEX };

export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon-192.png" alt="Contractor North" className="h-16 w-16 rounded-2xl" />
      <OfflineWords />
    </div>
  );
}
