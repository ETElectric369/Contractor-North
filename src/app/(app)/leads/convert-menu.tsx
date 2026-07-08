"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { convertInquiry } from "./actions";

type Target = "inspection" | "estimate" | "quote" | "job" | "customer";
const LABELS: Record<Target, string> = {
  inspection: "Inspection",
  estimate: "Estimate",
  quote: "Quote",
  job: "Job",
  customer: "Customer",
};
// The pipeline order — inspect → price → win — with plain "Customer" last.
const ORDER: Target[] = ["inspection", "estimate", "quote", "job", "customer"];

/** A sensible default inspection date: 2 days out (client-side; no cache concern here). */
function defaultInspectDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

/** "Convert ▾" — explicit, never automatic. Inspection books a site visit and KEEPS the lead
 *  open so it can still become an estimate; the other targets attach/create a customer. */
export function ConvertMenu({
  inquiryId,
  inquiryName,
  customers,
}: {
  inquiryId: string;
  inquiryName: string;
  customers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [link, setLink] = useState<"new" | "existing">("new");
  const [customerId, setCustomerId] = useState("");
  const [inspectDate, setInspectDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function choose(t: Target) {
    setTarget(t);
    setMenuOpen(false);
    setLink("new");
    setCustomerId("");
    setInspectDate(t === "inspection" ? defaultInspectDate() : "");
    setError(null);
  }

  async function run() {
    if (!target) return;
    if (target === "inspection" && !inspectDate) {
      setError("Pick a date for the inspection.");
      return;
    }
    if (target !== "inspection" && link === "existing" && !customerId) {
      setError("Pick a customer to link.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await convertInquiry(inquiryId, target, {
      customerId: target !== "inspection" && link === "existing" ? customerId : null,
      startDate: target === "inspection" ? inspectDate : undefined,
    });
    if (res.ok && res.redirect) {
      router.push(res.redirect);
      return;
    }
    setError(res.error ?? "Could not convert.");
    setBusy(false);
  }

  const isInspection = target === "inspection";

  return (
    <>
      <div className="relative">
        <Button size="sm" onClick={() => setMenuOpen((v) => !v)}>
          Convert <ChevronDown className="h-4 w-4" />
        </Button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-[75]" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full z-[80] mt-1 w-40 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {ORDER.map((t) => (
                <button
                  key={t}
                  onClick={() => choose(t)}
                  className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  → {LABELS[t]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <Modal
        open={!!target}
        onClose={() => !busy && setTarget(null)}
        title={isInspection ? "Book a site inspection" : target ? `Convert to ${LABELS[target]}` : ""}
        footer={
          <ModalActions
            onCancel={() => setTarget(null)}
            onSave={run}
            saving={busy}
            saveLabel={
              isInspection ? "Book inspection" : target === "customer" ? "Convert" : `Continue to ${target ? LABELS[target] : ""}`
            }
          />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {isInspection ? (
            <>
              <p className="text-sm text-slate-600">
                Books a site inspection for <strong>{inquiryName}</strong> onto your Schedule (it shows as an amber
                inspection you can move or reassign). The lead stays open, so you can turn it into an estimate after.
              </p>
              <div>
                <Label htmlFor="inspect-date">Inspection date</Label>
                <Input
                  id="inspect-date"
                  type="date"
                  value={inspectDate}
                  onChange={(e) => setInspectDate(e.target.value)}
                />
                <p className="mt-1 text-xs text-slate-400">Defaults to 9:00 AM — fine-tune the time on the Schedule.</p>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Attach a customer to this {target}. Nothing is created until you confirm.
              </p>
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="radio" name="link" checked={link === "new"} onChange={() => setLink("new")} className="mt-0.5" />
                  <span>Create a new customer from <strong>{inquiryName}</strong></span>
                </label>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="radio" name="link" checked={link === "existing"} onChange={() => setLink("existing")} className="mt-0.5" />
                  <span>Link an existing customer</span>
                </label>
                {link === "existing" && (
                  <div className="pl-6">
                    <Label htmlFor="cust">Customer</Label>
                    <Select id="cust" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                      <option value="">— Select —</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </Select>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
