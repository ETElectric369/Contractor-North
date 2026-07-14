"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Check, Copy, FileText, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { convertInquiry } from "./actions";

/** A sensible default inspection date: 2 days out. */
function defaultInspectDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Next three weekdays at 9 AM — default options for "Let them pick" (9 AM is
 *  the inspection convention; the office fine-tunes per slot). */
function defaultSlots(): { date: string; time: string }[] {
  const out: { date: string; time: string }[] = [];
  const d = new Date();
  while (out.length < 3) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6)
      out.push({ date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: "09:00" });
  }
  return out;
}

/**
 * The lead's TWO front-and-center next steps — no more "Convert ▾" grab-bag. A lead either needs a
 * site visit to gather scope, or it's ready to price:
 *   • Schedule inspection — books a site visit onto the Schedule; the lead STAYS a lead. Two ways:
 *     "Book it" (a firm date) or "Let them pick" (offer up to 3 times → a /pick link to text them,
 *     same pattern as the appointment modal's Propose Times).
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
  const [mode, setMode] = useState<"book" | "pick">("book");
  const [slots, setSlots] = useState(defaultSlots);
  const [timeNote, setTimeNote] = useState("");
  const [link, setLink] = useState<{ token: string; phone: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "estimate" | "inspection">(null);
  const [error, setError] = useState<string | null>(null);

  async function run(target: "estimate" | "inspection") {
    setBusy(target);
    setError(null);
    // "estimate" opens the estimate builder from the lead; "inspection" books the site visit.
    const res = await convertInquiry(inquiryId, target === "estimate" ? "quote" : "inspection", {
      ...(target === "inspection"
        ? mode === "pick"
          ? { slots: slots.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date)), timeNote: timeNote.trim() || null }
          : { startDate: inspectDate }
        : {}),
    });
    if (res.ok && res.token) {
      // "Let them pick" — show the link-ready screen; the lead stays open.
      setLink({ token: res.token, phone: res.phone ?? null });
      setBusy(null);
      router.refresh();
      return;
    }
    if (res.ok && res.redirect) {
      router.push(res.redirect);
      return;
    }
    setError(res.error ?? "Something went wrong.");
    setBusy(null);
  }

  function openInspect() {
    setInspectDate(defaultInspectDate());
    setSlots(defaultSlots());
    setTimeNote("");
    setLink(null);
    setError(null);
    setMode("book");
    setInspectOpen(true);
  }

  function closeInspect() {
    if (busy !== null) return;
    setInspectOpen(false);
    setLink(null);
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const pickLink = link && origin ? `${origin}/pick/${link.token}` : null;
  const smsBody = `Hi! Pick a time for your site visit and we'll lock it in: ${pickLink}`;

  async function copyLink() {
    if (!pickLink) return;
    try {
      await navigator.clipboard.writeText(pickLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — link is visible to select */
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={openInspect} disabled={busy !== null}>
          <CalendarPlus className="h-4 w-4" /> Schedule inspection
        </Button>
        <Button size="sm" onClick={() => run("estimate")} disabled={busy !== null}>
          <FileText className="h-4 w-4" /> {busy === "estimate" ? "Opening…" : "Create estimate"}
        </Button>
      </div>
      {error && !inspectOpen && <p className="mt-1 text-xs text-red-600">{error}</p>}

      <Modal
        open={inspectOpen}
        onClose={closeInspect}
        title={link ? "Text them these times" : "Book a site inspection"}
        size="sm"
        footer={
          link ? (
            <ModalActions onCancel={closeInspect} onSave={closeInspect} saveLabel="Done" hideCancel />
          ) : (
            <ModalActions
              onCancel={closeInspect}
              onSave={() => run("inspection")}
              saving={busy === "inspection"}
              saveLabel={mode === "pick" ? "Create Link" : "Book inspection"}
            />
          )
        }
      >
        {link ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              Link ready — text it to <strong>{inquiryName}</strong>. The inspection confirms onto your
              calendar the moment they tap a time, and the lead stays open for the estimate.
            </div>
            <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{pickLink}</code>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={copyLink}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy Link"}
              </Button>
              <a
                href={`sms:${link.phone ?? ""}?body=${encodeURIComponent(smsBody)}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
              >
                <MessageSquare className="h-4 w-4 shrink-0" /> Text It
              </a>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Books a site inspection for <strong>{inquiryName}</strong> onto your Schedule (an amber inspection you can move or
              reassign). The lead stays open, so you can create the estimate after the visit.
            </p>

            <SegmentedControl
              stretch
              activeId={mode}
              onSelect={(id) => setMode(id as typeof mode)}
              items={[
                { id: "book", label: "Book it" },
                { id: "pick", label: "Let them pick" },
              ]}
            />

            {mode === "book" ? (
              <div>
                <Label htmlFor="inspect-date">Inspection date</Label>
                <Input id="inspect-date" type="date" value={inspectDate} onChange={(e) => setInspectDate(e.target.value)} />
                <p className="mt-1 text-xs text-slate-400">Defaults to 9:00 AM — fine-tune the time on the Schedule.</p>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-brand/30 bg-brand-light/20 p-3">
                <Label>Offer up to 3 times — they tap one and it books itself</Label>
                {slots.map((sl, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <Input
                      type="date"
                      value={sl.date}
                      onChange={(ev) => setSlots((a) => a.map((x, xi) => (xi === i ? { ...x, date: ev.target.value } : x)))}
                      aria-label={`Option ${i + 1} date`}
                    />
                    <Input
                      type="time"
                      value={sl.time}
                      onChange={(ev) => setSlots((a) => a.map((x, xi) => (xi === i ? { ...x, time: ev.target.value } : x)))}
                      aria-label={`Option ${i + 1} time`}
                    />
                  </div>
                ))}
                <div>
                  <Label htmlFor="inspect-window">Arrival window (optional)</Label>
                  <Input
                    id="inspect-window"
                    value={timeNote}
                    onChange={(e) => setTimeNote(e.target.value)}
                    placeholder="e.g. 8–10 AM"
                  />
                </div>
              </div>
            )}
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          </div>
        )}
      </Modal>
    </>
  );
}
