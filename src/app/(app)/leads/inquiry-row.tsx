"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { WorkShapeControls } from "@/components/work-shape-controls";
import { useRouter } from "next/navigation";
import { Phone, Mail, Globe, MapPin, UserPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { InquiryModal } from "./inquiry-modal";
import { ConvertMenu } from "./convert-menu";
import { convertInquiry, deleteInquiry, markInquiryContacted, setInquiryStatus, sizeLead, snoozeInquiry } from "./actions";
import { useToast, type ToastAction } from "@/components/toast";
import { formatDateTime, formatDate } from "@/lib/utils";
import type { Inquiry } from "@/lib/types";
import { LEAD_BUCKETS } from "@/lib/lead-triage";
import { leadNextStep, monthDay, type LeadBucketLetter, type LeadVisitsAnswer } from "@/lib/leads/next-step";
import { IntakeFiles } from "./intake-files";
import { PlanBriefPanel } from "./plan-brief-panel";
import { intakePaths } from "@/lib/playbook/uploads";

// The bucket's colored dot (Chris's dot language: green ready · amber measure · blue consult).
const BUCKET_DOT: Record<LeadBucketLetter, string> = { A: "bg-emerald-500", B: "bg-amber-500", C: "bg-sky-500" };

/** The ⋯ panel's buttons: 44px, Title Case, one look. */
const PANEL_BTN =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";

type Toast = (message: string, kind?: "success" | "error" | "info", action?: ToastAction) => void;

/**
 * MARK LOST, WITH UNDO (W2-07). No confirm: the Undo is the safety, and it puts back the status the
 * lead HAD, carried in the toast (never a guessed "new"). The list drops lost leads, so the row goes
 * and the toast is what says where it went.
 */
export async function markLeadLost(
  lead: { id: string; name: string; status: string },
  deps: { setStatus: (id: string, status: string) => Promise<{ ok: boolean; error?: string }>; toast: Toast; refresh: () => void },
): Promise<void> {
  const was = lead.status;
  const res = await deps.setStatus(lead.id, "lost");
  if (!res?.ok) {
    deps.toast(res?.error ?? "Couldn't mark it lost — try again.", "error");
    return;
  }
  deps.toast(`Marked ${lead.name} Lost`, "success", {
    label: "Undo",
    onClick: () => {
      void (async () => {
        const back = await deps.setStatus(lead.id, was);
        deps.toast(back.ok ? "Put back." : (back.error ?? "Couldn't put it back."), back.ok ? "success" : "error");
        deps.refresh();
      })();
    },
  });
  deps.refresh();
}

/**
 * SAVE AS CONTACT, named and on purpose (W2-07). The lead's name used to be a button that made a
 * contact card on a tap whose only warning was a hover title a phone never shows: a silent write.
 * Erik (cn-v724): "a lead can convert to a contact anytime if the person wants to create one", so the
 * door stays, where a person asks for it. convertInquiry(id, 'customer') checks the book first and
 * never closes the lead; the toast says which happened ("Saved Rita Moss As A Contact", or "Linked To
 * Rita Moss" when the book already had her) and offers Open. Nothing navigates on its own.
 */
export async function saveLeadAsContact(
  lead: { id: string; name: string },
  deps: {
    convert: (id: string) => Promise<{ ok: boolean; id?: string; error?: string; contact?: { id: string; name: string; existing: boolean } }>;
    toast: Toast;
    open: (href: string) => void;
    refresh: () => void;
  },
): Promise<void> {
  const res = await deps.convert(lead.id);
  if (!res.ok || !res.id) {
    deps.toast(res.error ?? "Couldn't make a contact from this lead.", "error");
    return;
  }
  const id = res.id;
  const card = res.contact;
  deps.toast(card?.existing ? `Linked To ${card.name}` : `Saved ${card?.name || lead.name} As A Contact`, "success", {
    label: "Open",
    onClick: () => deps.open(`/crm/${id}`),
  });
  deps.refresh();
}

export function InquiryRow({
  inquiry,
  customers,
  focused = false,
  visits = null,
  todayYmd,
  tz,
  businessPhone = null,
  estimateDoor = true,
  referralsOn = false,
}: {
  inquiry: Inquiry;
  customers: { id: string; name: string }[];
  /** True when My Day (or an estimate backlink) deep-linked to this exact lead —
      scroll it into view and flash a highlight so the eye lands on the right row. */
  focused?: boolean;
  /** This lead's visits (lib/leads/visit-read, three answers): what the next-step chip reads. A lead
   *  with a completed inspection is CORRECTLY still open (an inspection never converts it), and the
   *  chip is what tells it apart from a lead nobody has touched. VISITS_UNREAD when the board could
   *  not read them — then the chip says so instead of guessing the next step. */
  visits?: LeadVisitsAnswer;
  /** The company's today (YYYY-MM-DD) and clock: a follow-up day and a visit's day are theirs. */
  todayYmd: string;
  tz: string;
  /** The org's own line (organizations.phone) — the "Text it" handoff has to be able to name it. */
  businessPhone?: string | null;
  /** The Estimates switch (0352): off, the row has no Estimate button. */
  estimateDoor?: boolean;
  /** The Track Referrals switch: on, the ⋯ panel says who referred them. */
  referralsOn?: boolean;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const [flash, setFlash] = useState(false);
  // Option B (approved by Erik AND Andrew off the layout mock): two lines per lead, the one-tap
  // verbs ON the row, and everything heavier — the message, the files, follow-up date, contact,
  // edit — behind this one toggle.
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

  /* ONE NEXT-STEP CHIP (W2-07) in place of up to nine badges (status, inspection counts, bucket,
     site visit, web, deck site, referred by, follow up): lib/leads/next-step reads the same facts and
     says what to do next. The bucket's letter and dot lead it only on a lead that carries one. */
  const step = leadNextStep(
    {
      status: inquiry.status,
      converted_at: inquiry.converted_at,
      converted_to: inquiry.converted_to,
      next_follow_up_at: inquiry.next_follow_up_at,
      lead_bucket: inquiry.lead_bucket,
      site_inspection_required: inquiry.site_inspection_required,
      source: (inquiry as { source?: string | null }).source ?? null,
      referred_by: (inquiry as { referred_by?: string | null }).referred_by ?? null,
    },
    visits,
    todayYmd,
    { estimatesOn: estimateDoor, tz },
  );

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
      {/* ── LINE 1: WHO, how to reach them, and the ONE next step. Erik: "lets do the phone number
          and email to the right of the name". A linked lead's name opens its contact; an unlinked
          one is only its name: making a contact is the ⋯ panel's Save As Contact, never a tap on a
          name. ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {inquiry.customer_id ? (
          <Link
            href={`/crm/${inquiry.customer_id}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex min-h-11 items-center font-semibold text-slate-900 hover:text-brand hover:underline"
            title="Open this contact"
          >
            {inquiry.name}
          </Link>
        ) : (
          <span className="font-semibold text-slate-900">{inquiry.name}</span>
        )}
        {inquiry.company_name && <span className="text-xs text-slate-400">{inquiry.company_name}</span>}
        {inquiry.phone && (
          <a href={`tel:${inquiry.phone}`} onClick={(e) => e.stopPropagation()} className="flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline">
            <Phone className="h-3 w-3 shrink-0" /> {inquiry.phone}
          </a>
        )}
        {inquiry.email && (
          <a href={`mailto:${inquiry.email}`} onClick={(e) => e.stopPropagation()} className="hidden min-h-11 items-center gap-1 text-xs text-slate-500 hover:text-brand hover:underline sm:flex">
            <Mail className="h-3 w-3 shrink-0" /> {inquiry.email}
          </a>
        )}
        <span className="inline-flex items-center gap-1.5">
          {step.web && (
            <span role="img" aria-label="From Your Website" title="From Your Website" className="inline-flex text-slate-400">
              <Globe className="h-3.5 w-3.5" />
            </span>
          )}
          <Badge tone={step.tone} title={step.bucket ? LEAD_BUCKETS[step.bucket].blurb : undefined} className="gap-1.5">
            {step.bucket && <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${BUCKET_DOT[step.bucket]}`} />}
            {step.label}
          </Badge>
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-xs tabular-nums text-slate-400" title={`Added ${formatDateTime(inquiry.created_at)}`}>
          {formatDateTime(inquiry.created_at)}
        </span>
      </div>

      {/* ── LINE 2: THE ADDRESS, left-justified under the name, on its own line.
          "addresses addresses and more addresses that is what this business is" — on its own line
          it starts at the same x on every row, so the column reads down the page. One tap opens
          Maps, which is what he actually does next with an address. ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500">
        {addressLine && (
          <a
            href={`https://maps.apple.com/?q=${encodeURIComponent(addressLine)}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex min-h-11 items-center gap-1 text-sm font-medium text-slate-600 hover:text-brand hover:underline"
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
            aria-label={open ? "Hide details" : "Show details — message, files, follow-up, contact"}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
          >
            {open ? "Less" : "⋯"}
          </button>
        </span>
      </div>

      {/* ── LINE 3: THE THREE VERBS, on their own row and centred (Erik: "they should line up on the
          page centered instead of all over the place"). A CONVERTED LEAD IS PROVENANCE, NOT A LEAD:
          a ?focus= row that already became an estimate or a job offers no verbs (its chip says what
          it became). ── */}
      {inquiry.converted_at ? (
        <p className="text-center text-xs text-slate-400">
          Already converted — its estimate or job carries the work now.
        </p>
      ) : (
        <ConvertMenu inquiryId={inquiry.id} inquiryName={inquiry.name} customers={customers} workKind={(inquiry as { work_kind?: string | null }).work_kind ?? null} businessPhone={businessPhone} estimateDoor={estimateDoor} />
      )}

      {/* The message rides collapsed as ONE clamped line — the single biggest source of the old
          row's height. The full text, the customer's files and the workflow controls all live one
          tap away, on the row, without a navigation. */}
      {!open && inquiry.message && (
        <p className="line-clamp-1 text-xs text-slate-500">{inquiry.message}</p>
      )}

      {open && <LeadDetails inquiry={inquiry} todayYmd={todayYmd} referralsOn={referralsOn} />}
    </li>
  );
}

/**
 * THE ⋯ PANEL (W2-07): the message and files, the plan report, the work's kind and size, then the
 * Follow Up day with Mark Contacted and Mark Lost (the status moves itself: Quoted and Won are stamped
 * by the deed that earns them), Save As Contact for a lead with no card, Edit, and Delete Lead.
 */
export function LeadDetails({
  inquiry,
  todayYmd,
  referralsOn = false,
}: {
  inquiry: Inquiry;
  todayYmd: string;
  referralsOn?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [followUp, setFollowUp] = useState(inquiry.next_follow_up_at?.slice(0, 10) ?? "");
  const referrer = (inquiry as { referrer?: { full_name?: string | null } | null }).referrer?.full_name ?? null;
  const converted = !!inquiry.converted_at;

  /** The Follow Up day saves itself once it is a real day, today or later (snoozeInquiry: the day
   *  only, no status). A day already gone is said under the box, never saved as a guess. */
  function pickFollowUp(v: string) {
    setFollowUp(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < todayYmd || v === (inquiry.next_follow_up_at ?? "").slice(0, 10)) return;
    start(async () => {
      const res = await snoozeInquiry(inquiry.id, v);
      if (!res.ok) { toast(res.error ?? "Couldn't save that day — try again.", "error"); return; }
      toast(`Follow up on ${monthDay(v)}.`, "success");
      router.refresh();
    });
  }

  function markContacted() {
    start(async () => {
      const res = await markInquiryContacted(inquiry.id, followUp || null);
      if (!res?.ok) { toast(res?.error ?? "Couldn't mark it contacted — try again.", "error"); return; }
      toast("Marked Contacted", "success");
      router.refresh();
    });
  }

  return (
    <div className="mt-1 space-y-3 rounded-lg bg-slate-50/70 p-3">
      {inquiry.message && <p className="whitespace-pre-wrap text-sm text-slate-600">{inquiry.message}</p>}
      {/* Who sent them, with Track Referrals on: a line in here, never a badge on the row. */}
      {referralsOn && referrer && <p className="text-xs text-slate-500">Referred By {referrer}</p>}
      <IntakeFiles inquiryId={inquiry.id} paths={intakePaths(inquiry.intake)} />
      <PlanBriefPanel inquiryId={inquiry.id} intake={inquiry.intake} />
      <div className="flex flex-wrap items-end gap-3">
        {/* THE CRITICAL PATH STARTS HERE. Erik: "this is what needs to be on the lead itself next to
            the contacted drop down menu, thats the critical path." Kind + size, set at the phone
            call, carried untouched to the schedule (the rail renders this SAME component), through
            placement, onto the calendar, into the job. Stated once. */}
        <div>
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">The work</label>
          <WorkShapeControls
            workKind={(inquiry as { work_kind?: string | null }).work_kind ?? null}
            plannedMinutes={(inquiry as { planned_minutes?: number | null }).planned_minutes ?? null}
            disabled={pending}
            onPatch={(patch) =>
              start(async () => {
                const r = await sizeLead(inquiry.id, patch);
                if (!r.ok) toast(r.error ?? "Couldn't save that.", "error");
                else router.refresh();
              })
            }
          />
        </div>
        {!converted && (
          <>
            <div>
              <label htmlFor={`follow-${inquiry.id}`} className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">
                Follow Up
              </label>
              <Input
                id={`follow-${inquiry.id}`}
                type="date"
                value={followUp}
                min={todayYmd}
                onChange={(e) => pickFollowUp(e.target.value)}
                className="h-11 w-40 text-xs"
              />
            </div>
            <button type="button" disabled={pending} onClick={markContacted} className={PANEL_BTN}>
              Mark Contacted
            </button>
            {inquiry.status !== "lost" && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(() =>
                    markLeadLost(
                      { id: inquiry.id, name: inquiry.name, status: inquiry.status },
                      { setStatus: setInquiryStatus, toast, refresh: () => router.refresh() },
                    ),
                  )
                }
                className={PANEL_BTN}
              >
                Mark Lost
              </button>
            )}
          </>
        )}
      </div>
      {!converted && /^\d{4}-\d{2}-\d{2}$/.test(followUp) && followUp < todayYmd && (
        <p className="text-xs text-amber-700">That day has passed. Pick today or later to save it.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {/* A contact is made HERE, by name, never by tapping the lead's name. Only a lead with no card
            that hasn't become anything yet. */}
        {!inquiry.customer_id && !converted && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(() =>
                saveLeadAsContact(
                  { id: inquiry.id, name: inquiry.name },
                  {
                    convert: (id) => convertInquiry(id, "customer", {}),
                    toast,
                    open: (href) => router.push(href),
                    refresh: () => router.refresh(),
                  },
                ),
              )
            }
            className={PANEL_BTN}
          >
            <UserPlus className="h-4 w-4 shrink-0" /> Save As Contact
          </button>
        )}
        <InquiryModal inquiry={inquiry} mode="edit" />
        {/* DELETE, inside the ⋯ panel — Erik: "add a way to delete a lead entry… or a Delete option
            inside the row's ⋯ menu." Behind the door and behind a confirm, per the nav doctrine:
            destructive never sits beside the verbs you tap at 60mph. Note the split of meanings —
            LOST is a lead that said no (it keeps the record); delete is for tests and junk, and it
            keeps nothing. */}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            // A CONVERTED lead is an estimate's provenance (audit 7): deleting it severs the
            // estimate's only link back to the person. Say so before the click.
            if (!confirm(inquiry.converted_at
              ? `Delete "${inquiry.name}" completely? An estimate came from this lead — deleting cuts that estimate's link to the person, cancels any un-confirmed booking links, and removes the lead's uploaded files and any inspection that has no field notes or photos. Mark it Lost instead unless it was junk.`
              : `Delete "${inquiry.name}" completely? A lead that said no should be marked Lost instead — delete keeps nothing: its uploaded files and any inspection without field notes or photos go with it.`)) return;
            start(async () => {
              const r = await deleteInquiry(inquiry.id);
              if (!r.ok) {
                toast(r.error ?? "Couldn't delete that.", "error");
                return;
              }
              toast("Lead deleted.", "success");
              router.refresh();
            });
          }}
          className="ml-auto inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-rose-600 hover:bg-rose-50"
        >
          Delete Lead
        </button>
      </div>
    </div>
  );
}
