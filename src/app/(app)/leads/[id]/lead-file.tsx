import Link from "next/link";
import { Globe, Mail, MapPin, Phone, User } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/back-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { fillText, type Lang } from "@/lib/i18n";
import { formatDate, formatDateTime } from "@/lib/utils";
import { jobStatusLabel } from "@/lib/job-status";
import { leadSourceChip } from "@/lib/inquiries/sources";
import { pickWentUnanswered, visitStands, visitWasWon, type LeadStage } from "@/lib/leads/new-intake";
import { intakePaths } from "@/lib/playbook/uploads";
import { LeadDoors } from "../lead-doors";
import { LeadClock } from "../lead-clock";
import { LeadMarks } from "../lead-marks";
import { IntakeFiles } from "../intake-files";
import { PlanBriefPanel } from "../plan-brief-panel";
import { SaveAsContactButton } from "./file-doors";
import { FileEstimates } from "./file-estimates";
import type { FileEstimate, FileJob, FileLead, FileVisit } from "./file-reads";
// cn-v1171: a visit and a lead's stage are said by the same pieces the customer's page draws.
import { FileVisitList } from "@/components/file/visit-list";
import { leadStageWords } from "@/components/file/lead-stage";
import { fileVisitOrder } from "@/lib/appointments/file-visit";

type Words = (key: string) => string;

export type LeadFileProps = {
  lead: FileLead;
  stage: LeadStage;
  visits: FileVisit[] | null;
  estimates: FileEstimate[] | null;
  jobs: FileJob[] | null;
  customerName: string | null;
  tz: string;
  businessPhone: string | null;
  /** The page's one clock: the stage, the pick line and the running clock read it. */
  nowMs: number;
  lang: Lang;
  t: Words;
  referralsOn: boolean;
  estimatesOn: boolean;
  openSchedule: boolean;
};

function Unread({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="text-sm text-amber-700">
      {children}
    </p>
  );
}

/**
 * THE LEAD'S FILE (cn-v1170): everything about a lead in one place from the moment it arrives, top to
 * bottom on a phone. Who and where it is, when it came in, its doors (the same set the row draws), how
 * to reach them, the Scope and the team's notes, what the website sent, then its inspections,
 * estimates and jobs as doors. Once it has a customer, the file hands over to the customer's page.
 * Nothing here says a follow-up day, a kind of work, or how long ("will be determined in Inspector").
 */
export function LeadFile(p: LeadFileProps) {
  const { lead, stage, t, lang, tz } = p;
  const title = String(lead.name ?? "").trim() || String(lead.company_name ?? "").trim();
  const business = String(lead.name ?? "").trim() ? String(lead.company_name ?? "").trim() : "";
  const source = leadSourceChip(lead.source ?? null);
  const referrer = lead.referrer?.full_name ?? null;
  // Street first, then the town: the row's format (inquiry-row.tsx).
  const addressLine = [lead.address, lead.city].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");
  const standingVisit = (p.visits ?? []).find((v) => visitStands(v, p.nowMs)) ?? null;
  // Times were sent, the first went by with no pick, and nothing else stands: say so by the doors.
  const pickPending = !standingVisit && (p.visits ?? []).some((v) => pickWentUnanswered(v, p.nowMs));
  // A call or visit marked Won that does not stand, nothing else standing (lib/leads/new-intake visitWasWon).
  const wonPending = !standingVisit && (p.visits ?? []).some((v) => visitWasWon(v));
  const stageBadge = leadStageWords(stage, { convertedTo: lead.converted_to, standingVisit, tz, lang, t });

  return (
    <div className="space-y-4">
      {/* BACK WHERE YOU CAME FROM (cn-v1174): the visit page's BackLink. With in-app history behind the
          reader (Inspections, Closing, a customer's page, Needs You) it says Back and retraces it; on a
          cold entry it says Back to Leads and goes to /leads. */}
      <BackLink
        fallback="/leads"
        fallbackLabel={t("ld_btn_fileBackToLeads")}
        backLabel={t("sh_back")}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-brand"
      />

      <div>
        <PageHeader title={title} description={business || undefined} />
        <div className="-mt-3 flex flex-wrap items-center gap-2">
          {/* WHERE IT IS: one badge. */}
          {stage === "standing" && standingVisit ? (
            <Link href={`/appointments/${standingVisit.id}`} className="inline-flex min-h-11 items-center">
              <Badge tone={stageBadge.tone} className="normal-case">
                {stageBadge.text}
              </Badge>
            </Link>
          ) : (
            stage !== "standing" && <Badge tone={stageBadge.tone} className="normal-case">{stageBadge.text}</Badge>
          )}
          <span className="text-xs text-slate-500">{fillText(t("ld_file_arrived"), { when: formatDateTime(lead.created_at, tz, lang) })}</span>
          {/* "next to time stamp running clock since lead arrival": only while it waits on the list. */}
          {stage === "open" && <LeadClock since={lead.created_at} nowMs={p.nowMs} />}
          {/* The triage's bucket, and the customer's own site-visit request while nothing stands. */}
          <LeadMarks bucket={lead.lead_bucket} needsVisit={stage === "open" && !!lead.site_inspection_required} lang={lang} t={t} />
        </div>
      </div>

      {/* Visits unread: the lead is treated as not standing (offered, never hidden), and said so. */}
      {p.visits === null && <Unread>{t("ld_file_visitsUnread")}</Unread>}
      {stage === "open" && pickPending && <Unread>{t("ld_pickPending")}</Unread>}
      {stage === "open" && wonPending && <Unread>{t("ld_wonPending")}</Unread>}

      <LeadDoors inquiry={lead} stage={stage} businessPhone={p.businessPhone} openSchedule={p.openSchedule} />

      <Card>
        <CardHeader>
          <CardTitle>{t("ld_file_contact")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {lead.phone && (
            <a href={`tel:${lead.phone}`} className="flex min-h-11 items-center gap-2 font-medium text-brand hover:underline">
              <Phone className="h-4 w-4 shrink-0" /> {lead.phone}
            </a>
          )}
          {lead.email && (
            <a href={`mailto:${lead.email}`} className="flex min-h-11 min-w-0 items-center gap-2 text-slate-600 hover:text-brand hover:underline">
              <Mail className="h-4 w-4 shrink-0" /> <span className="truncate">{lead.email}</span>
            </a>
          )}
          {addressLine && (
            <a
              href={`https://maps.apple.com/?q=${encodeURIComponent(addressLine)}`}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center gap-2 font-medium text-slate-600 hover:text-brand hover:underline"
              title={t("ld_openInMaps")}
            >
              <MapPin className="h-4 w-4 shrink-0 text-slate-400" /> {addressLine}
            </a>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
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
            {p.referralsOn && referrer && <span className="text-xs text-slate-500">{fillText(t("ld_file_referredBy"), { name: referrer })}</span>}
            {lead.last_contacted_at && (
              <span className="text-xs text-slate-500">{fillText(t("ld_file_lastContacted"), { day: formatDate(lead.last_contacted_at, tz, lang) })}</span>
            )}
          </div>
          {/* THE HAND-OVER: once the lead has a customer, the customer's page is where it carries on. */}
          {lead.customer_id && (
            <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">{t("ld_file_handOver")}</p>
              <Link href={`/crm/${lead.customer_id}`} className="inline-flex min-h-11 items-center gap-1.5 font-medium text-brand hover:underline">
                <User className="h-4 w-4 shrink-0" />{" "}
                {p.customerName ? fillText(t("ld_btn_fileOpenCustomer"), { name: p.customerName }) : t("ld_btn_fileOpenCustomerPlain")}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("ld_scope")}</CardTitle>
        </CardHeader>
        <CardContent>
          {lead.message ? (
            <p className="whitespace-pre-wrap text-sm text-slate-700">{lead.message}</p>
          ) : (
            <p className="text-sm text-slate-400">{t("ld_file_noScope")}</p>
          )}
        </CardContent>
      </Card>

      {lead.notes && (
        <Card>
          <CardHeader>
            <CardTitle>{t("ld_notes")}</CardTitle>
            <p className="text-xs text-slate-500">{t("ld_notesPlaceholder")}</p>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{lead.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* What the website sent: the intake's reason, the customer's files, the plan report. */}
      {lead.intake && (
        <Card>
          <CardHeader>
            <CardTitle>{t("ld_file_fromRequest")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {lead.intake.reason && <p className="text-sm text-slate-600">{lead.intake.reason}</p>}
            <IntakeFiles inquiryId={lead.id} paths={intakePaths(lead.intake)} />
            <PlanBriefPanel inquiryId={lead.id} intake={lead.intake} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("ld_file_inspections")}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Cancelled ones too (cn-v1171): the Inspections page has no Filed side, so the file is where they are found. */}
          <FileVisitList
            visits={p.visits === null ? null : fileVisitOrder(p.visits)}
            tz={tz}
            lang={lang}
            t={t}
            empty={t("ld_file_noInspections")}
            unread={t("ld_file_inspectionsUnread")}
          />
        </CardContent>
      </Card>

      <FileEstimates leadId={lead.id} estimates={p.estimates} stage={stage} estimatesOn={p.estimatesOn} lang={lang} t={t} />

      {(p.jobs === null || p.jobs.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>{t("ld_file_jobs")}</CardTitle>
          </CardHeader>
          <CardContent>
            {p.jobs === null ? (
              <Unread>{t("ld_file_jobsUnread")}</Unread>
            ) : (
              <ul className="divide-y divide-slate-100">
                {p.jobs.map((j) => (
                  <li key={j.id}>
                    <Link href={`/jobs/${j.id}`} className="flex min-h-11 items-center gap-2 py-2 text-sm hover:text-brand">
                      {j.job_number && <span className="font-mono text-xs text-slate-500">{j.job_number}</span>}
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{j.name}</span>
                      <Badge tone={statusTone(String(j.status ?? ""))}>{jobStatusLabel(j.status, lang, t)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* The quiet last area. A contact is made here, by name, on purpose. Delete is inside Edit Details. */}
      {!lead.customer_id && stage !== "notSold" && (
        <div className="flex justify-center border-t border-slate-100 pt-4">
          <SaveAsContactButton inquiryId={lead.id} name={lead.name} />
        </div>
      )}
    </div>
  );
}
