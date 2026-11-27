"use client";

import { useRef, useState, useTransition } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { updateMyPassword } from "@/app/set-password/actions";

/** CHANGE MY PASSWORD (cn-v1202): the one door where a signed-in person sets their own password, a
 *  row in Settings › You › Sign-in & security, the same for every role. Closed it is one button;
 *  open, two boxes and Save / Cancel, inline (no Modal, no navigation). It calls the same action as
 *  the first-password page (set-password/actions updateMyPassword), which saves what was typed,
 *  says a refusal in the app's own words and signs the person's OTHER sessions out. No
 *  current-password box: the server asks for one only under a setting, and the action's sentence
 *  then names the code sign-in, after which it never asks. The form names its account in a hidden
 *  username field (cn-v1202): a password manager files a new password under the account the form
 *  names, and without one it may keep offering the old password at sign-in. */
export function ChangePassword({ email = "" }: { email?: string }) {
  const t = translator(useLang());
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // A second tap before React re-renders the disabled button must not send it twice.
  const busy = useRef(false);

  function openRow() {
    setDone(null);
    setError(null);
    setOpen(true);
  }
  function cancel() {
    setOpen(false);
    setPw("");
    setConfirm("");
    setError(null);
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    setError(null);
    if (pw.length < 8) return setError(t("au_password8"));
    if (pw !== confirm) return setError(t("au_passwordsDontMatch"));
    busy.current = true;
    start(async () => {
      try {
        const res = await updateMyPassword(pw);
        // `saved` (cn-v1202): the password was saved and only the must-reset flag was left, which a
        // person in Settings never has set (the app layout sends a flagged person to the
        // first-password page), so here it is a success like any other.
        if (!res.ok && !res.saved) return setError(res.error ?? t("au_couldNotUpdate"));
        setPw("");
        setConfirm("");
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
        <Label htmlFor="cp-pw">{t("au_newPassword")}</Label>
        <Input id="cp-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t("au_atLeast8")} autoFocus />
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
