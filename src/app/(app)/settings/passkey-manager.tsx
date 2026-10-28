"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLang } from "@/components/lang-provider";
import { fillNodes } from "@/components/fill-nodes";
import { fillText, translator } from "@/lib/i18n";
import { startPasskeyRegistration, finishPasskeyRegistration, removePasskey } from "./passkey-actions";

type Passkey = { id: string; label: string | null; created_at: string; last_used_at: string | null };

/** Enroll / manage WebAuthn passkeys (the step-up factor). With one enrolled, money
 *  actions the assistant takes require a Face ID / Touch ID tap the AI can't fake. */
export function PasskeyManager({ passkeys }: { passkeys: Passkey[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The words in the person's language (cn-v1138); a passkey's stored label ("This device") is
  // written in it too, since it is this person's own row.
  const t = translator(useLang());

  function enroll() {
    setError(null);
    start(async () => {
      try {
        const res = await startPasskeyRegistration();
        if (!res.ok || !res.options) return setError(res.error ?? t("sh_passkeyStartFailed"));
        const attestation = await startRegistration({ optionsJSON: res.options });
        const fin = await finishPasskeyRegistration(attestation, t("sh_thisDevice"));
        if (!fin.ok) return setError(fin.error ?? t("sh_passkeyFinishFailed"));
        router.refresh();
      } catch (e: any) {
        setError(e?.name === "NotAllowedError" ? t("sh_cancelled") : e?.message ?? t("sh_passkeySetupFailed"));
      }
    });
  }
  function remove(id: string) {
    if (!confirm(t("sh_removePasskeyAsk"))) return;
    start(async () => {
      await removePasskey(id);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{fillNodes(t("sh_passkeyIntro"), { em: <span className="font-medium">{t("sh_passkeyEm")}</span> })}</p>
      {passkeys.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {passkeys.map((k) => (
            <li key={k.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="flex items-center gap-2 text-slate-800">
                <Fingerprint className="h-4 w-4 text-slate-400" /> {k.label || t("sh_passkey")}
                <span className="text-xs text-slate-400">{fillText(t("sh_passkeyAdded"), { date: new Date(k.created_at).toLocaleDateString() })}</span>
              </span>
              <button onClick={() => remove(k.id)} className="text-slate-400 hover:text-red-600" aria-label={t("sh_removePasskey")}>
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button variant="outline" onClick={enroll} disabled={pending}>
        {pending ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> {t("sh_waitingForTap")}</>
        ) : (
          <><Fingerprint className="h-4 w-4" /> {passkeys.length ? t("sh_addAnotherPasskey") : t("sh_setUpPasskey")}</>
        )}
      </Button>
    </div>
  );
}
