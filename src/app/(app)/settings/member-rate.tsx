"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { updateMemberRate } from "./actions";

/** Inline pay + charge rate editor on the Team list. Pay = what you pay this
 *  person (job cost); Bill = what the customer is charged for their labor.
 *
 *  AN OWNER HAS NO PAY RATE (0286): he is paid by owner's draw, so his row has no Pay box and a save
 *  sends no pay figure (one for him would be refused, in the app and in the database).
 *
 *  HE DOES HAVE A BUILD-TIME COST RATE (0373; Erik, 2026-10-01: "build time, including my build time is
 *  considered COGS"). Where the crew's Pay box is, his row has a COST box: what an hour of his own build
 *  time costs the business. It is not a wage - nothing pays him it - and it is deliberately NOT seeded
 *  from his Bill box, because a cost equal to the price makes every hour he works net exactly $0, which
 *  is the defect 0286 was written to fix. Empty means nobody has said yet, and the line under the box
 *  says what that costs him in honest job margin rather than quietly costing his hours at $0.
 *
 *  AN EMPTY BILL BOX IS A REAL ANSWER, FOR THE OWNER TOO (Erik, audit v994 MR7): his hours then
 *  bill at the customer's level rate or the default labor rate, never his old stored wage. The
 *  server clears that wage with the bill rate, so the line below the box tells the truth. */
export function MemberRate({
  id,
  rate,
  billRate,
  costRate = null,
  paidByDraw = false,
}: {
  id: string;
  rate: number | null;
  billRate: number | null;
  /** The owner's build-time cost rate (0373). Null = not set; never defaulted to anything. */
  costRate?: number | null;
  paidByDraw?: boolean;
}) {
  const router = useRouter();
  const [pay, setPay] = useState(rate ?? 0);
  const [bill, setBill] = useState(billRate ?? 0);
  const [cost, setCost] = useState(costRate ?? 0);
  // THE BOXES SHOW WHAT BILLING USES (audit v994 MR7). They were seeded once, so after a save and
  // router.refresh() a box kept what was typed even when the server stored something else. Re-seed
  // whenever the rates the page read change (React's "adjust state on prop change" pattern, which
  // keeps the green check on screen instead of remounting it away).
  const [seen, setSeen] = useState({ rate, billRate, costRate });
  if (seen.rate !== rate || seen.billRate !== billRate || seen.costRate !== costRate) {
    setSeen({ rate, billRate, costRate });
    setPay(rate ?? 0);
    setBill(billRate ?? 0);
    setCost(costRate ?? 0);
  }
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function save() {
    const payChanged = !paidByDraw && (rate ?? 0) !== pay;
    const costChanged = paidByDraw && (costRate ?? 0) !== cost;
    if (!payChanged && !costChanged && (billRate ?? 0) === bill) return;
    start(async () => {
      // CHECK THE RESULT (audit v921 high): the action returns {ok:false,error} for a non-staff
      // caller or a rejected write, and the old code flashed the green check regardless — the
      // office thought a pay change saved when it hadn't. Only claim success on ok.
      //
      // AN OWNER'S SAVE SENDS NO PAY FIGURE AND A COST FIGURE; a crew member's sends a pay figure and
      // no cost figure. Two different questions, never the same box, never defaulted into each other.
      const res = paidByDraw
        ? await updateMemberRate(id, undefined, bill || null, cost || null)
        : await updateMemberRate(id, pay || null, bill || null);
      if (!res?.ok) {
        setErr(res?.error ?? "That didn't save — try again.");
        setPay(rate ?? 0);
        setBill(billRate ?? 0);
        setCost(costRate ?? 0);
        return;
      }
      setErr(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    });
  }

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      {paidByDraw ? (
        // THE OWNER'S BUILD-TIME COST BOX, where the crew's Pay box is. Never a wage: he is paid by
        // owner's draw and payroll refuses him. This is what an hour of his own build time COSTS, so
        // the jobs he works show an honest margin - and it must be well under his Bill rate, or his
        // own labour earns nothing.
        <span className="flex items-center gap-1" title="What an hour of the owner's own build time costs the business - a job cost, never a wage. Keep it below the Bill rate: that gap is the margin on the owner's labour.">
          Cost $
          <NumberInput value={cost} onValueChange={setCost} onBlur={save} className="h-7 w-14 text-right text-xs" aria-label="Build time cost rate" />
          /hr
        </span>
      ) : (
        <span className="flex items-center gap-1" title="What you pay this person — job cost">
          Pay $
          <NumberInput value={pay} onValueChange={setPay} onBlur={save} className="h-7 w-14 text-right text-xs" aria-label="Pay rate" />
          /hr
        </span>
      )}
      <span className="flex items-center gap-1" title="What the customer is charged — invoice labor">
        Bill $
        <NumberInput value={bill} onValueChange={setBill} onBlur={save} className="h-7 w-14 text-right text-xs" aria-label="Charge rate" />
        /hr
      </span>
      {/* NEVER BILLED AT THEIR PAY (audit v994 PL2). With no bill rate, their hours bill at the
          customer's level rate or your default labor rate. Said here, where it is fixed. */}
      {!(Number(billRate) > 0) && !pending && (
        <span className="text-amber-700" title="Invoices bill their hours at the customer's level rate or your default labor rate, never their pay">
          No bill rate set - bills at the level or default rate
        </span>
      )}
      {/* NOTHING SILENT (0373). Until the cost rate is set the owner's build time adds nothing to any
          job's cost, so every job he works reads more profitable than it is. Said here, where it is
          fixed, in the same shape as the missing-bill-rate line beside it. */}
      {paidByDraw && !(Number(costRate) > 0) && !pending && (
        <span className="text-amber-700" title="The owner's hours on a job are a direct cost of that job. With no cost rate they are counted and not costed, so those jobs read more profitable than they are. The company's Net Profit does not change either way.">
          No cost rate set - the owner&apos;s build time is not costed, so his jobs read high
        </span>
      )}
      {/* THE TRAP, SAID OUT LOUD. 0286 exists because his cost rate WAS his bill rate ($125 and $125):
          every hour he worked netted exactly $0 and all-time job profit read -$1,085 against a real
          +$35,847. A cost at or above the price is that bug coming back, so the box says so. */}
      {paidByDraw && Number(costRate) > 0 && Number(billRate) > 0 && Number(costRate) >= Number(billRate) && !pending && (
        <span className="text-amber-700" title="Cost is what the hour costs you; Bill is what the customer pays for it. At or above the bill rate, the owner's labour earns no margin at all.">
          Cost is not below Bill - the owner&apos;s hours earn no margin
        </span>
      )}
      {pending && <span className="text-slate-400">…</span>}
      {saved && <Check className="h-3.5 w-3.5 text-green-600" />}
      {err && <span className="text-rose-600">{err}</span>}
    </span>
  );
}
