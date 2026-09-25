"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOfficeSeesOwnerMoney } from "./actions";
import { callOrLost } from "@/lib/lost-signal";

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
  // The stored value, re-read on every refresh, wins over the local one: after a lost answer the
  // page "is checking", and this is where the check lands. Without it `initial` was read once, so
  // a write that committed before the answer was lost left the switch showing the old setting
  // while the database held the new one. A stored value that moved answers the "may not have
  // moved" sentence too, so that goes. (Adjusting state during render: React's pattern for
  // following a prop, no effect and no extra paint.)
  const [stored, setStored] = useState(initial);
  if (initial !== stored) {
    setStored(initial);
    setOn(initial);
    setErr(null);
  }

  function flip() {
    const next = !on;
    setOn(next);
    setErr(null);
    start(async () => {
      // A dropped signal rejects (audit v994 SI2): the optimistic flip goes back and it says so,
      // then the page re-reads the truth in case the write landed anyway.
      const res = await callOrLost(() => setOfficeSeesOwnerMoney(next), "Couldn't reach the server, so the switch may not have moved. The page is checking.");
      if (!res.ok) {
        setOn(!next);
        setErr(res.error ?? "That didn't save. Try again.");
        if ("lost" in res) router.refresh();
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
