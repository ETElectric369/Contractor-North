"use client";

import { useState, useTransition } from "react";
import { Copy, ExternalLink, LogOut, Mail, Power, PowerOff, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { SentMessagesList } from "@/components/sent-messages-list";
import { SendButton } from "@/components/send-sheet";
import { formatDateTime } from "@/lib/utils";
import { orgPublicBase } from "@/app/(app)/share-actions";
import { openOfficeLook } from "@/components/portal/open-office-look";
import { portalOfficeLookUrl } from "../../portal-look-actions";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { rotatePortalLink, setPortalEnabled, signOutPortalDevices, type PortalLinkState } from "../actions";

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
 *
 * THE CODE (0331). The link now asks each new device for a 6-digit code emailed to the customer, so
 * the card says where they are signed in ("Signed in on 2 devices · Last opened …"), offers Sign
 * Out All Devices, and says out loud when there is no email on file (they can't sign in) with the
 * door to add one. New Link and Turn Off sign every device out (0331's trigger). See What They See
 * goes through a one-use office ticket, so the office never needs the customer's code.
 */
export function PortalLinkButton({
  customerId,
  customerName,
  initial,
  hasEmail,
  addEmailDoor,
}: {
  customerId: string;
  customerName: string;
  initial: PortalLinkState | null;
  hasEmail: boolean;
  /** The contact's own Edit, labelled to add the email: shown when there is no email on file. */
  addEmailDoor?: React.ReactNode;
}) {
  // Office words in the reader's language (cu_…); the link and what is copied for the customer are untouched.
  const lang = useLang();
  const t = translator(lang);
  const [state, setState] = useState<PortalLinkState | null>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);

  if (!state) {
    return (
      <p className="text-sm text-slate-500">
        {t("cu_portalNotSetUp")}
      </p>
    );
  }
  const on = state.enabled;
  // The sheet's heading, a name in the middle ("Make a New Link for {name}?" — today's English).
  const confirmTitle = fillText(t("cu_makeNewLinkTitle"), { name: customerName });
  const devices = state.devices;

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
    say(null);
    // The tab opens inside the click (so Safari allows it) and is filled with a one-use office
    // ticket (0331): the office never needs the customer's code, and its look never counts.
    start(async () => {
      const problem = await openOfficeLook(() => portalOfficeLookUrl(customerId));
      if (problem) say(null, problem);
    });
  }
  function copyIt() {
    const token = state!.token;
    say(null);
    start(async () => {
      const l = await link(token);
      navigator.clipboard?.writeText(l).then(
        () => say(t("cu_copied")),
        () => say(l),
      );
    });
  }
  function rotate() {
    say(null);
    start(async () => {
      const res = await rotatePortalLink(customerId);
      if (!res.ok || !res.link) {
        say(null, res.error ?? t("cu_couldntMakeLink"));
        return;
      }
      setState(res.link);
      setConfirmNew(false);
      say(fillText(t("cu_newLinkMade"), { name: customerName }));
    });
  }
  function toggle() {
    const next = !on;
    say(null);
    start(async () => {
      const res = await setPortalEnabled(customerId, next);
      if (!res.ok || !res.link) {
        say(null, res.error ?? t("cu_didntTake"));
        return;
      }
      setState(res.link);
      say(
        next ? t("cu_turnedOn") : t("cu_turnedOff"),
      );
    });
  }
  function signOutAll() {
    say(null);
    start(async () => {
      const res = await signOutPortalDevices(customerId);
      if (!res.ok || !res.link) {
        say(null, res.error ?? t("cu_didntSignOut"));
        return;
      }
      setState(res.link);
      const n = res.ended ?? 0;
      say(fillText(t(n === 1 ? "cu_signedOutOne" : "cu_signedOutMany"), { n: String(n) }));
    });
  }

  return (
    <div className="space-y-2">
      {/* Say whose page it is BEFORE the verbs, so no button has to carry that job alone. */}
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {t("cu_theirOwnPage")}
      </div>
      <p className="text-sm text-slate-600">
        {on ? (
          <>
            <span className="font-medium text-emerald-700">{t("cu_linkIsOn")}</span>{" "}
            {devices === null ? null : (
              <>
                {fillText(t(devices === 1 ? "cu_signedInOnOne" : "cu_signedInOnMany"), { n: String(devices) })}{" "}
              </>
            )}
            {state.lastOpenedAt ? fillText(t("cu_lastOpened"), { when: formatDateTime(state.lastOpenedAt, undefined, lang) }) : t("cu_notOpenedYet")}{" "}
            <span className="text-slate-400">{t("cu_ownLooksDontCount")}</span>
          </>
        ) : (
          <>
            <span className="font-medium text-red-700">{t("cu_linkIsOff")}</span> {t("cu_opensToOff")}
          </>
        )}
      </p>
      {!hasEmail && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <p className="flex items-start gap-1.5 font-medium">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {t("cu_noEmailCantSignIn")}
          </p>
          <p className="mt-1 text-amber-800">
            {t("cu_codeExplainer")}
          </p>
          {addEmailDoor ? <div className="mt-2">{addEmailDoor}</div> : null}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={preview} disabled={pending} title={t("cu_seeTitle")}>
          <ExternalLink className="h-4 w-4" /> {t("cu_btn_seeWhatTheySee")}
        </Button>
        <Button
          variant="outline"
          onClick={copyIt}
          disabled={pending || !on}
          title={on ? t("cu_copyTitle") : t("cu_turnOnFirst")}
        >
          <Copy className="h-4 w-4" /> {t("cu_btn_copyTheLink")}
        </Button>
        {/* Email It to Them opens the review sheet (cn-v1155): the address, the subject and the message
            are his to read and change before the link leaves. No email on file is no dead end there:
            the sheet asks for one for this send. Off, the link would open to "turned off", so it waits. */}
        {on ? (
          <SendButton
            kind="portal"
            id={customerId}
            customerName={customerName}
            textReady={false}
            label={t("cu_btn_emailItToThem")}
            variant="outline"
            onSent={() => say(fillText(t("cu_emailedTo"), { name: customerName }))}
          />
        ) : (
          <Button variant="outline" disabled title={t("cu_turnOnFirst")}>
            <Mail className="h-4 w-4" /> {t("cu_btn_emailItToThem")}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => {
            say(null);
            setConfirmNew(true);
          }}
          disabled={pending}
          title={t("cu_newLinkTitle")}
        >
          <RefreshCw className="h-4 w-4" /> {t("cu_btn_newLink")}
        </Button>
        <Button
          variant="outline"
          onClick={toggle}
          disabled={pending}
          title={on ? t("cu_turnOffTitle") : t("cu_turnOnTitle")}
        >
          {on ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />} {on ? t("cu_btn_turnOff") : t("cu_btn_turnOn")}
        </Button>
        <Button
          variant="outline"
          onClick={signOutAll}
          disabled={pending || !devices}
          title={devices ? t("cu_signOutTitle") : t("cu_noDeviceSignedIn")}
        >
          <LogOut className="h-4 w-4" /> {t("cu_btn_signOutAllDevices")}
        </Button>
      </div>
      {pending && <p className="text-xs text-slate-500">{t("cu_working")}</p>}
      {msg && <p className="text-xs text-slate-600">{msg}</p>}
      {error && !confirmNew && <p className="text-xs text-red-700">{error}</p>}
      {/* What went out to them, word for word; hides until a link has been sent. */}
      <SentMessagesList kind="portal" id={customerId} refreshKey={msg ?? ""} />

      <Modal
        open={confirmNew}
        onClose={() => setConfirmNew(false)}
        title={confirmTitle}
        size="sm"
        footer={
          <ModalActions
            onCancel={() => setConfirmNew(false)}
            onSave={rotate}
            saving={pending}
            destructive
            saveLabel={t("cu_btn_makeNewLink")}
          />
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>{fillText(t("cu_newLinkBody"), { name: customerName })}</p>
          <p>{t("cu_newLinkWorks")}</p>
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-red-700">{error}</div>}
        </div>
      </Modal>
    </div>
  );
}
