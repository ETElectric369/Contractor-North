"use client";

import { useState, useTransition } from "react";
import { Copy, ExternalLink, Mail, Power, PowerOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatDateTime } from "@/lib/utils";
import { orgPublicBase } from "@/app/(app)/share-actions";
import { emailPortalLink, rotatePortalLink, setPortalEnabled, type PortalLinkState } from "../actions";

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
 *
 * THE OFF SWITCHES (0298, token-portals-need-off-switches). The link is the customer's whole key,
 * so the office can see it is live, see when it was last opened, turn it off, and replace it.
 * Office only: the page renders this card for staff alone, and the token is in a table a tech's
 * session reads nothing from.
 */
export function PortalLinkButton({
  customerId,
  customerName,
  initial,
  hasEmail,
}: {
  customerId: string;
  customerName: string;
  initial: PortalLinkState | null;
  hasEmail: boolean;
}) {
  const [state, setState] = useState<PortalLinkState | null>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);

  if (!state) {
    return (
      <p className="text-sm text-slate-500">
        Their own page isn&apos;t set up for this customer yet. Refresh the page in a minute; if it stays like
        this, send a bug report so it can be fixed.
      </p>
    );
  }
  const on = state.enabled;

  /** The link is asked of the SERVER, not read off window.location — the customer's page lives on
   *  the business's own domain, not whichever host the office happens to be signed in to today. */
  async function link(token: string) {
    const base = await orgPublicBase();
    return `${base}/portal/${token}`;
  }

  function say(ok: string | null, bad: string | null = null) {
    setMsg(ok);
    setError(bad);
  }

  function preview() {
    const token = state!.token;
    // Opened from the click's own transition so Safari doesn't treat it as a popup. ?look=office
    // keeps the office's own look from reading as "they opened it".
    start(async () => {
      window.open(`${await link(token)}?look=office`, "_blank", "noopener,noreferrer");
    });
  }
  function emailIt() {
    say(null);
    start(async () => {
      const res = await emailPortalLink(customerId);
      if (res.ok) say(`Emailed to ${customerName} ✓`);
      else say(null, res.error ?? "Couldn't send it.");
    });
  }
  function copyIt() {
    const token = state!.token;
    say(null);
    start(async () => {
      const l = await link(token);
      navigator.clipboard?.writeText(l).then(
        () => say("Copied ✓"),
        () => say(l),
      );
    });
  }
  function rotate() {
    say(null);
    start(async () => {
      const res = await rotatePortalLink(customerId);
      if (!res.ok || !res.link) {
        say(null, res.error ?? "Couldn't make a new link.");
        return;
      }
      setState(res.link);
      setConfirmNew(false);
      say(`New link made. The old one stopped working. Send ${customerName} the new one.`);
    });
  }
  function toggle() {
    const next = !on;
    say(null);
    start(async () => {
      const res = await setPortalEnabled(customerId, next);
      if (!res.ok || !res.link) {
        say(null, res.error ?? "That didn't take.");
        return;
      }
      setState(res.link);
      say(next ? "Turned on. Their link works again." : "Turned off. Their link now says it was turned off.");
    });
  }

  return (
    <div className="space-y-2">
      {/* Say whose page it is BEFORE the verbs, so no button has to carry that job alone. */}
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        Their own page — jobs, bills, estimates, contracts
      </div>
      <p className="text-sm text-slate-600">
        {on ? (
          <>
            <span className="font-medium text-emerald-700">Link is on.</span>{" "}
            {state.lastOpenedAt ? `Last opened ${formatDateTime(state.lastOpenedAt)}.` : "Not opened yet."}{" "}
            <span className="text-slate-400">Your own looks don&apos;t count.</span>
          </>
        ) : (
          <>
            <span className="font-medium text-red-700">Link is off.</span> It opens to &ldquo;This link was turned
            off.&rdquo; Nothing else shows.
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={preview} disabled={pending} title="Open it exactly as the customer sees it">
          <ExternalLink className="h-4 w-4" /> See What They See
        </Button>
        <Button
          variant="outline"
          onClick={copyIt}
          disabled={pending || !on}
          title={on ? "Copy their link" : "Turn the link on first"}
        >
          <Copy className="h-4 w-4" /> Copy the Link
        </Button>
        <Button
          variant="outline"
          onClick={emailIt}
          disabled={pending || !hasEmail || !on}
          title={!hasEmail ? "Add an email to this customer first" : on ? "Email them the link to that page" : "Turn the link on first"}
        >
          <Mail className="h-4 w-4" /> Email It to Them
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            say(null);
            setConfirmNew(true);
          }}
          disabled={pending}
          title="Replace the link. The one they have stops working."
        >
          <RefreshCw className="h-4 w-4" /> New Link
        </Button>
        <Button
          variant="outline"
          onClick={toggle}
          disabled={pending}
          title={on ? "Their link stops working until you turn it back on" : "Their same link works again"}
        >
          {on ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />} {on ? "Turn Off" : "Turn On"}
        </Button>
      </div>
      {pending && <p className="text-xs text-slate-500">Working…</p>}
      {msg && <p className="text-xs text-slate-600">{msg}</p>}
      {error && !confirmNew && <p className="text-xs text-red-700">{error}</p>}

      <Modal
        open={confirmNew}
        onClose={() => setConfirmNew(false)}
        title={`Make a New Link for ${customerName}?`}
        size="sm"
        footer={
          <ModalActions
            onCancel={() => setConfirmNew(false)}
            onSave={rotate}
            saving={pending}
            destructive
            saveLabel="Make New Link"
          />
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            The link {customerName} has now stops working at once. Anyone who opens it sees &ldquo;This link was
            turned off.&rdquo;
          </p>
          <p>The new link works right away. Send it with Copy the Link or Email It to Them.</p>
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-red-700">{error}</div>}
        </div>
      </Modal>
    </div>
  );
}
