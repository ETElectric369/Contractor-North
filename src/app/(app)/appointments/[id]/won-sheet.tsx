"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { formatCurrency } from "@/lib/utils";
import {
  applyWonOverrides,
  wonTotals,
  type BillingKind,
  type WonLine,
  type WonOverride,
  type WonRef,
  type WonSheet as WonSheetRead,
} from "@/lib/appointments/won-sheet";
import { addressWithoutWon } from "@/lib/appointments/inspection-page";
import { approveVisitEstimate, readWonSheet } from "../won-actions";
import { startJobFromSale } from "../start-job-actions";
import { linkAppointmentTo } from "../actions";

/**
 * WON · START THE JOB (cn-v1176): ONE sheet, drawn as ONE <Modal> inside the Inspector, always
 * rendered for the office and NEVER keyed or remounted (a key change around an open Modal makes it
 * close itself: everything here is reset with state when it opens).
 *
 * The owner, 2026-11-21: "an instant create and approve estimate button at the bottom which would run
 * the proper cycle of things, streamline the new workflow properly and pop into the new job having a
 * proper record and simplify our environment while safeguarding the data at the same time".
 *
 * THE SERVER DECIDES WHAT IS SHOWN (appointments/won-actions readWonSheet): the lines, the totals, the
 * estimate that already stands, the job that already exists. The sheet draws only that, and sends back
 * KEYS and TYPED NUMBERS, never lines or totals of its own making (the totals it redraws while a number
 * is typed come from the same wonTotals the server's own lines are totalled with). The id a new
 * estimate is saved under is minted ONCE per opening and reused on every retry of that opening, so a
 * second tap, a dropped answer or a retry lands on the one row. No browser confirm anywhere.
 */

/** A sentence that starts with the estimate's name starts with a capital, numbered or not. */
const capFirst = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);

/** What the read answered, when it answered. */
type ReadOk = Extract<WonSheetRead, { ok: true }>;

/** Where the sheet is in one opening. */
export type WonPhase =
  | { k: "reading" }
  | { k: "failed"; error: string }
  | { k: "sheet"; sheet: ReadOk }
  | { k: "plain_chosen"; noCustomer: boolean }
  | { k: "done"; how: "approve" | "plain"; quote: WonRef | null; total: number | null; job: WonRef; warnings?: string[] };

/** What he typed on a hole row: the text as typed (a half-typed "1." stays "1."), and Remove. */
export type WonTyped = Record<string, { qty?: string; price?: string; remove?: boolean }>;

/** A typed box as a number, or nothing: empty or not a number sends nothing for that box; a quantity
 *  must be above 0 and a price 0 or more (the door's own rule, won-sheet overrideProblem), so the sheet
 *  never sends a number the save would refuse. */
function typedNumber(text: string | undefined, min: "above0" | "atLeast0"): number | undefined {
  const s = (text ?? "").trim().replace(/[$,]/g, "");
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return (min === "above0" ? n > 0 : n >= 0) ? n : undefined;
}

/** What a hole row's box shows before he types in it: what the line already knows, else empty. */
export const prefillQty = (l: WonLine) => (l.quantity > 0 ? String(l.quantity) : "");
export const prefillPrice = (l: WonLine) => (l.unitPrice > 0 ? String(l.unitPrice) : "");

/** The overrides the server is sent: by key, only for a row he removed or typed in. A row he typed in
 *  sends BOTH boxes as they read on the screen (a box he left alone reads what the line knew), so a
 *  count typed on a line whose price is known answers it the way the screen shows. */
export function overridesFromTyped(lines: WonLine[], typed: WonTyped): WonOverride[] {
  const out: WonOverride[] = [];
  for (const l of lines) {
    const v = typed[l.key];
    if (!v) continue;
    if (v.remove) {
      out.push({ key: l.key, remove: true });
      continue;
    }
    if (v.qty === undefined && v.price === undefined) continue;
    const quantity = typedNumber(v.qty ?? prefillQty(l), "above0");
    const unitPrice = typedNumber(v.price ?? prefillPrice(l), "atLeast0");
    if (quantity === undefined && unitPrice === undefined) continue;
    out.push({ key: l.key, ...(quantity !== undefined ? { quantity } : {}), ...(unitPrice !== undefined ? { unitPrice } : {}) });
  }
  return out;
}

/** The lines and totals the sheet shows for an estimate read, with what he typed applied through the
 *  ONE rule (applyWonOverrides, wonTotals), and whether a hole is left. An existing estimate is shown
 *  exactly as stored: its own lines and its own totals, nothing applied. */
export function wonView(sheet: Extract<ReadOk, { state: "estimate" }>, typed: WonTyped) {
  if (sheet.source !== "visit") {
    return {
      lines: sheet.lines,
      totals: { subtotal: sheet.subtotal, tax: sheet.tax, total: sheet.total },
      // An estimate with no lines at all is a hole too (cn-v1176 fix F7): it is answered on that estimate.
      holesLeft: sheet.lines.length === 0 || sheet.lines.some((l) => l.hole !== null),
      pricedLeft: sheet.lines.length > 0,
    };
  }
  const applied = applyWonOverrides(sheet.lines, overridesFromTyped(sheet.lines, typed));
  return {
    lines: applied,
    totals: wonTotals(applied, sheet.taxRate),
    holesLeft: applied.some((l) => l.hole !== null),
    pricedLeft: applied.length > 0,
  };
}

export function WonSheet({ appointmentId, open, onClose }: { appointmentId: string; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const lang = useLang();
  const langRef = useRef(lang);
  langRef.current = lang;
  const [phase, setPhase] = useState<WonPhase>({ k: "reading" });
  const [billing, setBilling] = useState<BillingKind>("tm");
  const [typed, setTyped] = useState<WonTyped>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** The id a NEW estimate is saved under: minted once per opening, reused on every retry of it. */
  const quoteIdRef = useRef<string | null>(null);
  /** Whether he picked the billing kind himself in this opening (a re-read then keeps his pick). */
  const billingPickedRef = useRef(false);
  /** The opening a read belongs to: an answer that comes back after the sheet closed is dropped. */
  const openingRef = useRef(0);

  async function read(keepNote = false) {
    const opening = openingRef.current;
    setPhase({ k: "reading" });
    if (!keepNote) setNote(null);
    try {
      const r = await readWonSheet(appointmentId);
      if (opening !== openingRef.current) return;
      if (!r.ok) {
        setPhase({ k: "failed", error: r.error });
        return;
      }
      if (!billingPickedRef.current && (r.state === "estimate" || r.state === "plain" || r.state === "finish")) setBilling(r.billingKind);
      setPhase({ k: "sheet", sheet: r });
    } catch {
      if (opening !== openingRef.current) return;
      setPhase({ k: "failed", error: translator(langRef.current)("vi_wonCouldntRead") });
    }
  }

  // EACH OPENING STARTS CLEAN (state, never a key): a new id, nothing typed, and one read.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      openingRef.current += 1;
      quoteIdRef.current = crypto.randomUUID();
      billingPickedRef.current = false;
      setTyped({});
      setBusy(false);
      setNote(null);
      void read();
    }
    if (!open && wasOpen.current) openingRef.current += 1;
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const t = translator(lang);

  async function approve(quoteId: string, stamp: string, overrides: WonOverride[]) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await approveVisitEstimate({ appointmentId, quoteId, stamp, overrides, billingType: billing });
      if (r.ok && r.job) {
        setPhase({ k: "done", how: "approve", quote: r.quote, total: r.total, job: r.job, warnings: r.warnings });
        router.refresh();
        return;
      }
      if (r.ok) {
        // Accepted, and no job was made: said, and read again (the sheet then offers to finish it).
        setNote(r.warnings.join(" ") || capFirst(fillText(t("vi_wonFinish"), { n: r.quote.number || t("vi_wonTheEstimate") })));
        router.refresh();
        await read(true);
        return;
      }
      setNote(r.error);
      if (r.reread) await read(true);
    } catch {
      setNote(t("vi_wonCouldntApprove"));
    } finally {
      setBusy(false);
    }
  }

  async function startPlain() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await startJobFromSale(appointmentId, { billingType: billing });
      if (r.ok) {
        setPhase({ k: "done", how: "plain", quote: null, total: null, job: r.job, warnings: r.warnings });
        router.refresh();
        return;
      }
      // A refusal is said and the sheet reads again (cn-v1176 fix F1): an estimate that stands since this
      // was shown is then drawn with its own button, the one the sentence names.
      setNote(r.error);
      await read(true);
    } catch {
      setNote(t("vi_wonCouldntStart"));
    } finally {
      setBusy(false);
    }
  }

  /** THE REFER STATE'S ONE BUTTON (cn-v1176 fix F9): ties this inspection to the job its lead's accepted
   *  estimate already has, through the existing attach door (linkAppointmentTo), then reads again (the
   *  sheet then shows that job). */
  async function tie(job: WonRef) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await linkAppointmentTo(appointmentId, "job", job.id);
      if (!r.ok) setNote(r.error ?? t("vi_wonCouldntTie"));
      else router.refresh();
      await read(true);
    } catch {
      setNote(t("vi_wonCouldntTie"));
    } finally {
      setBusy(false);
    }
  }

  function onApprove() {
    if (phase.k !== "sheet" || phase.sheet.state !== "estimate") return;
    const s = phase.sheet;
    if (s.source === "visit") {
      if (!quoteIdRef.current) return; // minted when it opened; never a second id for one opening
      void approve(quoteIdRef.current, s.stamp, overridesFromTyped(s.lines, typed));
    } else if (s.quote) {
      void approve(s.quote.id, s.stamp, []);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("vi_btn_wonStartTheJob")} holdOpen={busy} size="md">
      <WonSheetBody
        phase={phase}
        lang={lang}
        billing={billing}
        onBilling={(b) => {
          billingPickedRef.current = true;
          setBilling(b);
        }}
        typed={typed}
        onTyped={(key, patch) => setTyped((cur) => ({ ...cur, [key]: { ...cur[key], ...patch } }))}
        busy={busy}
        note={note}
        onRetry={() => void read()}
        onApprove={onApprove}
        onFinish={(quote) => void approve(quote.id, "", [])}
        onChoosePlain={() => {
          const noCustomer = phase.k === "sheet" && (phase.sheet.state === "estimate" || phase.sheet.state === "plain") ? phase.sheet.noCustomer : false;
          setNote(null);
          setPhase({ k: "plain_chosen", noCustomer });
        }}
        onStartPlain={() => void startPlain()}
        onTie={(job) => void tie(job)}
      />
    </Modal>
  );
}

/**
 * THE SHEET WHERE THE INSPECTOR IS NOT DRAWN (cn-v1176 fix F2): an inspection whose page draws no
 * Inspector (Leads off with nothing captured, or an inspection read that failed) is still opened by the
 * lists' and the ending card's `?won=1`. The same address rule as the Inspector's: `won` comes off the
 * address first (no scroll jump), then the sheet opens; closing changes no address. No save to wait for.
 */
export function WonSheetHost({ appointmentId, wonAsked }: { appointmentId: string; wonAsked: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const fromAddressRef = useRef(false);
  useEffect(() => {
    if (wonAsked) {
      fromAddressRef.current = true;
      if (typeof window === "undefined") return;
      const { pathname, search, hash } = window.location;
      router.replace(addressWithoutWon(pathname, search, hash), { scroll: false });
      return;
    }
    if (fromAddressRef.current) {
      fromAddressRef.current = false;
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wonAsked]);
  return <WonSheet appointmentId={appointmentId} open={open} onClose={() => setOpen(false)} />;
}

/** The sheet's body for one phase: pure, so each state renders on its own (the tests draw it). */
export function WonSheetBody({
  phase,
  lang,
  billing,
  onBilling,
  typed,
  onTyped,
  busy,
  note,
  onRetry,
  onApprove,
  onFinish,
  onChoosePlain,
  onStartPlain,
  onTie = () => {},
}: {
  phase: WonPhase;
  lang: string;
  billing: BillingKind;
  onBilling: (b: BillingKind) => void;
  typed: WonTyped;
  onTyped: (key: string, patch: { qty?: string; price?: string; remove?: boolean }) => void;
  busy: boolean;
  note: string | null;
  onRetry: () => void;
  onApprove: () => void;
  onFinish: (quote: WonRef) => void;
  onChoosePlain: () => void;
  onStartPlain: () => void;
  /** The refer state's Tie button (cn-v1176 fix F9). */
  onTie?: (job: WonRef) => void;
}) {
  const t = translator(lang);
  const money = (n: number) => formatCurrency(n, lang);
  const estimateName = (q: WonRef | null) => q?.number || t("vi_wonTheEstimate");
  const cap = capFirst;
  const jobName = (j: WonRef) => j.number || t("vi_wonTheJob");
  const said = note ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{note}</p> : null;
  const spin = busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null;

  const billingChoice = (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-500">{t("ag_rail_billing")}</div>
      <div role="radiogroup" aria-label={t("ag_rail_billing")} className="flex gap-2">
        {(["tm", "fixed"] as const).map((b) => (
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={billing === b}
            disabled={busy}
            onClick={() => onBilling(b)}
            className={`min-h-[44px] flex-1 rounded-lg border px-3 text-sm font-medium ${
              billing === b ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-tint))]/10 text-slate-900" : "border-slate-300 bg-white text-slate-600"
            }`}
          >
            {t(b === "tm" ? "ag_rail_billingTm" : "ag_rail_billingFixed")}
          </button>
        ))}
      </div>
    </div>
  );
  const noCustomerLine = <p className="text-xs text-slate-500">{t("vi_wonNoCustomer")}</p>;

  if (phase.k === "reading") {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("vi_wonReading")}
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
  if (phase.k === "done") {
    return (
      <div className="space-y-3">
        <p className="text-base font-semibold text-slate-900">
          {phase.how === "approve"
            ? fillText(t("vi_wonApproved"), { n: estimateName(phase.quote), total: money(phase.total ?? 0) })
            : t("vi_wonJobStarted")}
        </p>
        {/* A warning is never dropped: each one the server said, under the line, as it worded it. */}
        {(phase.warnings ?? []).map((w, i) => (
          <p key={i} className="text-sm text-slate-600">
            {w}
          </p>
        ))}
        {/* cn-v1177: the deposit goes here */}
        <div className="flex flex-wrap gap-2">
          <Link href={`/jobs/${phase.job.id}`}>
            <Button type="button">{t("ag_btn_openTheJob")}</Button>
          </Link>
          {phase.how === "approve" && phase.quote && (
            <Link href={`/quotes/${phase.quote.id}`}>
              <Button type="button" variant="ghost">{t("vi_btn_openTheEstimate")}</Button>
            </Link>
          )}
        </div>
      </div>
    );
  }
  if (phase.k === "plain_chosen") {
    return (
      <div className="space-y-3">
        {said}
        <p className="text-sm text-slate-700">{t("vi_wonNoEstimateChosen")}</p>
        {billingChoice}
        {phase.noCustomer && noCustomerLine}
        <Button type="button" className="w-full" disabled={busy} onClick={onStartPlain}>
          {spin}
          {t("vp_btn_startTheJob")}
        </Button>
      </div>
    );
  }

  const s = phase.sheet;
  if (s.state === "has_job") {
    return (
      <div className="space-y-3">
        {said}
        <p className="text-sm text-slate-700">{fillText(t("vi_wonHasJob"), { j: jobName(s.job) })}</p>
        <Link href={`/jobs/${s.job.id}`}>
          <Button type="button">{t("ag_btn_openTheJob")}</Button>
        </Link>
      </div>
    );
  }
  if (s.state === "refer") {
    // The one button names the job; the sentence names the button by its exact words.
    const tieWords = s.job.number ? fillText(t("vi_btn_wonTieTo"), { j: s.job.number }) : t("vi_btn_wonTieToTheJob");
    return (
      <div className="space-y-3">
        {said}
        <p className="text-sm text-slate-700">{cap(fillText(t("vi_wonRefer"), { n: estimateName(s.quote), j: jobName(s.job), tie: tieWords }))}</p>
        <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => onTie(s.job)}>
          {spin}
          {tieWords}
        </Button>
      </div>
    );
  }
  if (s.state === "finish") {
    return (
      <div className="space-y-3">
        {said}
        <p className="text-sm text-slate-700">{cap(fillText(t("vi_wonFinish"), { n: estimateName(s.quote) }))}</p>
        {billingChoice}
        <Button type="button" className="w-full" disabled={busy} onClick={() => onFinish(s.quote)}>
          {spin}
          {s.quote.number ? fillText(t("vi_btn_wonFinishFrom"), { n: s.quote.number }) : t("vi_btn_wonFinishFromTheEstimate")}
        </Button>
      </div>
    );
  }
  if (s.state === "plain") {
    return (
      <div className="space-y-3">
        {said}
        <p className="text-sm text-slate-700">{t(s.why === "estimates_off" ? "vi_wonEstimatesOff" : "vi_wonNothingPriced")}</p>
        {billingChoice}
        {s.noCustomer && noCustomerLine}
        <Button type="button" className="w-full" disabled={busy} onClick={onStartPlain}>
          {spin}
          {t("vp_btn_startTheJob")}
        </Button>
      </div>
    );
  }

  // THE ESTIMATE: its lines, its totals, the billing kind, Approve.
  const view = wonView(s, typed);
  const visit = s.source === "visit";
  // A priced line still asking is asking for its quantity (cn-v1176 fix F3): said so, never "no price".
  const holeWords = (l: WonLine) =>
    l.hole?.kind === "flag" && l.hole.flag ? l.hole.flag : l.unitPrice > 0 && !(l.quantity > 0) ? t("vi_wonNoQtyYet") : t("vi_wonNoPriceYet");
  const canApprove = !busy && !view.holesLeft && view.pricedLeft && (visit || !!s.quote);
  return (
    <div className="space-y-3">
      {said}
      {!visit && (
        <p className="text-sm text-slate-700">
          {cap(
            fillText(t(s.lines.length === 0 ? "vi_wonExistingEmpty" : view.holesLeft ? "vi_wonExistingHole" : "vi_wonExisting"), {
              n: estimateName(s.quote),
              open: s.quote?.number ? fillText(t("vi_btn_wonOpenEstimate"), { n: s.quote.number }) : t("vi_btn_openTheEstimate"),
            }),
          )}
        </p>
      )}
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {s.lines.map((orig) => {
          const shown = view.lines.find((l) => l.key === orig.key) ?? null;
          const removed = visit && !!typed[orig.key]?.remove;
          const askRow = visit && orig.hole !== null;
          return (
            <li key={orig.key} className={`px-3 py-2 text-sm ${removed ? "text-slate-400" : "text-slate-800"}`}>
              <div className="flex items-start justify-between gap-3">
                <span className={`min-w-0 flex-1 ${removed ? "line-through" : ""}`}>{orig.description}</span>
                {!removed && shown && (
                  <span className="shrink-0 tabular-nums">
                    {shown.quantity} × {money(shown.unitPrice)} = {money(shown.amount)}
                  </span>
                )}
              </div>
              {askRow && !removed && (
                <div className="mt-1.5 space-y-1.5">
                  {shown?.hole && <p className="text-xs text-slate-500">{holeWords(shown)}</p>}
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      {t("vi_wonQty")}
                      <Input
                        inputMode="decimal"
                        autoComplete="off"
                        className="w-20"
                        disabled={busy}
                        value={typed[orig.key]?.qty ?? prefillQty(orig)}
                        onChange={(e) => onTyped(orig.key, { qty: e.target.value })}
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      {t("vi_wonPrice")}
                      <Input
                        inputMode="decimal"
                        autoComplete="off"
                        className="w-24"
                        disabled={busy}
                        value={typed[orig.key]?.price ?? prefillPrice(orig)}
                        onChange={(e) => onTyped(orig.key, { price: e.target.value })}
                      />
                    </label>
                    <Button type="button" variant="ghost" className="ml-auto" disabled={busy} onClick={() => onTyped(orig.key, { remove: true })}>
                      {t("vi_btn_remove")}
                    </Button>
                  </div>
                </div>
              )}
              {removed && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => onTyped(orig.key, { remove: false })}>
                  {t("vi_btn_wonPutBack")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <dl className="space-y-0.5 text-sm">
        <div className="flex justify-between text-slate-600">
          <dt>{t("qe_subtotal")}</dt>
          <dd className="tabular-nums">{money(view.totals.subtotal)}</dd>
        </div>
        {view.totals.tax > 0 && (
          <div className="flex justify-between text-slate-600">
            <dt>{t("qe_tax")}</dt>
            <dd className="tabular-nums">{money(view.totals.tax)}</dd>
          </div>
        )}
        <div className="flex justify-between text-base font-semibold text-slate-900">
          <dt>{t("qe_total")}</dt>
          <dd className="tabular-nums">{money(view.totals.total)}</dd>
        </div>
      </dl>
      {billingChoice}
      {s.noCustomer && noCustomerLine}
      {!visit && view.holesLeft && s.quote && (
        <Link href={`/quotes/${s.quote.id}`} className="inline-flex min-h-[44px] items-center text-sm font-medium text-[rgb(var(--glass-ink))] underline">
          {s.quote.number ? fillText(t("vi_btn_wonOpenEstimate"), { n: s.quote.number }) : t("vi_btn_openTheEstimate")}
        </Link>
      )}
      <Button type="button" className="w-full" disabled={!canApprove} onClick={onApprove}>
        {spin}
        {t("vi_btn_approveAndStartTheJob")}
      </Button>
      {visit && view.holesLeft && <p className="text-xs text-slate-500">{t("vi_wonHolesLeft")}</p>}
      {visit && !view.holesLeft && !view.pricedLeft && <p className="text-xs text-slate-500">{t("vi_wonNoLinesLeft")}</p>}
      {/* ONLY ON THE VISIT'S OWN LINES (cn-v1176 fix F1): beside an estimate that stands, a job with no
          estimate would leave that estimate to make a second job when it is accepted. */}
      {visit && (
        <button
          type="button"
          disabled={busy}
          onClick={onChoosePlain}
          className="flex min-h-[44px] w-full items-center justify-center text-sm text-slate-500 underline"
        >
          {t("vi_btn_startTheJobWithNoEstimate")}
        </button>
      )}
    </div>
  );
}
