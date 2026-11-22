"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HandCoins, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { SendSheet } from "@/components/send-sheet";
// The one Get Paid sheet, opened for the request's own bill (source "invoice"). It imports this file
// back for the job hub's link; both are used only at render time, so the two modules may name each other.
import { GetPaidButton } from "@/components/settle-up-button";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { formatCurrency } from "@/lib/utils";
import type { RequestRef } from "@/lib/payment-request";
import type { PrepaymentPurpose } from "@/lib/prepayments";
import { readPaymentRequestSeed, requestPayment, type PaymentRequestSeed, type PrepaymentView } from "@/app/(app)/billing/request-actions";

/**
 * REQUEST A PAYMENT (cn-v1177): ONE FORM, drawn as ONE <Modal>, never keyed or remounted (a key change
 * around an open Modal makes it close itself): every opening resets its fields with state and reads the
 * job again.
 *
 * Erik, 2026-11-21: "im curious if we can go into the job and request a materials payment via a link in
 * the get paid box (like a quick payment link that applies immediately to that job regardless of invoice
 * status)".
 *
 * A payment request is a small bill of its own kind (lib/prepayments): it has its own number, its own pay
 * link, and the next bill made on the job takes it off. So the form makes ONE thing (requestPayment) and
 * then hands the bill to the doors that already exist for a bill: the review-before-send sheet (Send the
 * Link, kind "invoice") and the one Get Paid sheet (Take It Now, source "invoice": card, Tap to Pay,
 * cash, check). Neither is a copy.
 *
 * WHAT IT SHOWS IS WHAT IS RECORDED (no speculation): a deposit is the figure the job's accepted estimate
 * stored; materials are the marked-up materials recorded on the job that no bill carries yet, less what
 * the job's requests still have to come off; nothing recorded is an EMPTY box that asks. One live deposit
 * request per estimate: when it stands, the form shows it and its doors, never a second Create.
 *
 * Staff only: every door that opens it is drawn for the office, and both reads refuse anyone else.
 */

type SeedOk = Extract<PaymentRequestSeed, { ok: true }>;

/** The pay-door facts a Get Paid sheet needs: ONE declaration, lib/payment-request PayDoorFacts, the shape
 *  the job page passes and the seed's own `payDoor` carries (cn-v1177 seams). */
import type { PayDoorFacts } from "@/lib/payment-request";
export type { PayDoorFacts };

export type RequestPhase =
  | { k: "reading" }
  | { k: "failed"; error: string }
  | { k: "form"; seed: SeedOk }
  | { k: "made"; seed: SeedOk; request: RequestRef; existing: boolean };

const cents = (n: number) => Math.round(n * 100) / 100;

/** A typed amount as a number above 0, or null ("$1,250.5" reads 1250.5). */
export function typedAmount(text: string): number | null {
  const s = (text ?? "").trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0.005 ? cents(n) : null;
}

/** What the Amount box starts with for a purpose: the recorded figure, or nothing (an empty box asks). */
export function prefillFor(seed: SeedOk, purpose: PrepaymentPurpose): string {
  if (purpose === "deposit") return !seed.deposit.request && seed.deposit.due > 0.005 ? cents(seed.deposit.due).toFixed(2) : "";
  if (purpose === "materials") return seed.materials.suggested > 0.005 ? cents(seed.materials.suggested).toFixed(2) : "";
  return "";
}

/** The purpose an opening starts on, when its door did not name one. */
export function firstPurpose(seed: SeedOk): PrepaymentPurpose {
  return seed.deposit.due > 0.005 && !seed.deposit.request ? "deposit" : "materials";
}

/** Why the job takes no request at all, in one sentence naming one action; null when it can. */
export function refusalKey(seed: SeedOk): string | null {
  if (seed.job.over) return "su_rp_jobOver";
  if (!seed.job.hasCustomer) return "su_rp_noCustomer";
  return null;
}

export function RequestPaymentSheet({
  jobId,
  open,
  onClose,
  purpose: startPurpose,
  payDoor,
}: {
  jobId: string;
  open: boolean;
  onClose: () => void;
  /** The purpose the door opened it on (New Invoice's Take a Deposit Instead: "deposit"). */
  purpose?: PrepaymentPurpose;
  payDoor?: PayDoorFacts;
}) {
  const router = useRouter();
  const lang = useLang();
  const langRef = useRef(lang);
  langRef.current = lang;
  const t = translator(lang);
  const [phase, setPhase] = useState<RequestPhase>({ k: "reading" });
  const [purpose, setPurpose] = useState<PrepaymentPurpose>(startPurpose ?? "deposit");
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<RequestRef | null>(null);
  const [busy, setBusy] = useState(false);
  /** ONE REQUEST PER PRESS: a second tap while the first is out finds this set and does nothing. */
  const inFlight = useRef(false);
  /** The opening an answer belongs to: an answer that lands after the sheet closed is dropped. */
  const openingRef = useRef(0);
  /** The bill the made step's two doors act on, and which of them is open on top of this sheet. */
  const [sendFor, setSendFor] = useState<RequestRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [payFor, setPayFor] = useState<RequestRef | null>(null);
  const [payOpen, setPayOpen] = useState(false);

  async function read() {
    const opening = openingRef.current;
    setPhase({ k: "reading" });
    try {
      const r = await readPaymentRequestSeed(jobId);
      if (opening !== openingRef.current) return;
      if (!r.ok) {
        setPhase({ k: "failed", error: r.error || translator(langRef.current)("su_rp_couldntRead") });
        return;
      }
      const p = startPurpose ?? firstPurpose(r);
      setPurpose(p);
      setAmount(prefillFor(r, p));
      setPhase({ k: "form", seed: r });
    } catch {
      if (opening !== openingRef.current) return;
      setPhase({ k: "failed", error: translator(langRef.current)("su_rp_couldntRead") });
    }
  }

  // EACH OPENING STARTS CLEAN (state, never a key): nothing typed, nothing said, one read.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      openingRef.current += 1;
      inFlight.current = false;
      setBusy(false);
      setNote(null);
      setBlocking(null);
      setName("");
      setAmount("");
      setSendOpen(false);
      setPayOpen(false);
      void read();
    }
    if (!open && wasOpen.current) openingRef.current += 1;
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function pick(p: PrepaymentPurpose) {
    if (busy || phase.k !== "form") return;
    setPurpose(p);
    setAmount(prefillFor(phase.seed, p));
    setNote(null);
    setBlocking(null);
  }

  async function create() {
    if (phase.k !== "form" || inFlight.current) return;
    const seed = phase.seed;
    if (refusalKey(seed)) return;
    if (purpose === "deposit" && seed.deposit.request) return; // its doors are drawn instead
    const n = typedAmount(amount);
    if (n == null) return setNote(t("su_rp_needAmount"));
    if (purpose === "other" && !name.trim()) return setNote(t("su_rp_needName"));
    inFlight.current = true;
    const opening = openingRef.current;
    setBusy(true);
    setNote(null);
    setBlocking(null);
    try {
      const r = await requestPayment({
        jobId,
        purpose,
        amount: n,
        label: purpose === "other" ? name.trim() : null,
        quoteId: purpose === "deposit" ? (seed.deposit.quote?.id ?? null) : null,
      });
      if (opening !== openingRef.current) return;
      if (r.ok) {
        setPhase({ k: "made", seed, request: r.request, existing: r.existing });
        router.refresh();
        return;
      }
      setNote(r.error || t("su_rp_didntGo"));
      if (r.request) setBlocking(r.request);
    } catch {
      if (opening === openingRef.current) setNote(t("su_rp_didntGo"));
    } finally {
      inFlight.current = false;
      if (opening === openingRef.current) setBusy(false);
    }
  }

  const cardEnabled = payDoor?.cardEnabled ?? (phase.k === "form" || phase.k === "made" ? phase.seed.canTakeCard : false);

  return (
    <>
      <Modal open={open} onClose={onClose} title={t("su_btn_requestAPayment")} size="sm" portal holdOpen={busy}>
        <RequestPaymentBody
          phase={phase}
          lang={lang}
          purpose={purpose}
          amount={amount}
          name={name}
          note={note}
          blocking={blocking}
          busy={busy}
          onPurpose={pick}
          onAmount={setAmount}
          onName={setName}
          onRetry={() => void read()}
          onCreate={() => void create()}
          onSend={(r) => {
            setSendFor(r);
            setSendOpen(true);
          }}
          onTake={(r) => {
            setPayFor(r);
            setPayOpen(true);
          }}
          onDone={onClose}
        />
      </Modal>
      {/* THE EXISTING SEND SHEET, for this bill, on top of the form (finish-job-button's pattern). */}
      {sendFor && <SendSheet kind="invoice" id={sendFor.id} number={sendFor.number} amount={sendFor.balance} textReady={payDoor?.textReady} open={sendOpen} onClose={() => setSendOpen(false)} />}
      {/* THE EXISTING GET PAID SHEET, for this bill. Keyed by the bill only while it is closed: a new
          request (a later opening of the form) is a new bill, and the sheet reads its bill once. */}
      {payFor && (
        <GetPaidButton
          key={payFor.id}
          source="invoice"
          invoiceId={payFor.id}
          balance={payFor.balance}
          trigger="none"
          open={payOpen}
          onClose={() => setPayOpen(false)}
          cardEnabled={cardEnabled}
          methods={payDoor?.methods}
          venmoConfigured={payDoor?.venmoConfigured}
          textReady={payDoor?.textReady}
        />
      )}
    </>
  );
}

/** The form's body for one phase: pure, so each state renders on its own (the tests draw it). */
export function RequestPaymentBody({
  phase,
  lang,
  purpose,
  amount,
  name,
  note,
  blocking = null,
  busy,
  onPurpose,
  onAmount,
  onName,
  onRetry,
  onCreate,
  onSend,
  onTake,
  onDone,
}: {
  phase: RequestPhase;
  lang: string;
  purpose: PrepaymentPurpose;
  amount: string;
  name: string;
  note: string | null;
  blocking?: RequestRef | null;
  busy: boolean;
  onPurpose: (p: PrepaymentPurpose) => void;
  onAmount: (v: string) => void;
  onName: (v: string) => void;
  onRetry: () => void;
  onCreate: () => void;
  onSend: (r: RequestRef) => void;
  onTake: (r: RequestRef) => void;
  onDone: () => void;
}) {
  const t = translator(lang);
  const money = (n: number) => formatCurrency(n, lang);
  const numberOf = (r: RequestRef) => r.number || t("su_rp_theRequest");
  const said = note ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{note}</p> : null;

  /** A request's doors: Open it, Send the Link, and Take It Now while something is owed on it. */
  const doors = (r: RequestRef) => (
    <div className="flex flex-wrap gap-2">
      <Button type="button" onClick={() => onSend(r)}>
        {t("su_btn_rpSendLink")}
      </Button>
      {r.balance > 0.005 && (
        <Button type="button" variant="outline" onClick={() => onTake(r)}>
          {t("su_btn_rpTakeItNow")}
        </Button>
      )}
      <Link href={`/billing/${r.id}`} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand hover:underline">
        {r.number ? fillText(t("su_btn_rpOpen"), { n: r.number }) : t("su_btn_rpOpenTheRequest")}
      </Link>
    </div>
  );

  if (phase.k === "reading") {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("su_rp_reading")}
      </p>
    );
  }
  if (phase.k === "failed") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-700">{phase.error}</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          {t("su_btn_tryAgain")}
        </Button>
      </div>
    );
  }
  if (phase.k === "made") {
    const r = phase.request;
    return (
      <div className="space-y-3">
        <p className="text-base font-semibold text-slate-900">
          {phase.existing
            ? fillText(t("su_rp_madeExisting"), { n: numberOf(r) })
            : fillText(t("su_rp_made"), { n: numberOf(r), amount: money(r.amount), name: r.label })}
        </p>
        <p className="text-sm text-slate-600">{t("su_rp_comesOff")}</p>
        {r.balance <= 0.005 && <p className="text-sm text-slate-600">{fillText(t("su_rp_isPaid"), { n: numberOf(r) })}</p>}
        {doors(r)}
        <Button type="button" variant="ghost" className="w-full" onClick={onDone}>
          {t("su_btn_done")}
        </Button>
      </div>
    );
  }

  const seed = phase.seed;
  const refusal = refusalKey(seed);
  if (refusal) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-700">{t(refusal)}</p>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("su_btn_done")}
        </Button>
      </div>
    );
  }

  const live = purpose === "deposit" ? seed.deposit.request : null;
  const choices: { p: PrepaymentPurpose; key: string }[] = [
    { p: "deposit", key: "su_btn_rpDeposit" },
    { p: "materials", key: "su_btn_rpMaterials" },
    { p: "other", key: "su_btn_rpOther" },
  ];
  return (
    <div className="space-y-4">
      {said}
      {blocking && doors(blocking)}
      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">{t("su_rp_whatFor")}</div>
        <div role="radiogroup" aria-label={t("su_rp_whatFor")} className="grid grid-cols-3 gap-2">
          {choices.map((c) => (
            <button
              key={c.p}
              type="button"
              role="radio"
              aria-checked={purpose === c.p}
              disabled={busy}
              onClick={() => onPurpose(c.p)}
              className={`min-h-11 rounded-lg border px-3 text-sm font-medium ${
                purpose === c.p ? "border-brand bg-brand-light text-brand-dark" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {t(c.key)}
            </button>
          ))}
        </div>
      </div>

      {live ? (
        // ONE LIVE DEPOSIT REQUEST PER ESTIMATE: it is shown with its doors, and no second Create.
        <div className="space-y-3">
          <p className="text-sm text-slate-700">{fillText(t("su_rp_depositLive"), { n: numberOf(live) })}</p>
          {live.balance <= 0.005 && <p className="text-sm text-slate-600">{fillText(t("su_rp_isPaid"), { n: numberOf(live) })}</p>}
          {doors(live)}
        </div>
      ) : (
        <>
          {purpose === "other" && (
            <div>
              <label htmlFor="rq-name" className="mb-1 block text-xs font-medium text-slate-600">
                {t("su_rp_name")}
              </label>
              <input
                autoComplete="off"
                id="rq-name"
                value={name}
                maxLength={80}
                disabled={busy}
                onChange={(e) => onName(e.target.value)}
                className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm"
              />
              <p className="mt-1 text-xs text-slate-500">{t("su_rp_nameHint")}</p>
            </div>
          )}
          <div>
            <label htmlFor="rq-amount" className="mb-1 block text-xs font-medium text-slate-600">
              {t("su_amount")}
            </label>
            <input
              autoComplete="off"
              id="rq-amount"
              inputMode="decimal"
              value={amount}
              disabled={busy}
              onChange={(e) => onAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCreate();
                }
              }}
              placeholder={t("su_amountPlaceholder")}
              className="h-11 w-full rounded-lg border border-slate-200 px-3 text-lg font-semibold tabular-nums"
            />
            {purpose === "deposit" && (
              <p className="mt-1 text-xs text-slate-500">
                {seed.deposit.due > 0.005
                  ? fillText(t("su_rp_depositStated"), { n: seed.deposit.quote?.number || t("su_rp_theEstimate") })
                  : t("su_rp_noDepositStated")}
              </p>
            )}
            {purpose === "materials" && (
              <div className="mt-1 space-y-0.5 text-xs text-slate-500">
                {seed.materials.unbilled > 0.005 ? (
                  <p>{fillText(t("su_rp_materialsRecorded"), { amount: money(seed.materials.unbilled) })}</p>
                ) : (
                  <p>{t("su_rp_noMaterials")}</p>
                )}
                {seed.leftToNet > 0.005 && <p>{fillText(t("su_rp_alreadyAhead"), { amount: money(seed.leftToNet) })}</p>}
              </div>
            )}
          </div>
          <p className="text-sm text-slate-600">{t("su_rp_comesOff")}</p>
          <Button type="button" className="w-full" disabled={busy} onClick={onCreate}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? t("su_btn_rpCreating") : t("su_btn_rpCreate")}
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * THE INVOICES TAB'S DOOR (cn-v1177): a quiet button beside New Invoice, on every job, a job billed with
 * draws included (the header's Get Paid is hidden there). The form is mounted on its first opening and
 * never unmounted after.
 */
export function RequestPaymentButton({ jobId, payDoor }: { jobId: string; payDoor?: PayDoorFacts }) {
  const t = translator(useLang());
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <HandCoins className="h-4 w-4" /> {t("su_btn_requestAPayment")}
      </Button>
      {mounted && <RequestPaymentSheet jobId={jobId} open={open} onClose={() => setOpen(false)} payDoor={payDoor} />}
    </>
  );
}

/** Each request's state word: Paid when nothing is owed on it, else Unpaid (no clock here: never amber). */
export function requestPaidWord(r: Pick<PrepaymentView, "balance">): "su_pa_paid" | "su_pa_unpaid" {
  return r.balance <= 0.005 ? "su_pa_paid" : "su_pa_unpaid";
}

/**
 * PAID AHEAD (cn-v1177), on the Invoices tab above the invoice cards, only when the job has a live
 * request: each one's number, name, amount and Paid or Unpaid; what each later bill took off; what still
 * comes off the next invoice; and, on a job that is over, money in hand that no bill used, with the door
 * to the bill its refund is taken from. Staff only (the page mounts it inside the office's tab).
 */
export function PaidAheadCard({
  seed,
  readError,
}: {
  seed: { requests: PrepaymentView[]; leftToNet: number; jobOver: boolean } | null;
  /** The read failed: said, never an empty card. */
  readError?: boolean;
}) {
  const lang = useLang();
  const t = translator(lang);
  const money = (n: number) => formatCurrency(n, lang);
  if (readError) return <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{t("su_pa_couldntRead")}</p>;
  if (!seed || seed.requests.length === 0) return null;
  return (
    <div className="rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="mb-2 text-sm font-semibold text-slate-800">{t("su_pa_title")}</div>
      <ul className="space-y-2">
        {seed.requests.map((r) => {
          const paidWord = requestPaidWord(r);
          return (
            <li key={r.id} className="text-sm">
              <div className="flex items-center justify-between gap-3">
                <Link href={`/billing/${r.id}`} className="min-w-0 truncate font-semibold text-slate-900 hover:underline">
                  {r.number || t("su_btn_rpTheRequest")} · {r.label}
                </Link>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums text-slate-900">{money(r.amount)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${paidWord === "su_pa_paid" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                    {t(paidWord)}
                  </span>
                </span>
              </div>
              {paidWord === "su_pa_unpaid" && r.paid > 0.005 && <p className="text-xs text-slate-500">{fillText(t("su_pa_partPaid"), { amount: money(r.paid) })}</p>}
              {r.taken.map((x) => (
                <p key={x.invoiceId} className="text-xs text-slate-500">
                  {fillText(t("su_pa_tookOff"), { n: x.number || t("su_pa_anInvoice"), amount: money(x.amount) })}
                </p>
              ))}
              {seed.jobOver && r.moneyLeft > 0.005 && (
                <p className="mt-1 text-xs text-slate-700">
                  {fillText(t("su_pa_neverUsed"), { amount: money(r.moneyLeft), n: r.number || t("su_rp_theRequest") })}{" "}
                  <Link href={`/billing/${r.id}`} className="inline-flex min-h-11 items-center font-medium text-brand underline">
                    {r.number ? fillText(t("su_btn_rpOpen"), { n: r.number }) : t("su_btn_rpOpenTheRequest")}
                  </Link>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {seed.leftToNet > 0.005 && <p className="mt-2 border-t border-slate-100 pt-2 text-sm text-slate-700">{fillText(t("su_pa_leftToNet"), { amount: money(seed.leftToNet) })}</p>}
    </div>
  );
}
