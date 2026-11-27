"use client";

import { useRef, useState, useTransition } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { emailMyResetLink, updateMyPassword } from "@/app/set-password/actions";

/** CHANGE MY PASSWORD (cn-v1202): the one door where a signed-in person sets their own password, a
 *  row in Settings › You › Sign-in & security, the same for every role. Closed it is one button;
 *  open, three boxes (the current password, then the new one twice) and Save / Cancel, inline (no
 *  Modal, no navigation). It calls the same action as the first-password page (set-password/actions
 *  updateMyPassword) with (new, current) as typed; the action checks the current password for anyone
 *  not flagged for a first password (cn-v1203, the owner: "require current password"), saves what
 *  was typed, says a refusal in the app's own words and signs the person's OTHER sessions out. Under
 *  the current box, the way out for a forgotten one stays INSIDE the app (cn-v1203, after skeptic
 *  #100): "Forgot it?" and a small Send Reset Link button that emails the person's OWN address a reset
 *  link (set-password/actions emailMyResetLink, no argument); /forgot is a page outside the app's
 *  frame whose links lead to the sign-in form, so it is not linked here. The answer shows under the
 *  box; the button is disabled while it runs and after a success, and a second tap never sends twice;
 *  Cancel and done clear it. The email lands on the first-password page. The form names its account in a hidden
 *  username field (cn-v1202): a password manager files a new password under the account the form
 *  names, and without one it may keep offering the old password at sign-in. */
export function ChangePassword({ email = "" }: { email?: string }) {
  const t = translator(useLang());
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // A second tap before React re-renders the disabled button must not send it twice.
  const busy = useRef(false);
  // The reset link's answer (cn-v1203), and its own guard against a second tap.
  const [reset, setReset] = useState<{ ok: boolean; message: string } | null>(null);
  const [sending, setSending] = useState(false);
  const resetBusy = useRef(false);

  function openRow() {
    setDone(null);
    setError(null);
    setOpen(true);
  }
  function cancel() {
    setOpen(false);
    setCur("");
    setPw("");
    setConfirm("");
    setError(null);
    setReset(null);
  }
  function sendReset() {
    if (resetBusy.current || reset?.ok) return;
    resetBusy.current = true;
    setSending(true);
    setReset(null);
    return emailMyResetLink()
      .then((r) => setReset(r), () => setReset({ ok: false, message: t("au_resetNotSent") }))
      .finally(() => {
        resetBusy.current = false;
        setSending(false);
      });
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    setError(null);
    if (cur === "") return setError(t("au_currentPasswordNeeded"));
    if (pw.length < 8) return setError(t("au_password8"));
    if (pw !== confirm) return setError(t("au_passwordsDontMatch"));
    busy.current = true;
    start(async () => {
      try {
        const res = await updateMyPassword(pw, cur);
        // `saved` (cn-v1202): the password was saved and only the must-reset flag was left, which a
        // person in Settings never has set (the app layout sends a flagged person to the
        // first-password page), so here it is a success like any other.
        if (!res.ok && !res.saved) return setError(res.error ?? t("au_couldNotUpdate"));
        setCur("");
        setPw("");
        setConfirm("");
        setReset(null);
        setOpen(false);
        setDone(t(res.othersSignedOut ? "sh_passwordChangedOthers" : "sh_passwordChanged"));
      } catch {
        setError(t("au_couldNotUpdate"));
      } finally {
        busy.current = false;
      }
    });
  }

  if (!open) {
    return (
      <div className="mt-3 space-y-2">
        <Button type="button" variant="outline" size="sm" onClick={openRow}>
          <KeyRound className="h-4 w-4" /> {t("sh_changeMyPassword")}
        </Button>
        {done && <p className="text-sm text-emerald-700" role="status">{done}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border border-slate-200 p-3">
      {email && <input type="text" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" style={{ display: "none" }} />}
      <div>
        <Label htmlFor="cp-cur">{t("au_currentPassword")}</Label>
        <Input id="cp-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus />
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>{t("au_forgotCurrent")}</span>
          <button type="button" onClick={sendReset} disabled={sending || reset?.ok === true} className="font-medium text-brand hover:underline disabled:opacity-60">
            {t("au_sendResetLink")}
          </button>
        </div>
        {reset && (
          <p className={`mt-1 text-xs ${reset.ok ? "text-emerald-700" : "text-red-600"}`} role={reset.ok ? "status" : "alert"}>
            {reset.message}
          </p>
        )}
      </div>
      <div>
        <Label htmlFor="cp-pw">{t("au_newPassword")}</Label>
        <Input id="cp-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t("au_atLeast8")} />
      </div>
      <div>
        <Label htmlFor="cp-pw2">{t("au_confirmPassword")}</Label>
        <Input id="cp-pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> {t("au_saving")}</> : t("sh_savePassword")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={pending}>
          {t("sh_btn_cancel")}
        </Button>
      </div>
    </form>
  );
}
