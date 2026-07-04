"use client";

import { useState, useTransition } from "react";
import { LayoutDashboard, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    const link = `${window.location.origin}/portal/${portalToken}`;
    navigator.clipboard?.writeText(link).then(
      () => setMsg("Link copied ✓"),
      () => setMsg(link),
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={copyIt}>
          <Copy className="h-4 w-4" /> Copy Portal Link
        </Button>
        <Button variant="outline" size="sm" onClick={emailIt} disabled={pending || !hasEmail} title={hasEmail ? "" : "Add an email to this customer first"}>
          <LayoutDashboard className="h-4 w-4" /> {pending ? "Sending…" : "Email Portal"}
        </Button>
      </div>
      {msg && <span className="text-xs text-slate-500">{msg}</span>}
    </div>
  );
}
