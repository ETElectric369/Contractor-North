"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { updateMyPassword } from "./actions";

export function SetPasswordForm() {
  const router = useRouter();
  // The page mounts a LangProvider from the person's profile (cn-v1138); outside one it is English.
  const t = translator(useLang());
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) return setError(t("au_password8"));
    if (pw !== confirm) return setError(t("au_passwordsDontMatch"));
    start(async () => {
      const res = await updateMyPassword(pw);
      if (!res.ok) return setError(res.error ?? t("au_couldNotUpdate"));
      router.replace("/planner");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="pw">{t("au_newPassword")}</Label>
        <Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t("au_atLeast8")} autoFocus />
      </div>
      <div>
        <Label htmlFor="pw2">{t("au_confirmPassword")}</Label>
        <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> {t("au_saving")}</> : t("au_savePasswordContinue")}
      </Button>
    </form>
  );
}
