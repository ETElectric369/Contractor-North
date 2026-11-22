"use client";

import Link from "next/link";
import { Phone, Mail, Globe, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import type { Inquiry } from "@/lib/types";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";
import { leadSourceChip } from "@/lib/inquiries/sources";
import { LeadDoors } from "./lead-doors";
import { LeadClock } from "./lead-clock";
import { LeadMarks } from "./lead-marks";

/**
 * A LEAD ON THE LEADS LIST (cn-v1170). Erik, 2026-11-19: "if a lead is still on the lead page that IS
 * the reminder", so the row is the lead and its doors, and nothing that schedules a reminder. No
 * expander: the lead's file (/leads/<id>, the name) holds the rest. Four lines: who (with the source,
 * the triage score, when it came in and how long it has waited), how to reach them, the Scope, the
 * doors. Each row is its own card ("Add visual barrier bolder between leads").
 */
export function InquiryRow({
  inquiry,
  tz,
  businessPhone = null,
  nowMs,
  visitsUnread = false,
  pickPending = false,
  wonPending = false,
}: {
  inquiry: Inquiry;
  /** The company's clock: the arrival time is said in it. */
  tz: string;
  /** The org's own line (organizations.phone): the Let Them Pick handoff has to be able to name it. */
  businessPhone?: string | null;
  /** The server's now, so the running clock's first draw matches on the server and the phone. */
  nowMs: number;
  /** Its visits could not be read (lib/leads/new-intake `unread`): it is listed in case, and says so. */
  visitsUnread?: boolean;
  /** Its pick-a-time request ran out unanswered (lib/leads/new-intake `pickPending`): it is back on
   *  the list, and the row says the times were sent. */
  pickPending?: boolean;
  /** A call or visit of it was marked Won and the lead is still open (lib/leads/new-intake `wonPending`). */
  wonPending?: boolean;
}) {
  const lang = useLang();
  const t = translator(lang);
  const source = leadSourceChip((inquiry as { source?: string | null }).source ?? null);

  // Street first, then the town — the two parts he actually reads. Comma-joined and trimmed so a
  // lead carrying only a town still shows the town rather than nothing.
  const addressLine = [inquiry.address, inquiry.city].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");

  return (
    <li id={`lead-${inquiry.id}`} className="flex scroll-mt-24 flex-col gap-1.5 rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">
      {/* ── LINE 1: WHO. The name opens the lead's file; the business, where the lead came from, the
          triage's score; at the right, when it came in and how long it has waited. ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={`/leads/${inquiry.id}`} className="inline-flex min-h-11 items-center font-semibold text-slate-900 hover:text-brand hover:underline">
          {inquiry.name}
        </Link>
        {inquiry.company_name && <span className="text-xs text-slate-500">{inquiry.company_name}</span>}
        <span className="inline-flex items-center gap-1.5">
          {/* WHERE IT CAME FROM (lib/inquiries/sources leadSourceChip, the one reader): a website door
              is the Globe and its words; a picked source is its own label; nothing picked, no chip. */}
          {source?.kind === "web" && (
            <Badge tone="slate" className="gap-1 normal-case">
              <Globe aria-hidden className="h-3 w-3" /> {t("ld_fromYourWebsite")}
            </Badge>
          )}
          {source?.kind === "label" && (
            <Badge tone="slate" className="normal-case">
              {source.text}
            </Badge>
          )}
          {/* THE TRIAGE'S SCORE, SHOWN INSTEAD OF SILENTLY ORDERING (cn-v1137). The website's triage
              scores a web lead by size, readiness and reach (lib/lead-triage); the list is newest
              first, so the score is said here, on the leads that have one. Zero is no chip. */}
          {Number(inquiry.priority) > 0 && (
            <Badge
              tone="slate"
              className="normal-case"
              title={inquiry.intake?.reason ?? t("ld_triageScore")}
            >
              {fillText(t("ld_priority"), { n: String(Number(inquiry.priority)) })}
            </Badge>
          )}
          {/* The triage's bucket and the customer's own site-visit request (cn-v1170: kept). Every
              lead on this list has nothing standing, so a request for a visit is still unmet. */}
          <LeadMarks bucket={inquiry.lead_bucket} needsVisit={!!inquiry.site_inspection_required} lang={lang} t={t} />
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-slate-400" title={fillText(t("ld_added"), { when: formatDateTime(inquiry.created_at, tz, lang) })}>
            {formatDateTime(inquiry.created_at, tz, lang)}
          </span>
          {/* "next to time stamp running clock since lead arrival" (the 11-19 meeting). */}
          <LeadClock since={inquiry.created_at} nowMs={nowMs} />
        </span>
      </div>

      {/* ── LINE 2: HOW TO REACH THEM. Phone and email one tap each; the address opens Maps ("addresses
          addresses and more addresses that is what this business is"); the website's reason. ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        {inquiry.phone && (
          <a href={`tel:${inquiry.phone}`} className="flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline">
            <Phone className="h-3 w-3 shrink-0" /> {inquiry.phone}
          </a>
        )}
        {inquiry.email && (
          <a href={`mailto:${inquiry.email}`} className="flex min-h-11 min-w-0 items-center gap-1 text-xs text-slate-500 hover:text-brand hover:underline">
            <Mail className="h-3 w-3 shrink-0" /> <span className="truncate">{inquiry.email}</span>
          </a>
        )}
        {addressLine && (
          <a
            href={`https://maps.apple.com/?q=${encodeURIComponent(addressLine)}`}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-11 items-center gap-1 text-sm font-medium text-slate-600 hover:text-brand hover:underline"
            title={t("ld_openInMaps")}
          >
            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {addressLine}
          </a>
        )}
        {inquiry.intake?.reason && <span className="hidden text-slate-400 md:inline">{inquiry.intake.reason}</span>}
      </div>

      {/* ── LINE 3: THE SCOPE ("what they need + kind of work = SCOPE"), two lines at most; the
          whole of it is on the lead's file. ── */}
      {inquiry.message && <p className="line-clamp-2 whitespace-pre-line text-sm text-slate-600">{inquiry.message}</p>}

      {/* In doubt a lead is offered, never hidden (lib/leads/new-intake): said, not guessed. */}
      {visitsUnread && <p role="status" className="text-xs text-amber-700">{t("ld_visitsUnread")}</p>}
      {/* The times went out and the first one went by with no pick: the list is the reminder. */}
      {pickPending && <p role="status" className="text-xs text-amber-700">{t("ld_pickPending")}</p>}
      {/* A call or visit of it was marked Won and the lead is still open (cn-v1180, A7): the row says
          where to look, the lead's file, which lists its visits. */}
      {wonPending && <p role="status" className="text-xs text-amber-700">{t("ld_wonPending")}</p>}

      {/* ── LINE 4: THE DOORS (lead-doors.tsx), the same set the lead's file draws. Every lead on this
          list is open: one with a standing visit is not on it. ── */}
      <LeadDoors inquiry={inquiry} stage="open" businessPhone={businessPhone} />
    </li>
  );
}
