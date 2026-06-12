"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Copy, MessageSquare, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { createScheduleProposal, cancelScheduleProposal } from "../../schedule/actions";

const fmt = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

function defaultDates(): string[] {
  // Next three weekdays, starting tomorrow.
  const out: string[] = [];
  const d = new Date();
  while (out.length < 3) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      const p = (n: number) => String(n).padStart(2, "0");
      out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    }
  }
  return out;
}

/** Offer the customer 3 dates → share a link → they tap one → job schedules. */
export function ProposeDatesButton({
  jobId,
  customerPhone,
  pending: pendingProposal,
}: {
  jobId: string;
  customerPhone?: string | null;
  pending?: { id: string; token: string; dates: string[] } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>(defaultDates());
  const [token, setToken] = useState<string | null>(pendingProposal?.token ?? null);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = token && origin ? `${origin}/pick/${token}` : null;
  const smsBody = link
    ? encodeURIComponent(`Hi! Pick a day that works for your electrical work and we'll lock it in: ${link}`)
    : "";

  function create() {
    setError(null);
    start(async () => {
      const res = await createScheduleProposal(jobId, dates);
      if (!res.ok || !res.token) return setError(res.error ?? "Could not create the link.");
      setToken(res.token);
      router.refresh();
    });
  }

  function cancel() {
    if (!pendingProposal) return;
    start(async () => {
      await cancelScheduleProposal(pendingProposal.id, jobId);
      setToken(null);
      setOpen(false);
      router.refresh();
    });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — the link is visible to select manually */
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <CalendarPlus className="h-4 w-4" />
        {pendingProposal ? "Dates offered…" : "Propose dates"}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Let the customer pick a date">
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {token ? (
            <>
              <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                Link ready — text it to the customer. The job schedules itself the moment they tap a date.
              </div>
              {pendingProposal && (
                <p className="text-xs text-slate-500">
                  Offered: {pendingProposal.dates.map(fmt).join(" · ")}
                </p>
              )}
              <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{link}</code>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={copy}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <a
                  href={`sms:${customerPhone ?? ""}${customerPhone ? "&" : "?"}body=${smsBody}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
                >
                  <MessageSquare className="h-3.5 w-3.5" /> Text it
                </a>
                {pendingProposal && (
                  <Button size="sm" variant="outline" onClick={cancel} disabled={busy} className="text-red-600">
                    <X className="h-3.5 w-3.5" /> Withdraw
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Offer up to three days. The customer gets a link, taps one, and the job lands on the
                schedule (8&nbsp;AM start) — no phone tag.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {dates.map((d, i) => (
                  <div key={i}>
                    <Label>Option {i + 1}</Label>
                    <Input
                      type="date"
                      value={d}
                      onChange={(e) =>
                        setDates((arr) => arr.map((x, xi) => (xi === i ? e.target.value : x)))
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={create} disabled={busy}>
                  {busy ? "Creating…" : "Create link"}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
