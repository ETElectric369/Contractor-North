"use client";

import { useState } from "react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { Input, Label } from "@/components/ui/input";
import { DayField } from "@/components/day-field";
import { InfoPopup } from "@/components/info-popup";
import { formatCurrency } from "@/lib/utils";
import { leftByPeriod, periodLabel, type PayMethod, type PersonBalance } from "@/lib/payroll-math";
import { paymentMethodChoices } from "@/lib/payment-method";
import { PAYMENT_LANDS_FACTS } from "./payroll-facts";

/** A chip's element id, from its key ("apple cash" → pay-method-apple-cash). The How label points at the first. */
const chipId = (key: string) => `pay-method-${key.replace(/[^a-z0-9]+/g, "-")}`;

export type PayFields = {
  amount: number;
  paidOn: string;
  /** The KEY of the chip he tapped (lib/payment-method: Venmo → venmo), never its words. */
  method: PayMethod;
  reference?: string;
  note?: string;
};

/**
 * ── THE FORM THAT RECORDS A PAYMENT ───────────────────────────────────────────────────────────
 *
 * UNCHANGED, FIELD FOR FIELD AND GUARD FOR GUARD. It moved out of payroll-view for two reasons, and
 * neither is cosmetic:
 *
 *  · IT IS NOW THE ONLY WAY IN. A person's card used to BE this form's button; now the card opens his
 *    statement and this opens from one named control at the foot of it. A form that pays a man should
 *    be a thing you went and got.
 *  · THE EMPTY AMOUNT IS NOW STRUCTURAL. It lives on a component the page mounts only while the form
 *    is open, so every open starts from this component's own initial state. Before, five setState
 *    calls in openPay had to remember to clear it, and anybody adding a sixth field had to remember
 *    too. The app NEVER invents a paycheck figure — Erik: "sometimes i need to throw his a few
 *    hundred or an off ammount" — and now nothing has to remember that.
 *
 * THE WRITE IS NOT HERE. The page owns it (recordPayment, its refusal, its sentence and its Undo),
 * so this sheet cannot grow a second write path of its own.
 *
 * ── HOW HE PAID COMES FROM THE ONE LIST (cn-v1152) ────────────────────────────────────────────
 *
 * Erik, 2026-11-07: "there are some payment entry windows that show venmo as an option then others
 * that dont … i had to add venmo in the notes and now in the invoice im creating … i just recorded a
 * payment with a venmo button". This form kept a list of four words of its own (cash, check,
 * transfer, other — the 0264 CHECK's), so the Venmo he actually paid with had to go in the note.
 * The chips are now the company's Settings › Payment methods, the same list the customer's Get Paid
 * sheet draws (lib/payment-method paymentMethodChoices: one chip per key, the company's own spelling
 * as its words), the first one pressed to begin with, and what is submitted is the chip's KEY
 * (Venmo → venmo), which 0406 lets the column hold. An empty list draws the house default.
 */
export function PaySheet({
  person,
  periods,
  onClock,
  today,
  saving,
  error,
  methods,
  onCancel,
  onSubmit,
}: {
  person: PersonBalance;
  /** This person's UNLOCKED pay periods — what the typed figure is going against. */
  periods: { start: string; end: string; gross: number }[];
  onClock: boolean;
  /** The ORG's today (lib/tz), the Paid On default. Never the browser's day. */
  today: string;
  /** True while the write is out: the footer says "Saving…", both buttons go dead, and the sheet
   *  holds itself open so the answer has somewhere to land. */
  saving: boolean;
  /** A refusal from the server, kept by the page so it survives this component's own state. */
  error: string | null;
  /** The company's ways money moves, as typed in Settings › Payment methods (settings.payment_methods).
   *  The chips, in this order; the first is pressed to begin with. Empty draws the house default. */
  methods: string[];
  onCancel: () => void;
  onSubmit: (fields: PayFields) => void;
}) {
  // THE AMOUNT STARTS EMPTY (null), EVERY OPEN, ON PURPOSE — the same law the mileage modal has
  // carried since 0095. A pre-filled number here, even the balance above, would be the app inventing
  // a paycheck figure. This is initial state on a component that mounts fresh each open, so there is
  // no reset to forget.
  const [amount, setAmount] = useState<number | null>(null);
  const [paidOn, setPaidOn] = useState(today);
  // THE CHIPS: the company's list, one per key, the first pressed. The state holds the KEY.
  const choices = paymentMethodChoices(methods);
  const firstMethod: PayMethod = choices[0]?.key ?? "other";
  const [method, setMethod] = useState<PayMethod>(firstMethod);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  // The same rows the statement draws: what is LEFT on each open period, the money already paid
  // landed oldest first — so the figure he is about to type is measured against what each period
  // still costs to close, not against a gross a sentence then subtracts from.
  const { rows } = leftByPeriod(periods, person.owed);
  const dirty = amount !== null || reference !== "" || note !== "" || paidOn !== today || method !== firstMethod;
  const ready = amount !== null && amount > 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Pay ${person.name}`}
      size="sm"
      dirty={dirty}
      /**
       * WHILE THE WRITE IS OUT, THIS SHEET CANNOT BE DISMISSED. Without it, the X, a tap outside or
       * Escape closed the form mid-write; if the server then refused, the refusal was drawn NOWHERE
       * (it only ever rendered inside the form) and the typed amount was gone with it — so the next
       * thing that happened was a second payment being typed from memory. It is the exact bug
       * 21f6e37c fixed for Which Job. Back still closes (Modal says why), which is why the page
       * writes a refusal to its own banner as well as to this one.
       */
      holdOpen={saving}
      footer={
        <ModalActions
          onCancel={onCancel}
          onSave={() => ready && onSubmit({ amount, paidOn, method, reference: reference.trim() || undefined, note: note.trim() || undefined })}
          saveLabel={ready ? `Record ${formatCurrency(amount)} Paid` : "Record Payment"}
          disabled={!ready}
          saving={saving}
        />
      }
    >
      <div className="space-y-4">
        {/* WHAT THE TYPED FIGURE IS GOING AGAINST. This one prints the balance even while a shift is
            running, where the statement withholds it, and that is deliberate: here he is about to
            type a number against these periods, so the number he is measuring it against belongs in
            front of him — with the caveat attached, two lines below, as it has always been. */}
        <div className="rounded-lg bg-slate-50 px-3 py-2.5">
          <div className="text-sm font-semibold text-slate-900">
            {person.owed > 0.005
              ? `Owed ${formatCurrency(person.owed)}`
              : person.owed < -0.005
                ? `${formatCurrency(-person.owed)} ahead`
                : "Paid up"}
          </div>
          {rows.length > 0 && (
            <div className="mt-0.5 text-xs text-slate-500">
              {rows.map((r) => `${periodLabel(r.start, r.end)} ${r.left > 0.005 ? `${formatCurrency(r.left)} left` : "covered"}`).join(" · ")}
            </div>
          )}
          {onClock && <div className="mt-1 text-xs text-amber-700">A shift is still on the clock, so this is not final yet.</div>}
        </div>

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div>
          <Label htmlFor="pay-amount">Amount You Paid</Label>
          {/* Starts EMPTY, required. No default, no suggested figure, not even the balance above. */}
          <NumberInput id="pay-amount" value={amount ?? 0} onValueChange={(n) => setAmount(n)} placeholder="0.00" autoFocus />
        </div>

        <div>
          <Label htmlFor="pay-on">Paid On</Label>
          {/* Defaults to the org's today and stays editable: he pays early, and he pays for last
              Friday on a Monday. */}
          <DayField id="pay-on" value={paidOn} onChange={(iso) => setPaidOn(iso)} />
        </div>

        <div>
          <Label htmlFor={chipId(firstMethod)}>How</Label>
          {/* The company's own words on each chip (as typed in Settings); the KEY goes with the write. */}
          <div className="grid grid-cols-3 gap-2">
            {choices.map((m) => (
              <button
                key={m.key}
                id={chipId(m.key)}
                type="button"
                onClick={() => setMethod(m.key)}
                aria-pressed={method === m.key}
                className={`min-h-[44px] rounded-lg border px-2 text-sm font-medium transition-colors ${
                  method === m.key
                    ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-ink))] text-white"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label htmlFor="pay-ref">Check number or reference (optional)</Label>
          <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. check #1042" />
        </div>

        <div>
          <Label htmlFor="pay-note">Note (optional)</Label>
          <Input id="pay-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. cash on the Wilson job" />
        </div>

        {/* ONE LINE, THE REST BEHIND THE ICON AS BULLETS. This was a four-line paragraph sitting
            between him and the Record button. Nothing is cut — PAYMENT_LANDS_FACTS holds it all. */}
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-1">
          <span className="min-w-0 text-xs text-slate-500">It pays off whole pay periods, oldest first.</span>
          <InfoPopup
            title="How a Payment Lands"
            label="About How a Payment Lands"
            bullets={PAYMENT_LANDS_FACTS}
            className="-my-1 -mr-2"
          />
        </div>
      </div>
    </Modal>
  );
}
