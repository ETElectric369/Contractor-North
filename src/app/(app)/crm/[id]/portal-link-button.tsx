"use client";

import { useState, useTransition } from "react";
import { LayoutDashboard, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { orgPublicBase } from "@/app/(app)/share-actions";
import { emailPortalLink } from "../actions";

/** Staff control on a customer: email them their passwordless portal link, or copy it. */
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

  function emailIt() {
    setMsg(null);
    start(async () => {
      const res = await emailPortalLink(customerId);
      setMsg(res.ok ? "Portal link emailed ✓" : res.error ?? "Couldn't send.");
    });
  }
  function copyIt() {
    // The link is asked of the SERVER, not read off window.location — the customer's portal lives
    // on the business's own domain, not on whichever host the office is signed in to today.
    start(async () => {
      const base = await orgPublicBase();
      const link = `${base}/portal/${portalToken}`;
      navigator.clipboard?.writeText(link).then(
        () => setMsg("Link copied ✓"),
        () => setMsg(link),
      );
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={copyIt}>
          <Copy className="h-4 w-4" /> Copy their link
        </Button>
        <Button variant="outline" size="sm" onClick={emailIt} disabled={pending || !hasEmail} title={hasEmail ? "Email them their own page — every estimate and invoice of theirs, in one place" : "Add an email to this customer first"}>
          <LayoutDashboard className="h-4 w-4" /> {pending ? "Sending…" : "Email them the link"}
        </Button>
      </div>
      {msg && <span className="text-xs text-slate-500">{msg}</span>}
    </div>
  );
}
