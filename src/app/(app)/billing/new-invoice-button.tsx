"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { NewCustomerInline } from "@/components/new-customer-inline";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, Briefcase, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { useDraft } from "@/lib/use-draft";
import { useToast } from "@/components/toast";
import { createBlankInvoice } from "./actions";
import { createInvoiceForJob } from "../jobs/actions";
import { createParamClaim } from "@/lib/param-claim";
import { pickRows, restoredPick, routePick, showsTaxRate, type Pick, type PickCustomer, type PickJob, type PickRow } from "./new-invoice-pick";

// The billing page mounts this button TWICE (header + empty state); only the
// FIRST mounted instance may answer ?new=1 or two modals would stack.
// Named per holder (lib/param-claim), so a strip that died on a dropped connection can't
// leave this door shut for the rest of the session.
const newParam = createParamClaim();

/** A refusal said in the window, with every door it has (a toast carries only one). */
type Refusal = {
  error: string;
  /** "Open INV-0xx": the bill that already holds the work, or the draw to open. */
  billedOn?: { id: string; number: string } | null;
  /** Nothing new to bill on this job: a blank invoice for something else (a referral, a fee). */
  blankFor?: string | null;
  /** The job bills its estimate in parts: its own New Invoice, Part Of The Estimate chosen. */
  partOf?: string | null;
  /** The job bills on its payment schedule: the job, where Request Next Payment is. */
  scheduleOf?: string | null;
};

export function NewInvoiceButton({
  customers,
  jobs = [],
  salesTax = true,
}: {
  customers: PickCustomer[];
  /** The jobs that aren't cancelled, newest first, each with its customer's name. */
  jobs?: PickJob[];
  /** SALES TAX OFF (the switch board, rule g): no default rate seeds a new invoice and the tax
   *  field isn't drawn, so a new invoice starts untaxed. Absent = on. */
  salesTax?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<Pick | null>(null);
  const [addedCustomers, setAddedCustomers] = useState<PickCustomer[]>([]);
  // Seeded from the org's default tax rate on open (a fraction, e.g. 0.0825) so a new invoice isn't
  // silently zero-tax — the #1 "wrong number" on hand-typed invoices. Self-loaded once.
  const [taxRate, setTaxRate] = useState(0);
  const [taxSeeded, setTaxSeeded] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [pending, start] = useTransition();
  /** The invoice exists and its page is loading. The window stays up, with Create shut so it
   *  cannot make a second one, until the new page replaces it (see goTo). */
  const [opening, setOpening] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const toast = useToast();

  const allCustomers = useMemo(() => [...addedCustomers, ...customers], [addedCustomers, customers]);
  const rows = useMemo(() => pickRows(query, jobs, allCustomers), [query, jobs, allCustomers]);

  // Interruption recovery: a deploy reload / iOS killing the tab restores the pick. The rate stays
  // out on purpose (auto-seeded from the org default), and the old form's shape is ignored.
  const draftState = useMemo(() => ({ pick }), [pick]);
  const draft = useDraft("invoice-new", draftState, (d) => setPick(restoredPick(d)));
  const dirty = !!pick;

  async function openModal() {
    if (draft.restored && dirty) toast("Draft restored — pick up where you left off", "info");
    setOpen(true);
    if (taxSeeded || !salesTax) return; // only seed once; don't stomp a value the user already typed
    setTaxSeeded(true);
    const supabase = createClient();
    const { data } = await supabase.from("organizations").select("default_tax_rate").limit(1).maybeSingle();
    const rate = Number((data as any)?.default_tax_rate);
    if (Number.isFinite(rate) && rate > 0) setTaxRate(rate);
  }

  // This instance's name on the ?new=1 claim; it lets go on unmount as well as below.
  const claimant = useId();
  useEffect(() => () => newParam.release(claimant), [claimant]);

  // Open straight from the quick-add menu's "New invoice" (/billing?new=1), then strip the param so
  // a refresh or back-button doesn't reopen the form. ?customer=<id> may ride along (the customer
  // page's ⋯ New Invoice door) to preselect that customer — it wins over a restored draft because a
  // deep link is an explicit "invoice THIS customer" intent.
  useEffect(() => {
    if (searchParams.get("new") !== "1") {
      newParam.release(claimant); // param gone → release for the next quick-add tap
      return;
    }
    if (!newParam.take(claimant)) return;
    const preset = searchParams.get("customer");
    const c = preset ? customers.find((x) => x.id === preset) : null;
    if (c) setPick({ kind: "customer", id: c.id, label: c.name });
    void openModal();
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    params.delete("customer");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // openModal is stable enough for this once-per-param effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, pathname, router, claimant]);

  // Confirmed close (the Modal's two-tap guard has already asked when dirty) — an explicit discard,
  // so the stored draft goes too. Closing while a new invoice's page is still loading gives up on
  // opening it: it is already in Drafts, and the window must never be left spinning.
  function discard() {
    draft.clear();
    setPick(null);
    setQuery("");
    setRefusal(null);
    setOpening(false);
    setOpen(false);
  }

  /**
   * OPEN THE NEW INVOICE WITHOUT CLOSING THE WINDOW FIRST (Erik, 2026-09-11 and 09-22: "it closed
   * the invoice and hid it somewhere rather than opening it for me to work on"). Closing the Modal
   * runs its cleanup, which calls history.back() while its marker is still on top, and Next throws
   * the pending push away. So the window stays up and the new page REPLACES the Modal's history
   * entry - ONLY when the marker is actually on top: the ?new=1 doors strip their param with
   * router.replace, which overwrites the marker's entry, and replacing again there would overwrite
   * /billing itself. No marker on top: push.
   */
  function goTo(id: string) {
    draft.clear();
    const markerOnTop = !!(window.history.state as { cnOverlay?: boolean } | null)?.cnOverlay;
    setOpening(true);
    if (markerOnTop) router.replace(`/billing/${id}`);
    else router.push(`/billing/${id}`);
  }

  function onCreate() {
    if (!pick) return;
    setRefusal(null);
    const route = routePick(pick, { salesTax, taxRate });
    start(async () => {
      if (route.action === "customer") {
        const res = await createBlankInvoice({ customer_id: route.customerId, title: "", tax_rate: route.taxRate });
        if (!res.ok || !res.id) {
          setRefusal({ error: res.error ?? "Could not create the invoice." });
          return;
        }
        goTo(res.id);
        return;
      }
      // A JOB IS BILLED THROUGH ITS OWN DOOR: its open draft, its estimate on a fixed-price job,
      // only the hours and bills no bill holds - exactly what the job's New Invoice does.
      const res = await createInvoiceForJob(route.jobId, route.taxRate !== undefined ? { taxRate: route.taxRate } : {});
      if (!res.ok || !res.id) {
        const error = res.error ?? "Could not create the invoice.";
        setRefusal({
          error,
          billedOn: res.billedOn ?? null,
          blankFor: res.nothingNew ? route.jobId : null,
          partOf: res.door === "part-of-estimate" ? route.jobId : null,
          scheduleOf: /payment schedule/i.test(error) ? route.jobId : null,
        });
        return;
      }
      if (res.importWarning) toast(res.importWarning, res.partial ? "error" : "info");
      goTo(res.id);
    });
  }

  /** Nothing new on the job: a blank invoice on it anyway (titled by the server from the job). */
  function startBlank(jobId: string) {
    setRefusal(null);
    start(async () => {
      const res = await createBlankInvoice({ customer_id: null, job_id: jobId, title: "", tax_rate: salesTax && taxRate > 0 ? taxRate : 0 });
      if (!res.ok || !res.id) {
        setRefusal({ error: res.error ?? "Could not create the invoice." });
        return;
      }
      goTo(res.id);
    });
  }

  return (
    <>
      <Button onClick={openModal}>
        <Plus className="h-4 w-4" /> New Invoice
      </Button>

      <Modal
        open={open}
        onClose={discard}
        title="New Invoice"
        // While the new invoice's page is loading the draft already exists, so a back swipe is a
        // plain close, not a discard to confirm.
        dirty={dirty && !opening}
        footer={<ModalActions onCancel={discard} onSave={onCreate} saving={pending || opening} disabled={!pick} saveLabel="Create Invoice" />}
      >
        <NewInvoicePickBody
          query={query}
          onQuery={setQuery}
          rows={rows}
          pick={pick}
          onPick={(p) => {
            setPick(p);
            setRefusal(null);
          }}
          onCustomerCreated={(c) => {
            setAddedCustomers((prev) => [c, ...prev]);
            setPick({ kind: "customer", id: c.id, label: c.name });
          }}
          salesTax={salesTax}
          taxRate={taxRate}
          onTaxRate={setTaxRate}
          refusal={refusal}
          onStartBlank={startBlank}
          pending={pending || opening}
        />
      </Modal>
    </>
  );
}

/**
 * THE WINDOW'S BODY, drawn from its props alone (so what it shows is pinned by render, as the Sales
 * Tax switch's test does): the one question, the rows (jobs first, every row 44px), the pick with a
 * way to change it, Tax Rate % while Sales Tax is on, and a refusal with every door it has.
 */
export function NewInvoicePickBody({
  query,
  onQuery,
  rows,
  pick,
  onPick,
  onCustomerCreated,
  salesTax,
  taxRate,
  onTaxRate,
  refusal,
  onStartBlank,
  pending = false,
}: {
  query: string;
  onQuery: (q: string) => void;
  rows: PickRow[];
  pick: Pick | null;
  onPick: (p: Pick | null) => void;
  onCustomerCreated: (c: { id: string; name: string }) => void;
  salesTax: boolean;
  taxRate: number;
  onTaxRate: (rate: number) => void;
  refusal: Refusal | null;
  onStartBlank: (jobId: string) => void;
  pending?: boolean;
}) {
  const DOOR = "inline-flex min-h-11 items-center font-medium underline";
  return (
    <div className="space-y-4">
      {refusal && (
        <div className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <p>{refusal.error}</p>
          <div className="flex flex-wrap gap-x-4">
            {refusal.billedOn && (
              <Link href={`/billing/${refusal.billedOn.id}`} className={DOOR}>
                Open {refusal.billedOn.number}
              </Link>
            )}
            {refusal.blankFor && (
              <button type="button" onClick={() => onStartBlank(refusal.blankFor!)} disabled={pending} className={DOOR}>
                Start A Blank One
              </button>
            )}
            {refusal.partOf && (
              <Link href={`/jobs/${refusal.partOf}?tab=invoices&invoice=part`} className={DOOR}>
                Open The Job&apos;s New Invoice
              </Link>
            )}
            {refusal.scheduleOf && (
              <Link href={`/jobs/${refusal.scheduleOf}?tab=invoices`} className={DOOR}>
                Open The Job
              </Link>
            )}
          </div>
        </div>
      )}

      <div>
        <Label htmlFor="inv-pick">Which Job Or Customer?</Label>
        {pick ? (
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-brand bg-brand-light px-3 text-sm text-brand-dark">
            <span className="flex min-w-0 items-center gap-2">
              {pick.kind === "job" ? <Briefcase className="h-4 w-4 shrink-0" /> : <User className="h-4 w-4 shrink-0" />}
              <span className="truncate font-medium">{pick.label}</span>
              {pick.kind === "customer" && <span className="shrink-0 rounded bg-white/70 px-1.5 text-xs text-slate-500">Customer</span>}
            </span>
            <button type="button" onClick={() => onPick(null)} className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium hover:underline">
              Change
            </button>
          </div>
        ) : (
          <>
            <Input
              id="inv-pick"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="J-number, job or customer"
              autoComplete="off"
              className="h-11"
            />
            <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200" role="listbox" aria-label="Jobs and customers">
              {rows.map((r) =>
                r.kind === "new-customer" ? (
                  <li key={`new-customer:${r.name}`} className="px-3 py-1">
                    {/* No match: this makes the customer and picks them (name and phone; the rest
                        goes on their contact page later). Keyed by the typed name: the row appears
                        at the first letters that match nothing ("Mi") and stays while the rest is
                        typed, and NewCustomerInline takes its name once, when it mounts - so each
                        new name mounts a fresh one and the box opens on the whole of it. */}
                    <NewCustomerInline initialName={r.name} label={`New Customer '${r.name}'`} onCreated={onCustomerCreated} />
                  </li>
                ) : (
                  <li key={`${r.kind}:${r.id}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => onPick({ kind: r.kind, id: r.id, label: r.label })}
                      className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-50"
                    >
                      <span className="truncate">{r.label}</span>
                      {r.kind === "customer" && <span className="shrink-0 rounded bg-slate-100 px-1.5 text-xs text-slate-500">Customer</span>}
                    </button>
                  </li>
                ),
              )}
              {rows.length === 0 && <li className="px-3 py-3 text-sm text-slate-500">No jobs yet: type a customer&apos;s name.</li>}
            </ul>
          </>
        )}
      </div>

      {showsTaxRate(pick, salesTax) && (
        <div>
          <Label htmlFor="inv-tax">Tax Rate %</Label>
          <Input
            id="inv-tax"
            type="number"
            step="any"
            placeholder="8.25"
            // Shown as a percent; state holds the fraction. Seeded from the org default on open.
            value={taxRate ? +(taxRate * 100).toFixed(4) : ""}
            onChange={(e) => onTaxRate((Number(e.target.value) || 0) / 100)}
            className="h-11 w-32"
          />
          {pick?.kind === "job" && (
            <p className="mt-1 text-xs text-slate-500">A new invoice on the job starts at this rate; an open draft keeps its own, and an estimate with its own tax keeps that.</p>
          )}
        </div>
      )}
    </div>
  );
}
