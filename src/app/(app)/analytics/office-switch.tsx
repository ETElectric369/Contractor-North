"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOfficeSeesOwnerMoney } from "./actions";

/**
 * "Office Can See This": the owner's one control over who sees Left For You (0286). A real switch,
 * on by default. Only rendered for an owner; the server action and the DB trigger refuse anyone
 * else, so this is a convenience over a boundary, not the boundary. Saves on tap and says so; a
 * refusal puts the switch back and says why (nothing silent).
 */
export function OfficeCanSeeSwitch({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function flip() {
    const next = !on;
    setOn(next);
    setErr(null);
    start(async () => {
      const res = await setOfficeSeesOwnerMoney(next);
      if (!res.ok) {
        setOn(!next);
        setErr(res.error ?? "That didn't save. Try again.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Office Can See This"
        onClick={flip}
        disabled={pending}
        className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-60"
      >
        <span>Office Can See This</span>
        <span className={`relative block h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-brand" : "bg-slate-300"}`}>
          <span
            className={`absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`}
          />
        </span>
      </button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}
