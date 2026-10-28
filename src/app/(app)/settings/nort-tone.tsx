"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { clampHumor, humorLabel, type Register } from "@/lib/nort/tone";
import { fillNodes } from "@/components/fill-nodes";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
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
export function NortTone({ humor, register, notes }: { humor: number; register: Register; notes: string }) {
  const router = useRouter();
  const [h, setH] = useState(clampHumor(humor));
  const [r, setR] = useState<Register>(register);
  const [n, setN] = useState(notes);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The words in the person's language (cn-v1138). The humour dial's own words (humorLabel) are
  // Nort's, in lib/nort/tone. The two register doors are Title Case (Erik's law): "Talk How I
  // Talk" and "Keep It Clean" — they read "Talk how I talk" / "Keep it clean" before this.
  const t = translator(useLang());

  return (
    <div className="space-y-5">
      <div>
        <Label className="mb-1.5">{fillText(t("sh_humour"), { level: humorLabel(h) })}</Label>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={h}
          onChange={(e) => { setH(Number(e.target.value)); setSaved(false); }}
          className="w-full accent-[rgb(var(--glass-ink))]"
          aria-label={t("sh_howFunny")}
        />
        <div className="mt-1 flex justify-between text-[11px] text-slate-400">
          <span>{t("sh_justTheFacts")}</span>
          <span className="tabular-nums">{h}%</span>
          <span>{t("sh_fullWindup")}</span>
        </div>
      </div>

      <div>
        <Label className="mb-1.5">{t("sh_language")}</Label>
        <div className="flex flex-wrap gap-2">
          {([
            ["match", "sh_talkHowITalk", "sh_talkHowITalkWhy"],
            ["clean", "sh_keepItClean", "sh_keepItCleanWhy"],
          ] as const).map(([val, label, blurb]) => (
            <button
              key={val}
              type="button"
              onClick={() => { setR(val); setSaved(false); }}
              title={t(blurb)}
              className={
                r === val
                  ? "min-h-[44px] rounded-full border border-brand bg-brand px-4 text-sm font-medium text-white"
                  : "min-h-[44px] rounded-full border border-slate-300 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
              }
            >
              {t(label)}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-snug text-slate-500">{r === "match" ? t("sh_matchLine") : t("sh_cleanLine")}</p>
      </div>

      {/* STANDING ORDERS (0184) — the durable home for "keep it short". Nort writes this when you
          tell him how to work with you mid-conversation; this box is the off switch and the audit:
          a standing control you can't see is one you're right to distrust. */}
      <div>
        <Label className="mb-1.5">{t("sh_standingOrders")}</Label>
        <Textarea
          rows={3}
          value={n}
          placeholder={t("sh_standingOrdersPlaceholder")}
          onChange={(e) => { setN(e.target.value); setSaved(false); }}
        />
        <p className="mt-1 text-xs leading-snug text-slate-500">{t("sh_standingOrdersHow")}</p>
      </div>

      {/* THE LIMITS, SAID OUT LOUD. A swearing toggle with no stated boundary is a thing people are
          right to distrust, and the one that matters to a contractor is his own reputation. */}
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
        <strong className="font-medium text-slate-700">{t("sh_noneReachesCustomers")}</strong>{" "}
        {fillNodes(t("sh_toneLimits"), { you: <em>{t("sh_youWord")}</em> })}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setErr(null);
              // Pass the notes ONLY when this form actually changed them. Nort writes the same
              // column from the chat panel (remember_style); a Settings tab left open since before
              // that write holds a stale `n`, and sending it unconditionally deleted the standing
              // order he had just given. The guard for this already existed in the action — the
              // caller simply never triggered it.
              const res = await saveNortTone(h, r, n === notes ? undefined : n);
              if (!res.ok) return setErr(res.error);
              setSaved(true);
              router.refresh();
            })
          }
        >
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> {t("sh_saving")}</> : <><Check className="h-4 w-4" /> {t("sh_save")}</>}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
        {saved && !err && <span className="text-sm font-medium text-emerald-700">{t("sh_saved")}</span>}
      </div>
    </div>
  );
}
