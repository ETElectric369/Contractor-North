"use client";

/**
 * TEXTING, AS IT REALLY IS (2026-09-24). Erik: "Wait in texting but be ready for it's setup".
 *
 * Settings used to show "Text timeclock reminders" ticked while nothing could text: no sender on
 * the platform and no number for the business. This card is where the truth lives. It reads the
 * one readiness answer (lib/sms-readiness, computed on the server and handed over as words, never
 * a key), says whether texting is on, lists what is missing in plain words, and names every door
 * that waits on it. The business's own texting number is typed here too, because it is one of
 * the pieces.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input, Label } from "@/components/ui/input";
import { SMS_NUMBER_EXAMPLE, smsE164, type SmsReadiness } from "@/lib/sms-readiness";
import { updateOrgSettings } from "./actions";

/** Every door that texts, as the owner knows it. Kept here so the card and the doors agree. */
const TEXT_DOORS = [
  "Timeclock reminders to the crew: the morning nudge, the end-of-day reminder, and the 12-hour “still on the clock?” question (as a text as well as a notification), when ticked under Scheduling",
  "The Text buttons on invoices, estimates and receipts",
];

export function TextingCard({ status, number }: { status: SmsReadiness; number: string }) {
  const router = useRouter();
  const [value, setValue] = useState(number ?? "");
  const [, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const storedUnusable = !!(number ?? "").trim() && !smsE164(number);

  function save() {
    const typed = value.trim();
    // Blank is a choice (use the app's number). Anything else must read as a phone number, or the
    // card would say "Texting is on" while the texting service refused every send from it. It is
    // stored in the one form the service takes, so "(530) 555-1234" saves as +15305551234.
    const normalized = typed ? smsE164(typed) : "";
    if (normalized === null) {
      setErr(`That isn't a phone number the texting service can use. Write it like ${SMS_NUMBER_EXAMPLE}. Nothing was saved.`);
      return;
    }
    if (normalized === (number ?? "").trim()) {
      setErr(null);
      if (normalized !== typed) setValue(normalized);
      return;
    }
    setErr(null);
    start(async () => {
      const res = await updateOrgSettings({ sms_from_number: normalized });
      if (!res.ok) return setErr(res.error ?? "Couldn't save your number.");
      setValue(normalized);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // The number is one of the pieces: read the answer again.
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {status.ready ? (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
          <p className="font-medium">Texting is on.</p>
          <p className="mt-0.5 text-xs text-emerald-700">
            {status.sender === "org_number"
              ? "Texts go out from your business's own number, below."
              : "Texts go out from the app's texting number. Add your own below to text under your business's name."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <p className="font-medium">Texting isn&apos;t set up yet, so nothing is texted.</p>
          <p className="mt-2 text-xs font-medium text-amber-800">Still needed:</p>
          <ul className="mt-0.5 list-disc pl-5 text-xs text-amber-800">
            {status.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="text-xs font-medium text-slate-600">{status.ready ? "What texts:" : "Waiting on it:"}</p>
        <ul className="mt-0.5 list-disc pl-5 text-xs text-slate-500">
          {TEXT_DOORS.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        {!status.ready && (
          <p className="mt-1 text-xs text-slate-500">
            Until then those options show as not active, and a Text button says so when it&apos;s tapped. Email and
            texting from your own phone work now.
          </p>
        )}
      </div>

      <div className="border-t border-slate-100 pt-4">
        <Label htmlFor="sms-from">Your business&apos;s texting number</Label>
        <Input
          id="sms-from"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          placeholder={SMS_NUMBER_EXAMPLE}
          className="max-w-[220px]"
          inputMode="tel"
        />
        <p className="mt-1 text-xs text-slate-400">
          A number registered for texting under your business, written like {SMS_NUMBER_EXAMPLE}. Your customer and crew texts
          go out from it, under your own name. Leave it blank to use the app&apos;s texting number once there is one.
        </p>
        {/* A number saved before this card checked it (or typed by another door) and not usable:
            said here, since texts go out from the app's number instead, or not at all. */}
        {!err && storedUnusable && (
          <p className="mt-1 text-sm text-amber-700">
            The number saved here isn&apos;t one the texting service can use, so texts don&apos;t go out from it. Write it
            like {SMS_NUMBER_EXAMPLE}.
          </p>
        )}
        {err && <p className="mt-1 text-sm text-red-600">{err}</p>}
        {saved && <p className="mt-1 text-sm font-medium text-green-600">Saved</p>}
      </div>
    </div>
  );
}
