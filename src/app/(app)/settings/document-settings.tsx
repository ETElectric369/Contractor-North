"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

export function DocumentSettings({ settings }: { settings: OrgSettings }) {
  const [expiry, setExpiry] = useState(settings.quote_expiry_days);
  const [due, setDue] = useState(settings.invoice_due_days);
  const [deposit, setDeposit] = useState(settings.deposit_percent);
  const [quoteTerms, setQuoteTerms] = useState(settings.quote_terms);
  const [invoiceTerms, setInvoiceTerms] = useState(settings.invoice_terms);
  const [contractTerms, setContractTerms] = useState(settings.contract_terms);
  const [footer, setFooter] = useState(settings.document_footer);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    setDone(false);
    start(async () => {
      const res = await updateOrgSettings({
        quote_expiry_days: expiry,
        invoice_due_days: due,
        deposit_percent: deposit,
        quote_terms: quoteTerms,
        invoice_terms: invoiceTerms,
        contract_terms: contractTerms,
        document_footer: footer,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="ds-expiry">Quote valid for (days)</Label>
          <NumberInput id="ds-expiry" value={expiry} onValueChange={setExpiry} />
        </div>
        <div>
          <Label htmlFor="ds-due">Invoice due in (days)</Label>
          <NumberInput id="ds-due" value={due} onValueChange={setDue} />
        </div>
        <div>
          <Label htmlFor="ds-deposit">Default deposit (%)</Label>
          <NumberInput id="ds-deposit" value={deposit} onValueChange={setDeposit} />
        </div>
      </div>
      <div>
        <Label htmlFor="ds-qterms">Default quote terms</Label>
        <Textarea id="ds-qterms" rows={2} value={quoteTerms} onChange={(e) => setQuoteTerms(e.target.value)} placeholder="e.g. Quote valid for 30 days. 50% deposit required to schedule." />
      </div>
      <div>
        <Label htmlFor="ds-iterms">Default invoice terms</Label>
        <Textarea id="ds-iterms" rows={2} value={invoiceTerms} onChange={(e) => setInvoiceTerms(e.target.value)} placeholder="e.g. Payment due within 14 days. 1.5% monthly late fee." />
      </div>
      <div>
        <Label htmlFor="ds-cterms">Default contract terms</Label>
        <Textarea id="ds-cterms" rows={4} value={contractTerms} onChange={(e) => setContractTerms(e.target.value)} placeholder="The standard terms section of your service contracts (payment, change orders, warranty, cancellation, governing law)." />
      </div>
      <div>
        <Label htmlFor="ds-footer">Document footer</Label>
        <Textarea id="ds-footer" rows={2} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="Shown at the bottom of quotes, invoices & work orders (license #, thank-you note, etc.)" />
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
