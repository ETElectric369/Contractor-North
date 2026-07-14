"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useDraft } from "@/lib/use-draft";
import { useToast } from "@/components/toast";
import { createInvoiceFromQuote, createBlankInvoice } from "./actions";
import { jobLabel } from "@/lib/schedule-options";

// The billing page mounts this button TWICE (header + empty state); only the
// FIRST mounted instance may answer ?new=1 or two modals would stack.
let newParamClaimed = false;

interface QuoteOption {
  id: string;
  quote_number: string;
  total: number;
  customers: { name: string } | null;
}
interface CustomerOption {
  id: string;
  name: string;
}
interface JobOption {
  id: string;
  name: string;
  job_number: string;
  customer_id: string | null;
}

export function NewInvoiceButton({
  quotes,
  customers,
  jobs = [],
}: {
  quotes: QuoteOption[];
  customers: CustomerOption[];
  jobs?: JobOption[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"quote" | "blank">(
    quotes.length ? "quote" : "blank",
  );
  const [quoteId, setQuoteId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [title, setTitle] = useState("");
  // Seeded from the org's default tax rate on open (a fraction, e.g. 0.0825) so a
  // blank invoice isn't silently zero-tax — the #1 "wrong number" on hand-typed
  // invoices. Self-loaded once, mirroring quick-cost-button's self-load.
  const [taxRate, setTaxRate] = useState(0);
  const [taxSeeded, setTaxSeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const toast = useToast();

  // Jobs to offer: those for the chosen customer (or all, if no customer yet).
  const jobChoices = customerId ? jobs.filter((j) => j.customer_id === customerId) : jobs;

  // Interruption recovery: a deploy reload / iOS killing the tab restores the
  // picks. taxRate stays out on purpose — it's auto-seeded from the org default,
  // so mirroring it would plant a "draft" from merely opening the modal.
  const draftState = useMemo(
    () => ({ mode, quoteId, customerId, jobId, title }),
    [mode, quoteId, customerId, jobId, title],
  );
  const draft = useDraft("invoice-new", draftState, (d) => {
    setMode(d.mode === "quote" ? "quote" : "blank");
    setQuoteId(d.quoteId ?? "");
    setCustomerId(d.customerId ?? "");
    setJobId(d.jobId ?? "");
    setTitle(d.title ?? "");
  });
  // Dirty = the user actually picked/typed something (mode alone isn't content).
  const dirty = !!(quoteId || customerId || jobId || title);

  async function openModal() {
    if (draft.restored && dirty) toast("Draft restored — pick up where you left off", "info");
    setOpen(true);
    if (taxSeeded) return; // only seed once; don't stomp a value the user already typed
    setTaxSeeded(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("organizations")
      .select("default_tax_rate")
      .limit(1)
      .maybeSingle();
    const rate = Number((data as any)?.default_tax_rate);
    if (Number.isFinite(rate) && rate > 0) setTaxRate(rate);
  }

  // Open straight from the quick-add menu's "New invoice" (/billing?new=1), then
  // strip the param so a refresh or back-button doesn't reopen the form.
  // ?customer=<id> may ride along (the customer page's ⋯ New-invoice door) to
  // preset the customer — it wins over a restored draft because a deep link is
  // an explicit "invoice THIS customer" intent.
  useEffect(() => {
    if (searchParams.get("new") !== "1") {
      newParamClaimed = false; // param gone → release for the next quick-add tap
      return;
    }
    if (newParamClaimed) return;
    newParamClaimed = true;
    const preset = searchParams.get("customer");
    if (preset && customers.some((c) => c.id === preset)) {
      setMode("blank"); // the customer select only exists on a blank invoice
      setCustomerId(preset);
      setJobId(""); // job list depends on the customer (same rule as the select)
    }
    void openModal();
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    params.delete("customer");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // openModal is stable enough for this once-per-param effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, pathname, router]);

  // Confirmed close (the Modal's two-tap guard has already asked when dirty) —
  // an explicit discard, so the stored draft goes too.
  function discard() {
    draft.clear();
    setQuoteId("");
    setCustomerId("");
    setJobId("");
    setTitle("");
    setOpen(false);
  }

  function onCreate() {
    setError(null);
    start(async () => {
      const res =
        mode === "quote"
          ? await createInvoiceFromQuote(quoteId)
          : await createBlankInvoice({
              customer_id: customerId || null,
              job_id: jobId || null,
              title,
              tax_rate: taxRate,
            });
      if (!res.ok) {
        setError(res.error ?? "Could not create invoice.");
        return;
      }
      draft.clear();
      setOpen(false);
      if (res.id) router.push(`/billing/${res.id}`);
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
        title="New invoice"
        dirty={dirty}
        footer={
          <ModalActions
            onCancel={discard}
            onSave={onCreate}
            saving={pending}
            disabled={mode === "quote" && !quoteId}
            saveLabel="Create invoice"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setMode("quote")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                mode === "quote"
                  ? "border-brand bg-brand-light text-brand-dark"
                  : "border-slate-200 text-slate-600"
              }`}
            >
              From an Estimate
            </button>
            <button
              onClick={() => setMode("blank")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                mode === "blank"
                  ? "border-brand bg-brand-light text-brand-dark"
                  : "border-slate-200 text-slate-600"
              }`}
            >
              Blank Invoice
            </button>
          </div>

          {mode === "quote" ? (
            <div>
              <Label htmlFor="inv-quote">Estimate</Label>
              <Select
                id="inv-quote"
                value={quoteId}
                onChange={(e) => setQuoteId(e.target.value)}
              >
                <option value="">— Select an estimate —</option>
                {quotes.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.quote_number} · {q.customers?.name ?? "—"} ·{" "}
                    {formatCurrency(q.total)}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-400">
                Copies the customer, totals, and every line item onto a new
                invoice.
              </p>
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="inv-customer">Customer</Label>
                <Select
                  id="inv-customer"
                  value={customerId}
                  onChange={(e) => {
                    setCustomerId(e.target.value);
                    setJobId(""); // job list depends on the customer
                  }}
                >
                  <option value="">— None —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              {jobs.length > 0 && (
                <div>
                  <Label htmlFor="inv-job">Job (so the payment lands on the job)</Label>
                  <Select
                    id="inv-job"
                    value={jobId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setJobId(id);
                      // Inherit the job's customer if none picked yet.
                      const j = jobs.find((x) => x.id === id);
                      if (j && !customerId && j.customer_id) setCustomerId(j.customer_id);
                    }}
                  >
                    <option value="">— None (not tied to a job) —</option>
                    {jobChoices.map((j) => (
                      <option key={j.id} value={j.id}>
                        {jobLabel(j)}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="inv-title">Title</Label>
                  <Input
                    id="inv-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="inv-tax">Tax rate %</Label>
                  <Input
                    id="inv-tax"
                    type="number"
                    step="any"
                    placeholder="8.25"
                    // Show as a percent; state holds the fraction. Seeded from the
                    // org default on open so the field isn't a blank 0.
                    value={taxRate ? +(taxRate * 100).toFixed(4) : ""}
                    onChange={(e) =>
                      setTaxRate((Number(e.target.value) || 0) / 100)
                    }
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
