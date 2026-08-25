"use client";

import { useState, useTransition } from "react";
import { Copy, ExternalLink, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { orgPublicBase } from "@/app/(app)/share-actions";
import { emailPortalLink } from "../actions";

/**
 * THE CUSTOMER'S OWN PAGE — a different page, at a different URL, meant for them.
 *
 * Erik, after clicking it: "since when did the contact page change in front of my eyes to the
 * customer portal page … so youre telling me this is what they are supposed to see?"
 *
 * Nothing changed — he was still on /crm/<id>. The buttons sent him somewhere else and never said
 * so. "Copy Portal Link" was jargon; my first rename to "Copy their link" was WORSE, because on a
 * page that is already about that customer it reads as "copy a link to this page". Ambiguity is a
 * worse failure than jargon: jargon makes you ask, ambiguity makes you sure and wrong.
 *
 * So the controls now say whose page it is out loud, above the buttons, and the first thing
 * offered is a LOOK. Nobody should have to send a customer a page they have never seen — and
 * "is this really what they get?" is a question the app can simply answer instead of arguing.
 */
export function PortalLinkButton({
  customerId,
  portalToken,
  hasEmail,
}: {
  customerId: string;
  portalToken: string;
  hasEmail: boolean;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  /** The link is asked of the SERVER, not read off window.location — the customer's page lives on
   *  the business's own domain, not whichever host the office happens to be signed in to today. */
  async function link() {
    const base = await orgPublicBase();
    return `${base}/portal/${portalToken}`;
  }

  function preview() {
    // Opened from the click's own transition so Safari doesn't treat it as a popup.
    start(async () => {
      window.open(await link(), "_blank", "noopener,noreferrer");
    });
  }
  function emailIt() {
    setMsg(null);
    start(async () => {
      const res = await emailPortalLink(customerId);
      setMsg(res.ok ? "Emailed ✓" : res.error ?? "Couldn't send.");
    });
  }
  function copyIt() {
    start(async () => {
      const l = await link();
      navigator.clipboard?.writeText(l).then(
        () => setMsg("Copied ✓"),
        () => setMsg(l),
      );
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {/* Say whose page it is BEFORE the verbs, so no button has to carry that job alone. */}
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        Their own page — estimates, invoices, contracts
      </span>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={preview} disabled={pending} title="Open it exactly as the customer sees it">
          <ExternalLink className="h-4 w-4" /> See what they see
        </Button>
        <Button variant="outline" size="sm" onClick={copyIt} disabled={pending}>
          <Copy className="h-4 w-4" /> Copy the link
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={emailIt}
          disabled={pending || !hasEmail}
          title={hasEmail ? "Email them the link to that page" : "Add an email to this customer first"}
        >
          <Mail className="h-4 w-4" /> {pending ? "Sending…" : "Email it to them"}
        </Button>
      </div>
      {msg && <span className="text-xs text-slate-500">{msg}</span>}
    </div>
  );
}
