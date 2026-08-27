"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Phone, Mail, Globe, MapPin } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { InquiryModal } from "./inquiry-modal";
import { ConvertMenu } from "./convert-menu";
import { convertInquiry, deleteInquiry, markInquiryContacted, setInquiryStatus } from "./actions";
import { useToast } from "@/components/toast";
import { formatDateTime, formatDate } from "@/lib/utils";
import type { Inquiry, LeadBucket } from "@/lib/types";
import { INQUIRY_STATUSES } from "@/lib/statuses";
import { LEAD_BUCKETS } from "@/lib/lead-triage";
import { IntakeFiles } from "./intake-files";
import { PlanBriefPanel } from "./plan-brief-panel";
import { intakePaths } from "@/lib/playbook/uploads";

// Named INQUIRY_STATUS_TONE (not `statusTone`) so it can't shadow the shared badge
// statusTone helper. Values cover every INQUIRY_STATUSES entry.
const INQUIRY_STATUS_TONE: Record<string, "blue" | "amber" | "indigo" | "green" | "slate"> = {
  new: "blue",
  contacted: "amber",
  quoted: "indigo",
  won: "green",
  lost: "slate",
};

// The A/B/C readiness chip — colour + Chris's dot language (🟢 ready · 🟡 measure · 🔵 consult).
const BUCKET_TONE: Record<LeadBucket, "green" | "amber" | "blue"> = { A: "green", B: "amber", C: "blue" };
const BUCKET_DOT: Record<LeadBucket, string> = { A: "🟢", B: "🟡", C: "🔵" };



export function InquiryRow({
  inquiry,
  customers,
  focused = false,
  inspections = null,
}: {
  inquiry: Inquiry;
  customers: { id: string; name: string }[];
  /** True when My Day (or an estimate backlink) deep-linked to this exact lead —
      scroll it into view and flash a highlight so the eye lands on the right row. */
  focused?: boolean;
  /** Walk-throughs on this lead. A lead with a completed inspection is CORRECTLY still open —
   *  inspection is exempt from converting, so it can still become an estimate — but the row used
   *  to look identical to one nobody had touched. This is what it takes to tell them apart. */
  inspections?: { done: number; upcoming: number } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [followUp, setFollowUp] = useState(inquiry.next_follow_up_at ?? "");
  const toast = useToast();
  const rowRef = useRef<HTMLLIElement>(null);
  const [flash, setFlash] = useState(false);
  // Option B (approved by Erik AND Andrew off the layout mock): two lines per lead, the one-tap
  // verbs ON the row, and everything heavier — the message, the files, follow-up date, status,
  // edit — behind this one toggle. The old row stacked all of it full-width below lg, so three
  // leads filled a phone screen.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // On un-focus (e.g. a same-route nav to /leads that keeps this row mounted) clear the ring —
    // otherwise the cleanup cancels the pending setFlash(false) and the highlight sticks on.
    if (!focused || !rowRef.current) { setFlash(false); return; }
    rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2200);
    return () => clearTimeout(t);
  }, [focused]);

  /**
   * OVERDUE WAS COMPARING TWO DIFFERENT MIDNIGHTS.
   *
   * Erik: "all the red letters everywhere take all the clarity out of the whole page … the follow
   * up overdue button needs a different existence." It was not merely noisy — it was WRONG, and
   * that is why it appeared on every row.
   *
   *   new Date("2026-08-25")             → UTC midnight
   *   new Date(new Date().toDateString()) → LOCAL midnight
   *
   * West of UTC the first is always earlier, so `<` is true for a lead due TODAY. In Pacific,
   * 00:00Z < 07:00Z — every lead due today read as overdue, every day, for everyone.
   *
   * Comparing the two as YMD STRINGS has no parsing mode to get wrong. This project already has a
   * tz layer for exactly this class; the leads row predated it.
   */
  const todayYmd = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const overdue =
    !!inquiry.next_follow_up_at && String(inquiry.next_follow_up_at).slice(0, 10) < todayYmd;

  // The Status dropdown is the ONE lead-state control (the old standalone "Contacted"
  // button was redundant with it and crowded the row). Picking "Contacted" still does the
  // full stamp — last_contacted_at + the follow-up date — via markInquiryContacted; every
  // other status is a plain set.
  function changeStatus(status: string) {
    start(async () => {
      const res =
        status === "contacted"
          ? await markInquiryContacted(inquiry.id, followUp || null)
          : await setInquiryStatus(inquiry.id, status);
      if (!res?.ok) { toast(res?.error ?? "Couldn't update status — try again.", "error"); return; }
      if (status === "contacted") toast("Marked contacted", "success");
      // The list filters lost leads out, so the row vanishes — say it worked.
      if (status === "lost") toast("Marked lost", "success");
      router.refresh();
    });
  }

  /** The NAME is the contact control now. Linked → a link (above); not linked → this makes one,
   *  then routes straight to it, because "create a contact" and "open it" are one intention. */
  const [savingContact, setSavingContact] = useState(false);
  function saveAsContact() {
    setSavingContact(true);
    start(async () => {
      const res = await convertInquiry(inquiry.id, "customer", {});
      if (res.ok && res.redirect) {
        router.push(res.redirect);
        return;
      }
      setSavingContact(false);
      toast(res.error ?? "Couldn't make a contact from this lead.", "error");
    });
  }

  // Street first, then the town — the two parts he actually reads. Comma-joined and trimmed so a
  // lead carrying only a town still shows the town rather than nothing.
  const addressLine = [inquiry.address, inquiry.city].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");

  return (
    <li
      ref={rowRef}
      id={`lead-${inquiry.id}`}
      className={`flex scroll-mt-24 flex-col gap-1 px-4 py-2.5 transition-colors ${
        flash ? "bg-brand/5 ring-2 ring-inset ring-brand" : ""
      }`}
    >
      {/* ── LINE 1: WHO, and how to reach them. Erik: "lets do the phone number and email to the
          right of the name, have the name be the contact button or create contact option to clear
          up all that much more space … lets unify and simplfy in all we do."
          The name IS the contact control now — a separate button for it was a second thing saying
          what the name already says. Linked → opens the contact; not linked → makes one. ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {inquiry.customer_id ? (
          <Link
            href={`/crm/${inquiry.customer_id}`}
            onClick={(e) => e.stopPropagation()}
            className="font-semibold text-slate-900 hover:text-brand hover:underline"
            title="Open this contact"
          >
            {inquiry.name}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => saveAsContact()}
            disabled={savingContact}
            className="font-semibold text-slate-900 decoration-dotted underline-offset-4 hover:text-brand hover:underline"
            title="Not a contact yet — tap to make one"
          >
            {savingContact ? "Saving…" : inquiry.name}
          </button>
        )}
        {inquiry.company_name && <span className="text-xs text-slate-400">{inquiry.company_name}</span>}
        {inquiry.phone && (
          <a href={`tel:${inquiry.phone}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 text-xs font-medium text-brand hover:underline">
            <Phone className="h-3 w-3 shrink-0" /> {inquiry.phone}
          </a>
        )}
        {inquiry.email && (
          <a href={`mailto:${inquiry.email}`} onClick={(e) => e.stopPropagation()} className="hidden items-center gap-1 text-xs text-slate-500 hover:text-brand hover:underline sm:flex">
            <Mail className="h-3 w-3 shrink-0" /> {inquiry.email}
          </a>
        )}
        {/* THE ADDRESS IS THE HEADLINE. Erik, entering his real lead list: "addresses addresses and
            more addresses that is what this business is, lets see it up on the lead top line."
            It was rendered only inside the expanded detail, so scanning the board told him who
            called but never WHERE — and where is how he decides what to group into a day's route.
            A tel: link is one tap; so is this: it opens the map, which is the thing he actually
            does next with an address. */}
        <Badge tone={INQUIRY_STATUS_TONE[inquiry.status] ?? "slate"}>{inquiry.status}</Badge>
        {/* Staying open after an inspection is deliberate (an inspected lead can still become an
            estimate); the badge is what stops the row reading as untouched. A count, not a
            status: what it says is true and stays true. */}
        {!!inspections?.done && (
          <Badge tone="green">{inspections.done === 1 ? "inspected" : `inspected ×${inspections.done}`}</Badge>
        )}
        {!inspections?.done && !!inspections?.upcoming && <Badge tone="blue">inspection booked</Badge>}
        {inquiry.lead_bucket && (
          <Badge tone={BUCKET_TONE[inquiry.lead_bucket]} title={LEAD_BUCKETS[inquiry.lead_bucket].blurb}>
            {BUCKET_DOT[inquiry.lead_bucket]} {inquiry.lead_bucket}
          </Badge>
        )}
        {inquiry.site_inspection_required && (
          <Badge tone="red" title="Needs a human site visit — triaged over the threshold, or the customer requested one (send them times via Convert → Let them pick).">
            🚩 Site visit
          </Badge>
        )}
        {["public_form", "intake"].includes(String(inquiry.source)) && (
          <Badge tone="slate"><Globe className="mr-1 inline h-3 w-3" />web</Badge>
        )}
        {(inquiry.source === "tahoe_deck" || inquiry.source === "deck_configurator") && (
          <Badge tone="slate"><Globe className="mr-1 inline h-3 w-3" />deck site</Badge>
        )}
        {(inquiry as any).referrer?.full_name && (
          <Badge tone="green">referred by {(inquiry as any).referrer.full_name}</Badge>
        )}
        {/* Now that the date maths is right this is genuinely rare, so it can stay red — a badge
            earns its colour by being uncommon. Before the fix it fired on every row and read as
            decoration. Amber, not red: a follow-up slipping a day is a nudge, not an alarm. */}
        {/* "Follow up" is a STATE, not a missed appointment. Erik: "have it just say follow up
            and leave it on a list of follow ups." A lead with no visit booked and no date promised
            is simply on the follow-up list — that is neutral, not late. A real DATE that has
            actually passed is the only thing that earns amber. */}
        {overdue ? (
          <Badge tone="amber">follow up · {formatDate(inquiry.next_follow_up_at!)}</Badge>
        ) : (
          !inquiry.next_follow_up_at && !inspections?.done && !inspections?.upcoming && (
            <Badge tone="slate">follow up</Badge>
          )
        )}
        <span className="ml-auto whitespace-nowrap font-mono text-xs tabular-nums text-slate-400" title={`Added ${formatDateTime(inquiry.created_at)}`}>
          {formatDateTime(inquiry.created_at)}
        </span>
      </div>

      {/* ── LINE 2: THE ADDRESS, left-justified under the name, on its own line.
          "addresses addresses and more addresses that is what this business is" — on its own line
          it starts at the same x on every row, so the column reads down the page. Sharing line 1
          with the name meant it started wherever the name ended. One tap opens Maps, which is
          what he actually does next with an address. ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500">
        {addressLine && (
          <a
            href={`https://maps.apple.com/?q=${encodeURIComponent(addressLine)}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-brand hover:underline"
            title="Open in Maps"
          >
            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {addressLine}
          </a>
        )}
        {inquiry.last_contacted_at && <span>contacted {formatDate(inquiry.last_contacted_at)}</span>}
        {inquiry.intake?.reason && <span className="hidden text-slate-400 md:inline">{inquiry.intake.reason}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details — message, files, follow-up, status"}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-50"
          >
            {open ? "Less" : "⋯"}
          </button>
        </span>
      </div>

      {/* ── LINE 3: THE THREE VERBS, on their own row and centred. Erik: "they should line up on
          the page centered instead of all over the place now its confusing."
          They used to sit at the END of the contact line, so their left edge moved with whatever
          phone / email / note happened to precede them — every row put them somewhere different
          and the eye had to re-find them on each one. On their own row they land in the same place
          all the way down the list, which is what makes a list of 32 scannable. ── */}
      <ConvertMenu inquiryId={inquiry.id} inquiryName={inquiry.name} customers={customers} />

      {/* The message rides collapsed as ONE clamped line — the single biggest source of the old
          row's height. The full text, the customer's files and the workflow controls all live one
          tap away, on the row, without a navigation. */}
      {!open && inquiry.message && (
        <p className="line-clamp-1 text-xs text-slate-500">{inquiry.message}</p>
      )}

      {open && (
        <div className="mt-1 space-y-3 rounded-lg bg-slate-50/70 p-3">
          {inquiry.message && <p className="whitespace-pre-wrap text-sm text-slate-600">{inquiry.message}</p>}
          <IntakeFiles inquiryId={inquiry.id} paths={intakePaths(inquiry.intake)} />
          <PlanBriefPanel inquiryId={inquiry.id} intake={inquiry.intake} />
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">Follow up</label>
              <Input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="h-8 w-40 text-xs" />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">Status</label>
              {/* "Lost" lives ONLY here (a deliberate two-tap pick) — the old one-tap "Mark lost"
                  button vanished the row from a mis-tap beside Edit/Convert. */}
              <Select
                value={inquiry.status}
                disabled={pending}
                className="h-8 w-36 text-xs"
                onChange={(e) => changeStatus(e.target.value)}
              >
                {INQUIRY_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st.replace(/^\w/, (c) => c.toUpperCase())}
                  </option>
                ))}
              </Select>
            </div>
            <InquiryModal inquiry={inquiry} mode="edit" />
            {/* DELETE, inside the ⋯ panel — Erik: "add a way to delete a lead entry… or a Delete
                option inside the row's ⋯ menu." Behind the door and behind a confirm, per the nav
                doctrine: destructive never sits beside the verbs you tap at 60mph. Note the split
                of meanings — LOST is a two-tap status for a lead that said no (it keeps the
                record); delete is for tests and junk, and it keeps nothing. */}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                // A CONVERTED lead is an estimate's provenance (audit 7): deleting it severs
                // the estimate's only link back to the person. Say so before the click.
                if (!confirm(inquiry.converted_at
                  ? `Delete "${inquiry.name}" completely? An estimate came from this lead — deleting cuts that estimate's link to the person, cancels any un-confirmed booking links, and removes the lead's uploaded files and any walk-through that has no field notes or photos. Mark it Lost instead unless it was junk.`
                  : `Delete "${inquiry.name}" completely? A lead that said no should be marked Lost instead — delete keeps nothing: its uploaded files and any walk-through without field notes or photos go with it.`)) return;
                start(async () => {
                  const r = await deleteInquiry(inquiry.id);
                  if (!r.ok) toast(r.error ?? "Couldn't delete that.", "error");
                  else router.refresh();
                });
              }}
              className="ml-auto self-end rounded-lg px-2 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
            >
              Delete lead
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
