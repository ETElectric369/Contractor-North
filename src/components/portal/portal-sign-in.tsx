"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, LogOut, Mail, Phone } from "lucide-react";
import {
  CODE_TTL_MINUTES,
  checkRefusalWords,
  normalizeCode,
  sendRefusalWords,
  type CheckRefusal,
  type SendRefusal,
} from "@/lib/portal/code-words";
import { PortalShell, type PortalOrg } from "./portal-shell";

/**
 * THE SIGN-IN SCREEN (0331). What a device that is not signed in sees on the customer's same link:
 * the business's glass, name and logo, where the code will go (masked on the server), and one
 * button. Erik: "andrew can re-click the link from his messages and get a new code sent". So the
 * link never changes, and the code is one tap away every time.
 *
 * No dead end: no email on file → Call and Email the business; a code that ran out → Send A New
 * Code right there; a code already in the inbox → I Already Have A Code. Every answer is said.
 */
export type SendResult = { ok: true; maskedEmail: string | null } | { ok: false; reason: SendRefusal; retryMinutes?: number };
export type CheckResult = { ok: true } | { ok: false; reason: CheckRefusal; triesLeft?: number };

const BTN =
  "seaglass-btn inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))] disabled:opacity-60";
const LINK_BTN =
  "inline-flex min-h-[44px] items-center rounded-lg px-1 text-sm font-semibold text-[rgb(var(--glass-ink))] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))] disabled:opacity-60";

export function PortalSignIn({
  org,
  maskedEmail,
  send,
  check,
}: {
  org: PortalOrg;
  /** "m*******@comcast.net", or null when there is no email on file. Never the full address. */
  maskedEmail: string | null;
  send: () => Promise<SendResult>;
  check: (code: string) => Promise<CheckResult>;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"start" | "code" | "opening">("start");
  const [to, setTo] = useState(maskedEmail);
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const business = org.name;

  if (!maskedEmail) return <NoEmail org={org} />;

  function sendCode() {
    setError(null);
    setInfo(null);
    start(async () => {
      try {
        const r = await send();
        if (r.ok) {
          if (r.maskedEmail) setTo(r.maskedEmail);
          setStep("code");
          setCode("");
          setInfo(`We sent a 6-digit code to ${r.maskedEmail ?? to}. It works for ${CODE_TTL_MINUTES} minutes.`);
          setTimeout(() => input.current?.focus(), 0);
        } else {
          setError(sendRefusalWords(r.reason, business, r.retryMinutes));
          // Too many sends: the newest code in the inbox still works, so offer the box for it.
          if (r.reason === "too_many") setStep("code");
        }
      } catch {
        setError(sendRefusalWords("send_failed", business));
      }
    });
  }

  function checkCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    const c = normalizeCode(code);
    if (!c) {
      setError(checkRefusalWords("format", business));
      input.current?.focus();
      return;
    }
    start(async () => {
      try {
        const r = await check(c);
        if (r.ok) {
          setInfo(null);
          setStep("opening");
          router.refresh();
        } else {
          setError(checkRefusalWords(r.reason, business, r.triesLeft));
          setCode("");
          input.current?.focus();
        }
      } catch {
        setError(checkRefusalWords("error", business));
      }
    });
  }

  return (
    <PortalShell org={org}>
      <div className="portal-glass mx-auto max-w-md rounded-2xl px-5 py-6 sm:px-6">
        <div className="mb-3 flex items-center gap-2 text-[rgb(var(--glass-ink))]">
          <KeyRound className="h-5 w-5 shrink-0" aria-hidden />
          <h1 className="text-lg font-bold text-slate-900">Your page with {business}</h1>
        </div>

        {step === "start" && (
          <>
            <p className="text-base text-slate-800">
              For your privacy, we&apos;ll email a 6-digit code to{" "}
              <span className="font-semibold [overflow-wrap:anywhere]">{to}</span>
            </p>
            <div className="mt-5">
              <button type="button" className={BTN} onClick={sendCode} disabled={pending}>
                {pending ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Mail className="h-5 w-5" aria-hidden />}
                <span>{pending ? "Sending…" : "Send My Code"}</span>
              </button>
            </div>
            <div className="mt-3 text-center">
              <button
                type="button"
                className={LINK_BTN}
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setStep("code");
                  setTimeout(() => input.current?.focus(), 0);
                }}
              >
                I Already Have A Code
              </button>
            </div>
          </>
        )}

        {step === "code" && (
          <form onSubmit={checkCode} noValidate>
            <label htmlFor="portal-code" className="block text-base text-slate-800">
              Enter the 6-digit code from your email.
            </label>
            <input
              ref={input}
              id="portal-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={12}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={pending}
              aria-invalid={!!error}
              aria-describedby="portal-code-msg"
              className="mt-3 block h-14 w-full rounded-xl border border-slate-300 bg-white/90 px-4 text-center font-mono text-2xl tracking-[0.4em] text-slate-900 focus:border-[rgb(var(--glass-ink))] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--glass-ink))]/30"
            />
            <div className="mt-4">
              <button type="submit" className={BTN} disabled={pending}>
                {pending ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
                <span>{pending ? "Checking…" : "Open My Page"}</span>
              </button>
            </div>
            <p className="mt-3 text-center text-sm text-slate-700">
              Didn&apos;t get it? Check spam, or{" "}
              <button type="button" className={LINK_BTN} onClick={sendCode} disabled={pending}>
                Send A New Code
              </button>
            </p>
          </form>
        )}

        {step === "opening" && (
          <p className="flex items-center gap-2 text-base text-slate-800" role="status">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> Opening your page…
          </p>
        )}

        <div id="portal-code-msg" aria-live="polite">
          {info && step !== "opening" ? <p className="mt-4 text-sm text-slate-700">{info}</p> : null}
          {error ? (
            <p className="mt-4 rounded-lg bg-red-50/90 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <p className="mt-5 text-xs text-slate-600">
          Once you&apos;re in, this device stays signed in for 30 days. Only {business} and you can see this page.
        </p>
      </div>
    </PortalShell>
  );
}

/** No email on file: nothing can be sent, so the only way forward is the business itself. */
function NoEmail({ org }: { org: PortalOrg }) {
  const tel = org.phone ? org.phone.replace(/[^\d+]/g, "") : "";
  return (
    <PortalShell org={org}>
      <div className="portal-glass mx-auto max-w-md rounded-2xl px-5 py-6 sm:px-6">
        <div className="mb-3 flex items-center gap-2 text-[rgb(var(--glass-ink))]">
          <KeyRound className="h-5 w-5 shrink-0" aria-hidden />
          <h1 className="text-lg font-bold text-slate-900">Your page with {org.name}</h1>
        </div>
        <p className="text-base text-slate-800">
          For your privacy, this page opens with a code we email you. Ask {org.name} to add your email so we can send your
          code.
        </p>
        <div className="mt-5 grid gap-2">
          {tel ? (
            <a href={`tel:${tel}`} className={BTN}>
              <Phone className="h-5 w-5" aria-hidden />
              <span>Call {org.name}</span>
            </a>
          ) : null}
          {org.email ? (
            <a href={`mailto:${org.email}?subject=${encodeURIComponent("Please add my email")}`} className={BTN}>
              <Mail className="h-5 w-5" aria-hidden />
              <span>Email {org.name}</span>
            </a>
          ) : null}
          {!tel && !org.email ? (
            <p className="text-sm text-slate-700">Reach them the way you usually do, and ask them to add your email.</p>
          ) : null}
        </div>
      </div>
    </PortalShell>
  );
}

/** Sign Out on this device (a shared iPad, a borrowed phone). The link still works; the next open
 *  asks for a code again. */
export function PortalSignOut({ signOut }: { signOut: () => Promise<{ ok: boolean }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <div className="mt-3 text-center">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setFailed(false);
            const r = await signOut().catch(() => ({ ok: false }));
            if (r.ok) router.refresh();
            else setFailed(true);
          })
        }
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
      >
        <LogOut className="h-4 w-4" aria-hidden /> {pending ? "Signing Out…" : "Sign Out On This Device"}
      </button>
      {failed ? <p className="text-sm text-red-800" role="alert">That didn&apos;t sign you out. Try again in a minute.</p> : null}
    </div>
  );
}
