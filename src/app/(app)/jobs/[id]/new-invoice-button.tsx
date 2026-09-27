"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { createParamClaim } from "@/lib/param-claim";
import { drawAmount, subtotalTaxTotal } from "@/lib/invoice-math";
import {
  invoicePresetFromParam,
  newInvoiceChoices,
  newInvoiceRoute,
  newInvoiceSaveLabel,
  workSoFarDoor,
  type NewInvoiceChoice,
  type NewInvoicePreset,
  type OpenDraft,
  type WorkSoFar,
} from "@/lib/actuals-draw";
import { createInvoiceForJob, type CreateInvoiceForJobResult } from "../actions";
import { createProgressInvoice } from "../../recurring/actions";
import { createProgressReportInvoice, requestNextPayment } from "../../billing/actions";

/**
 * ERIK'S OPEN QUESTIONS, BUILT AS RECOMMENDED AND EASY TO FLIP (Wave 1 plan, 2026-09-27).
 *
 * TAKE_A_DEPOSIT_LINK: on a job with no estimate (a service call) New Invoice is one tap; this
 *   small link keeps the deposit door the old Progress Payment › Deposit gave. false removes it.
 * JOB_NEW_INVOICE_STARTS_TAXED: with Sales Tax on, a new invoice made here starts at the company's
 *   default rate, shown on the sheet (Tax Rate %) and named in the one-tap toast - as /billing's New
 *   Invoice always did. false puts back today's untaxed start. A draw (a deposit, a part of the
 *   estimate) is never taxed either way, and an estimate copy keeps the estimate's own tax.
 */
export const TAKE_A_DEPOSIT_LINK = true;
export const JOB_NEW_INVOICE_STARTS_TAXED = true;

/** ?invoice=part|deposit: only the first mounted New Invoice answers it (lib/param-claim). */
const presetParam = createParamClaim();

/**
 * THE PROPS ARE THE FACTS THE JOB PAGE ALREADY HAS (W1-24), so another door can mount the same
 * button (lane 6's Left To Bill card, next wave, with preset "part") and get the same answers.
 * `preset` opens the sheet with that choice made; `label` renames the button.
 */
export type NewInvoiceButtonProps = {
  jobId: string;
  billingType?: string | null;
  /** The contract the draw doors take a part of (the page's contract estimate). 0 = none. */
  estimate?: number;
  /** An estimate still stands (not declined, not expired) and bills above $0. */
  hasEstimate?: boolean;
  /** The estimate a New Invoice would copy, while no bill holds it (fixed price, no draws). */
  wholeEstimate?: number | null;
  /** Time & Material work to date; null = couldn't total (said, never $0). */
  worked?: number | null;
  /** Sent bills (non-void, non-draft) and what's been paid on the job's bills. */
  billed?: number | null;
  paid?: number | null;
  /** The job's open draft (openDraftOnJob), if any. */
  openDraft?: Pick<OpenDraft, "id" | "number" | "refreshable"> | null;
  /** payment_milestones rows exist. */
  scheduleActive?: boolean;
  /** A live draw is on the job (the card's `drawBilled`). */
  drawBilled?: boolean;
  /** The next New Invoice pulls the job's hours and receipts (nextInvoiceImportsActuals). */
  billsActuals?: boolean;
  /** The Overview card's unbilled work (staff), and the deposit it nets - Bill The Work So Far's
   *  figure comes from these through the card's own door, so the two never differ. */
  unbilled?: WorkSoFar | null;
  lumpToNet?: number;
  /** Settings › Money deposit %: the Deposit box's first value (× the estimate). */
  depositPercent?: number;
  /** Pieces taken past the stock, said before an invoice is built (lib/stock-billing). */
  stockShortsWords?: string | null;
  /** The Sales Tax switch (0352). */
  salesTax?: boolean;
  preset?: NewInvoicePreset;
  label?: string;
};

const money = (n: number) => formatCurrency(n);

/**
 * ONE NEW INVOICE ON THE JOB (W1-24). What one tap does is lib/actuals-draw's newInvoiceRoute: an
 * open draft is where the server goes (no sheet); a payment schedule bills by its schedule; a job
 * with no estimate and no draw makes its invoice in one tap, exactly as before; anything else opens
 * the New Invoice sheet. Nothing here decides money: every figure is the server's own arithmetic
 * (drawAmount, unbilledCardDoor), read from the page.
 */
export function NewInvoiceButton(p: NewInvoiceButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [sheet, setSheet] = useState<{ open: boolean; preset: NewInvoicePreset | null; refusal: string | null }>({ open: false, preset: null, refusal: null });

  const facts = {
    openDraft: p.openDraft ?? null,
    scheduleActive: !!p.scheduleActive,
    hasEstimate: !!p.hasEstimate,
    drawBilled: !!p.drawBilled,
  };
  const route = newInvoiceRoute(facts);
  const taxOn = JOB_NEW_INVOICE_STARTS_TAXED && p.salesTax !== false;

  /** A preset from another door (the param, Take A Deposit Instead, a server's "part" door). */
  function openWith(preset: NewInvoicePreset | null, refusal: string | null = null) {
    const r = newInvoiceRoute(facts, preset);
    if (r.kind === "draft") {
      const d = p.openDraft;
      toast(
        `${d?.number ?? "The open draft"} is still open on this job, so a new bill can't start until it goes out (or is deleted).`,
        "info",
        d ? { label: `Open ${d.number ?? "It"}`, onClick: () => router.push(`/billing/${d.id}`) } : undefined,
      );
      return;
    }
    if (r.kind === "schedule") {
      toast("This job bills on its payment schedule - Request Next Payment is its door.", "info");
      return;
    }
    setSheet({ open: true, preset, refusal });
  }

  // ?invoice=part|deposit, claimed once and stripped (the ?new=1 pattern), so a door elsewhere can
  // open this sheet with its choice made.
  const claimant = useId();
  useEffect(() => () => presetParam.release(claimant), [claimant]);
  useEffect(() => {
    const preset = invoicePresetFromParam(searchParams.get("invoice"));
    if (!preset) {
      presetParam.release(claimant);
      return;
    }
    if (!presetParam.take(claimant)) return;
    openWith(preset);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("invoice");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // openWith reads the page's facts, which the param doesn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, pathname, router, claimant]);

  /** The job's default rate, read when a new invoice may start with it (as /billing's button does). */
  async function defaultRate(): Promise<number> {
    if (!taxOn) return 0;
    const { data } = await createClient().from("organizations").select("default_tax_rate").limit(1).maybeSingle();
    const rate = Number((data as { default_tax_rate?: number | string | null } | null)?.default_tax_rate);
    return Number.isFinite(rate) && rate > 0 && rate < 1 ? rate : 0;
  }

  /** The server's answer, said: its note before the redirect; a refusal with its door. */
  function land(res: CreateInvoiceForJobResult): boolean {
    if (!res.ok || !res.id) {
      if (res.door === "part-of-estimate") {
        // THE REFUSAL IS A DOOR: this job bills its estimate in parts, so the sheet opens on that.
        openWith("part", res.error ?? null);
        return false;
      }
      const door = res.billedOn;
      toast(res.error ?? "Could not create the invoice.", "error", door ? { label: `Open ${door.number}`, onClick: () => router.push(`/billing/${door.id}`) } : undefined);
      return false;
    }
    if (res.importWarning) toast(res.importWarning, res.partial ? "error" : "info");
    router.push(`/billing/${res.id}`);
    return true;
  }

  function oneTap() {
    start(async () => {
      if (route.kind === "draft" && p.openDraft && !p.openDraft.refreshable) {
        // A DRAFT FOR SET AMOUNTS TAKES NO NEW WORK: it opens, named, never a click the server refuses.
        const d = p.openDraft;
        toast(`Opened ${d.number ?? "the open draft"}, a draft for set amounts: new hours and receipts can't go on it. Send it (or delete it), then bill the rest with New Invoice.`, "info");
        router.push(`/billing/${d.id}`);
        return;
      }
      if (route.kind === "draft") {
        // Brought up to date where the server goes ("Pulled 6 hours and 1 bill into INV-078").
        land(await createInvoiceForJob(p.jobId));
        return;
      }
      // No estimate, no draw: the one-tap invoice, exactly as before - at the company's rate when
      // Sales Tax is on (the toast names it; nothing about money is silent).
      const rate = await defaultRate().catch(() => 0);
      const res = await createInvoiceForJob(p.jobId, rate > 0 ? { taxRate: rate } : {});
      if (res.ok && res.id && rate > 0) {
        const taxWords = `Sales tax is ${pct(rate)}, your usual rate - change it on the invoice if this one is different.`;
        res.importWarning = res.importWarning ? `${res.importWarning} ${taxWords}` : taxWords;
      }
      land(res);
    });
  }

  if (route.kind === "schedule") {
    return <ScheduleDoor jobId={p.jobId} />;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={() => (route.kind === "sheet" ? openWith(p.preset ?? null) : oneTap())} disabled={pending}>
        <FileText className="h-4 w-4" /> {pending ? "Opening…" : (p.label ?? "New Invoice")}
      </Button>
      {TAKE_A_DEPOSIT_LINK && route.kind === "direct" && (
        <button type="button" onClick={() => openWith("deposit")} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
          Take A Deposit Instead
        </button>
      )}
      {/* Pieces taken past the stock, said BEFORE the tap: the one-tap doors have no sheet to say it
          in (the sheet says it above its Save). */}
      {route.kind !== "sheet" && p.stockShortsWords && <p className="max-w-md text-right text-sm text-amber-700">{p.stockShortsWords}</p>}
      {sheet.open && (
        <NewInvoiceSheet
          {...p}
          preset={sheet.preset}
          refusal={sheet.refusal}
          taxOn={taxOn}
          loadRate={defaultRate}
          onClose={() => setSheet({ open: false, preset: null, refusal: null })}
          onLanded={() => setSheet({ open: false, preset: null, refusal: null })}
        />
      )}
    </div>
  );
}

const pct = (rate: number) => `${Math.round(rate * 1_000_000) / 10_000}%`;

/** A job billed on its payment schedule: no sheet, the schedule's own door (requestNextPayment). */
function ScheduleDoor({ jobId }: { jobId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  function requestNext() {
    start(async () => {
      const res = await requestNextPayment(jobId);
      if (!res.ok || !res.id) {
        const door = res.openDraft;
        toast(res.error ?? "Could not create the payment.", "error", door ? { label: `Open ${door.number}`, onClick: () => router.push(`/billing/${door.id}`) } : undefined);
        return;
      }
      if (res.note) toast(res.note, res.partial ? "error" : "info");
      router.push(`/billing/${res.id}`);
    });
  }
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <p className="text-sm text-slate-600">This job bills on its payment schedule.</p>
      <Button onClick={requestNext} disabled={pending}>
        {pending ? "Requesting…" : "Request Next Payment"}
      </Button>
    </div>
  );
}

const CHOICE_WORDS: Record<NewInvoiceChoice, string> = {
  deposit: "Deposit",
  part: "Part Of The Estimate",
  work: "Bill The Work So Far",
  whole: "The Whole Estimate",
};

/**
 * THE NEW INVOICE SHEET. At the top, the money as one thin bar (the estimate its full width,
 * Billed filled, Paid darker) and the figures under it; then one choice of 2 or 3 buttons
 * (newInvoiceChoices), the choice's one box, This Is The Last Bill where a bill can be the last,
 * and a Save that names what it makes. A refusal stays in the red box with its Open INV-0xx.
 */
function NewInvoiceSheet(
  p: Omit<NewInvoiceButtonProps, "preset"> & {
    preset: NewInvoicePreset | null;
    /** A server refusal that opened this sheet (a job billed in parts): said at the top. */
    refusal: string | null;
    taxOn: boolean;
    loadRate: () => Promise<number>;
    onClose: () => void;
    onLanded: () => void;
  },
) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const estimate = Math.max(0, Number(p.estimate) || 0);
  const billed = p.billed == null ? null : Math.max(0, Number(p.billed) || 0);
  const paid = p.paid == null ? null : Math.max(0, Number(p.paid) || 0);
  const left = billed == null ? null : Math.max(0, Math.round((estimate - billed) * 100) / 100);
  const isTM = p.billingType === "tm";
  const workDoor = useMemo(() => workSoFarDoor(p.unbilled ?? null, Number(p.lumpToNet) || 0, !!p.drawBilled, money), [p.unbilled, p.lumpToNet, p.drawBilled]);
  const { choices, initial } = newInvoiceChoices(
    {
      billingType: p.billingType,
      estimate,
      hasEstimate: !!p.hasEstimate,
      billsActuals: !!p.billsActuals,
      workDoor,
      wholeEstimate: p.wholeEstimate ?? null,
    },
    p.preset,
  );
  const [choice, setChoice] = useState<NewInvoiceChoice>(initial);
  const depositSeed = (Number(p.depositPercent) || 0) > 0 && estimate > 0 ? Math.round(estimate * (Number(p.depositPercent) || 0)) / 100 : 0;
  const [depositAmt, setDepositAmt] = useState(depositSeed);
  const [partPct, setPartPct] = useState(50);
  const [partDollars, setPartDollars] = useState(false);
  const [partAmt, setPartAmt] = useState(0);
  const [last, setLast] = useState(false);
  const [taxRate, setTaxRate] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorDoor, setErrorDoor] = useState<{ id: string; number: string } | null>(null);

  // The company's rate, seeded once when a new invoice may start with it (the field shows it).
  useEffect(() => {
    if (!p.taxOn) return;
    let live = true;
    p.loadRate().then(
      (r) => {
        if (live && r > 0) setTaxRate(r);
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // Once per sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const workAmount = workDoor && (workDoor.kind === "create" || workDoor.kind === "draw") ? workDoor.amount : null;
  /** Bill The Work So Far makes a standard invoice (the only path a rate reaches) unless it is the
   *  last bill or the job already bills with draws - then it is a progress report, never taxed. */
  const workIsStandard = workDoor?.kind === "create" && !last;
  const showTax = p.taxOn && choice === "work" && workIsStandard;
  const partAmount = partDollars ? Math.round((partAmt || 0) * 100) / 100 : drawAmount("percent", partPct, left ?? 0);
  const amount =
    choice === "deposit"
      ? Math.round((depositAmt || 0) * 100) / 100
      : choice === "part"
        ? partAmount
        : choice === "work"
          ? workAmount != null && showTax
            ? subtotalTaxTotal([workAmount], taxRate).total
            : workAmount
          : (p.wholeEstimate ?? null);
  const canLast = choice === "part" || choice === "work";
  const saveLabel = newInvoiceSaveLabel(choice, canLast && last, amount, money);
  const canSave = !pending && amount != null && amount > 0.005;

  function pickPart(v: number | "rest") {
    setPartDollars(false);
    if (v === "rest") {
      setPartPct(100);
      setLast(true); // The Rest is the last part.
    } else {
      setPartPct(v);
    }
  }

  function save() {
    setError(null);
    setErrorDoor(null);
    start(async () => {
      let res: { ok: boolean; id?: string; error?: string; note?: string; partial?: true; importWarning?: string; billedOn?: { id: string; number: string }; openDraft?: { id: string; number: string } };
      if (choice === "deposit") {
        res = await createProgressInvoice(p.jobId, { kind: "deposit", mode: "fixed", value: depositAmt });
      } else if (choice === "part") {
        res = await createProgressInvoice(p.jobId, { kind: last ? "final" : "progress", mode: partDollars ? "fixed" : "percent", value: partDollars ? partAmt : partPct });
      } else if (choice === "work") {
        // The card's own door: a progress report on a job billed with draws (and for the last bill,
        // so the Progress Summary ends on the over/under line), else the standard invoice.
        res =
          workDoor?.kind === "draw" || last
            ? await createProgressReportInvoice(p.jobId, last ? "final" : "progress")
            : await createInvoiceForJob(p.jobId, showTax && taxRate > 0 ? { taxRate } : {});
      } else {
        // The estimate's lines, at the estimate's own tax (its price as agreed).
        res = await createInvoiceForJob(p.jobId);
      }
      if (!res.ok || !res.id) {
        setErrorDoor(res.billedOn ?? res.openDraft ?? (p.openDraft?.number ? { id: p.openDraft.id, number: p.openDraft.number } : null));
        setError(res.error ?? "Could not create the invoice.");
        return;
      }
      const note = res.note ?? res.importWarning;
      if (note) toast(note, res.partial ? "error" : "info");
      else toast(choice === "deposit" ? "Deposit started as a draft" : "Invoice started as a draft", "success");
      p.onLanded();
      router.push(`/billing/${res.id}`);
    });
  }

  const overEstimate = isTM && p.worked != null && estimate > 0 && p.worked > estimate + 0.005;

  return (
    <Modal
      open
      onClose={p.onClose}
      title="New Invoice"
      holdOpen={pending}
      footer={<ModalActions onCancel={p.onClose} onSave={save} saving={pending} saveLabel={saveLabel} disabled={!canSave} />}
    >
      <div className="space-y-4">
        {/* Why the sheet opened on Part Of The Estimate, when a door said so (a job billed in parts). */}
        {p.refusal && !error && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{p.refusal}</p>}
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
            {errorDoor && (
              <>
                {" "}
                <Link href={`/billing/${errorDoor.id}`} className="inline-flex min-h-11 items-center font-medium underline">
                  Open {errorDoor.number}
                </Link>
              </>
            )}
          </div>
        )}

        {/* THE MONEY, AS ONE BAR: the estimate its full width, Billed filled, Paid darker. */}
        <div className="space-y-1.5">
          {estimate > 0 && billed != null && paid != null && (
            <div
              className="relative h-2 w-full overflow-hidden rounded-full bg-slate-200"
              role="img"
              aria-label={`${money(billed)} billed and ${money(paid)} paid of the ${money(estimate)} estimate`}
            >
              <div className="absolute inset-y-0 left-0 bg-brand/35" style={{ width: `${Math.min(100, (billed / estimate) * 100)}%` }} />
              <div className="absolute inset-y-0 left-0 bg-brand" style={{ width: `${Math.min(100, (paid / estimate) * 100)}%` }} />
            </div>
          )}
          <p className="text-sm text-slate-600">
            {estimate > 0 ? `Estimate ${money(estimate)}` : "No estimate"} · Billed {billed == null ? "Couldn't total" : money(billed)}
            {estimate > 0 && <> · Left {left == null ? "Couldn't total" : money(left)}</>}
            {isTM && (
              <span className={overEstimate ? "font-medium text-amber-700" : undefined}>
                {" "}
                · Work so far {p.worked == null ? "Couldn't total" : money(p.worked)}
              </span>
            )}
          </p>
          {paid != null && paid > 0.005 && <p className="text-xs text-slate-500">Paid {money(paid)} so far.</p>}
        </div>

        {/* ONE CHOICE, 2 or 3 buttons. */}
        <div role="radiogroup" aria-label="What this bill is" className={`grid gap-2 ${choices.length === 3 ? "sm:grid-cols-3" : choices.length === 2 ? "sm:grid-cols-2" : ""}`}>
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={choice === c}
              onClick={() => {
                setChoice(c);
                if (c !== "part" && c !== "work") setLast(false);
              }}
              className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-medium ${
                choice === c ? "border-brand bg-brand-light text-brand-dark" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {c === "whole" && p.wholeEstimate != null ? `${CHOICE_WORDS[c]} ${money(p.wholeEstimate)}` : CHOICE_WORDS[c]}
            </button>
          ))}
        </div>

        {choice === "deposit" && (
          <div>
            <Label htmlFor="ni-deposit">Deposit amount</Label>
            <NumberInput id="ni-deposit" value={depositAmt} onValueChange={setDepositAmt} className="h-11 w-44" placeholder="$ amount" />
            {depositSeed > 0 && (
              <p className="mt-1 text-xs text-slate-500">
                {Number(p.depositPercent)}% of the {money(estimate)} estimate, your usual deposit (Settings › Money).
              </p>
            )}
          </div>
        )}

        {choice === "part" && (
          <div className="space-y-2">
            {!partDollars ? (
              <>
                <Label htmlFor="ni-pct">Percent of what is left ({left == null ? "Couldn't total" : money(left)})</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <NumberInput id="ni-pct" value={partPct} onValueChange={(v) => setPartPct(Math.max(0, Math.min(100, v)))} className="h-11 w-24" />
                  <span className="text-sm text-slate-500">%</span>
                  {([25, 33, 50] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => pickPart(v)}
                      className={`min-h-11 rounded-full border px-3 text-sm font-medium ${partPct === v ? "border-brand bg-brand-light text-brand-dark" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                    >
                      {v}%
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => pickPart("rest")}
                    className={`min-h-11 rounded-full border px-3 text-sm font-medium ${partPct === 100 ? "border-brand bg-brand-light text-brand-dark" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                  >
                    The Rest
                  </button>
                </div>
              </>
            ) : (
              <>
                <Label htmlFor="ni-part-amt">Amount</Label>
                <NumberInput id="ni-part-amt" value={partAmt} onValueChange={setPartAmt} className="h-11 w-44" placeholder="$ amount" />
              </>
            )}
            <button
              type="button"
              onClick={() => setPartDollars((d) => !d)}
              className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
            >
              {partDollars ? "Use A Percent Instead" : "Type An Amount Instead"}
            </button>
            {!partDollars && left != null && left <= 0.005 && (
              <p className="text-sm text-amber-700">The estimate is billed in full. For an extra, type an amount instead.</p>
            )}
          </div>
        )}

        {choice === "work" && workDoor && (workDoor.kind === "create" || workDoor.kind === "draw") && (
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-600">Hours and bills not on a bill yet</span>
              <span className="font-semibold text-slate-900">{money(workDoor.amount)}</span>
            </div>
            {workDoor.note && <p className="mt-1 text-xs text-slate-500">{workDoor.note}</p>}
          </div>
        )}
        {/* Nothing to bill on a job that bills its work: said, never a choice the server refuses. */}
        {p.billsActuals && workDoor?.kind === "covered" && <p className="text-sm text-slate-500">{workDoor.note}</p>}
        {p.billsActuals && !workDoor && p.unbilled && (
          <p className="text-sm text-slate-500">Every hour and bill so far is on a bill - nothing new to bill.</p>
        )}

        {choice === "whole" && p.wholeEstimate != null && (
          <p className="text-sm text-slate-600">Copies the estimate&apos;s lines and its own sales tax onto one invoice: {money(p.wholeEstimate)}.</p>
        )}

        {canLast && (
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={last} onChange={(e) => setLast(e.target.checked)} className="h-5 w-5 rounded border-slate-300" />
            This Is The Last Bill
          </label>
        )}

        {showTax && (
          <div>
            <Label htmlFor="ni-tax">Tax Rate %</Label>
            <NumberInput
              id="ni-tax"
              value={taxRate ? +(taxRate * 100).toFixed(4) : 0}
              onValueChange={(v) => setTaxRate(Math.max(0, v) / 100)}
              className="h-11 w-28"
              placeholder="0"
            />
          </div>
        )}

        {p.stockShortsWords && <p className="text-sm text-amber-700">{p.stockShortsWords}</p>}
      </div>
    </Modal>
  );
}