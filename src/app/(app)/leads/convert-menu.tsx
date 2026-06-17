"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Select } from "@/components/ui/input";
import { convertInquiry } from "./actions";

type Target = "customer" | "quote" | "estimate" | "job";
const LABELS: Record<Target, string> = {
  customer: "Customer",
  quote: "Quote",
  estimate: "Estimate",
  job: "Job",
};

/** "Convert ▾" — explicit, never automatic. Pick a target, then link an
 *  existing customer or create one from the inquiry. */
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function choose(t: Target) {
    setTarget(t);
    setMenuOpen(false);
    setLink("new");
    setCustomerId("");
    setError(null);
  }

  async function run() {
    if (!target) return;
    if (link === "existing" && !customerId) {
      setError("Pick a customer to link.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await convertInquiry(inquiryId, target, {
      customerId: link === "existing" ? customerId : null,
    });
    if (res.ok && res.redirect) {
      router.push(res.redirect);
      return;
    }
    setError(res.error ?? "Could not convert.");
    setBusy(false);
  }

  return (
    <>
      <div className="relative">
        <Button size="sm" onClick={() => setMenuOpen((v) => !v)}>
          Convert <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {(["customer", "quote", "estimate", "job"] as Target[]).map((t) => (
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
        title={target ? `Convert to ${LABELS[target]}` : ""}
        footer={
          <ModalActions
            onCancel={() => setTarget(null)}
            onSave={run}
            saving={busy}
            saveLabel={target === "customer" ? "Convert" : `Continue to ${target ? LABELS[target] : ""}`}
          />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
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
        </div>
      </Modal>
    </>
  );
}
