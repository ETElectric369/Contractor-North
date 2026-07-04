"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startPasskeyRegistration, finishPasskeyRegistration, removePasskey } from "./passkey-actions";

type Passkey = { id: string; label: string | null; created_at: string; last_used_at: string | null };

/** Enroll / manage WebAuthn passkeys (the step-up factor). With one enrolled, money
 *  actions the assistant takes require a Face ID / Touch ID tap the AI can't fake. */
export function PasskeyManager({ passkeys }: { passkeys: Passkey[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function enroll() {
    setError(null);
    start(async () => {
      try {
        const res = await startPasskeyRegistration();
        if (!res.ok || !res.options) return setError(res.error ?? "Couldn't start enrollment.");
        const attestation = await startRegistration({ optionsJSON: res.options });
        const fin = await finishPasskeyRegistration(attestation, "This device");
        if (!fin.ok) return setError(fin.error ?? "Couldn't finish enrollment.");
        router.refresh();
      } catch (e: any) {
        setError(e?.name === "NotAllowedError" ? "Cancelled." : e?.message ?? "Couldn't set up the passkey.");
      }
    });
  }
  function remove(id: string) {
    if (!confirm("Remove this passkey?")) return;
    start(async () => {
      await removePasskey(id);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Enroll Face ID / Touch ID (a passkey). With one set up, any <span className="font-medium">money action the assistant
        takes</span> requires a tap from you to confirm — something the AI physically can&apos;t do on its own.
      </p>
      {passkeys.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {passkeys.map((k) => (
            <li key={k.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="flex items-center gap-2 text-slate-800">
                <Fingerprint className="h-4 w-4 text-slate-400" /> {k.label || "Passkey"}
                <span className="text-xs text-slate-400">· added {new Date(k.created_at).toLocaleDateString()}</span>
              </span>
              <button onClick={() => remove(k.id)} className="text-slate-400 hover:text-red-600" aria-label="Remove passkey">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button variant="outline" onClick={enroll} disabled={pending}>
        {pending ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> Waiting for your tap…</>
        ) : (
          <><Fingerprint className="h-4 w-4" /> {passkeys.length ? "Add Another Passkey" : "Set Up Face ID / Passkey"}</>
        )}
      </Button>
    </div>
  );
}
