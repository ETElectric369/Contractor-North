"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { convertInquiry } from "./actions";

/** A sensible default inspection date: 2 days out. */
function defaultInspectDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

/**
 * The lead's TWO front-and-center next steps — no more "Convert ▾" grab-bag. A lead either needs a
 * site visit to gather scope, or it's ready to price:
 *   • Schedule inspection — books a site visit onto the Schedule; the lead STAYS a lead.
 *   • Create estimate — opens the estimate builder from this lead.
 * The rest of the pipeline (customer + scheduled job) happens automatically when the estimate is
 * ACCEPTED — that's the moment a prospect becomes a customer, so Contacts never fills with people
 * who never bought. (`customers` prop kept for signature stability; no longer used here.)
 */
export function ConvertMenu({
  inquiryId,
  inquiryName,
}: {
  inquiryId: string;
  inquiryName: string;
  customers?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectDate, setInspectDate] = useState(defaultInspectDate());
  const [busy, setBusy] = useState<null | "estimate" | "inspection">(null);
  const [error, setError] = useState<string | null>(null);

  async function run(target: "estimate" | "inspection", opts: { startDate?: string } = {}) {
    setBusy(target);
    setError(null);
    // "estimate" opens the estimate builder from the lead; "inspection" books the site visit.
    const res = await convertInquiry(inquiryId, target === "estimate" ? "quote" : "inspection", {
      startDate: opts.startDate,
    });
    if (res.ok && res.redirect) {
      router.push(res.redirect);
      return;
    }
    setError(res.error ?? "Something went wrong.");
    setBusy(null);
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => { setInspectDate(defaultInspectDate()); setInspectOpen(true); }} disabled={busy !== null}>
          <CalendarPlus className="h-4 w-4" /> Schedule inspection
        </Button>
        <Button size="sm" onClick={() => run("estimate")} disabled={busy !== null}>
          <FileText className="h-4 w-4" /> {busy === "estimate" ? "Opening…" : "Create estimate"}
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      <Modal
        open={inspectOpen}
        onClose={() => busy === null && setInspectOpen(false)}
        title="Book a site inspection"
        size="sm"
        footer={<ModalActions onCancel={() => setInspectOpen(false)} onSave={() => run("inspection", { startDate: inspectDate })} saving={busy === "inspection"} saveLabel="Book inspection" />}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Books a site inspection for <strong>{inquiryName}</strong> onto your Schedule (an amber inspection you can move or
            reassign). The lead stays open, so you can create the estimate after the visit.
          </p>
          <div>
            <Label htmlFor="inspect-date">Inspection date</Label>
            <Input id="inspect-date" type="date" value={inspectDate} onChange={(e) => setInspectDate(e.target.value)} />
            <p className="mt-1 text-xs text-slate-400">Defaults to 9:00 AM — fine-tune the time on the Schedule.</p>
          </div>
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        </div>
      </Modal>
    </>
  );
}
