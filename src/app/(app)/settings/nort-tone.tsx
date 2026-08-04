"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { clampHumor, humorLabel, type Register } from "@/lib/nort/tone";
import { saveNortTone } from "./nort-tone-actions";

/**
 * HOW NORT TALKS TO YOU — Erik: "is there a humor setting we can put at like 55% and a swear word
 * allowance we can match the user (good industry form and mental health)."
 *
 * It lives under "You" rather than under the company because register is personal: the same org
 * holds somebody in a truck and somebody at a desk, and making either live with the other's
 * setting is how you lose one of them.
 *
 * The copy says out loud what the dial CANNOT do, because a swearing toggle with no stated limits
 * is a thing people are right to distrust — and the limit that matters to a contractor is that
 * none of it ever reaches a customer.
 */
export function NortTone({ humor, register }: { humor: number; register: Register }) {
  const router = useRouter();
  const [h, setH] = useState(clampHumor(humor));
  const [r, setR] = useState<Register>(register);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-5">
      <div>
        <Label className="mb-1.5">Humour — {humorLabel(h)}</Label>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={h}
          onChange={(e) => { setH(Number(e.target.value)); setSaved(false); }}
          className="w-full accent-[rgb(var(--glass-ink))]"
          aria-label="How funny Nort is"
        />
        <div className="mt-1 flex justify-between text-[11px] text-slate-400">
          <span>Just the facts</span>
          <span className="tabular-nums">{h}%</span>
          <span>Full windup</span>
        </div>
      </div>

      <div>
        <Label className="mb-1.5">Language</Label>
        <div className="flex flex-wrap gap-2">
          {([
            ["match", "Talk how I talk", "He matches your register — swearing included. Never first, never more than you."],
            ["clean", "Keep it clean", "No swearing from him, whatever you say."],
          ] as const).map(([val, label, blurb]) => (
            <button
              key={val}
              type="button"
              onClick={() => { setR(val); setSaved(false); }}
              title={blurb}
              className={
                r === val
                  ? "min-h-[44px] rounded-full border border-brand bg-brand px-4 text-sm font-medium text-white"
                  : "min-h-[44px] rounded-full border border-slate-300 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
              }
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-snug text-slate-500">
          {r === "match"
            ? "He'll match how you talk, and only ever match — he won't swear first, and he won't go further than you did."
            : "He'll keep it clean no matter what you say."}
        </p>
      </div>

      {/* THE LIMITS, SAID OUT LOUD. A swearing toggle with no stated boundary is a thing people are
          right to distrust, and the one that matters to a contractor is his own reputation. */}
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
        <strong className="font-medium text-slate-700">None of this reaches your customers.</strong>{" "}
        Estimates, invoices, contracts, your website and anything written for a homeowner stay clean and
        professional whatever you set here — this is only how Nort talks to <em>you</em> and your crew.
        He also won&rsquo;t aim it at anybody: not you, not a customer, not the sub who botched it.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setErr(null);
              const res = await saveNortTone(h, r);
              if (!res.ok) return setErr(res.error);
              setSaved(true);
              router.refresh();
            })
          }
        >
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><Check className="h-4 w-4" /> Save</>}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
        {saved && !err && <span className="text-sm font-medium text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}
