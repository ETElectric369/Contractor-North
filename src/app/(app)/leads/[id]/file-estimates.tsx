import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import type { Lang } from "@/lib/i18n";
import { estimateStatusLabel } from "@/lib/statuses";
import type { LeadStage } from "@/lib/leads/new-intake";
import { StartEstimateButton } from "./file-doors";
import type { FileEstimate } from "./file-reads";

type Words = (key: string) => string;

/** The doors to the estimates, and Start an Estimate where the Estimates switch is on and the lead
 *  is still in play (open, or with its visit on the books). Never a total. */
export function FileEstimates({
  leadId,
  estimates,
  stage,
  estimatesOn,
  lang,
  t,
}: {
  leadId: string;
  estimates: FileEstimate[] | null;
  stage: LeadStage;
  estimatesOn: boolean;
  lang: Lang;
  t: Words;
}) {
  const canStart = estimatesOn && (stage === "open" || stage === "standing");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("ld_file_estimates")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {estimates === null ? (
          <p role="status" className="text-sm text-amber-700">
            {t("ld_file_estimatesUnread")}
          </p>
        ) : estimates.length === 0 ? (
          <p className="text-sm text-slate-400">{t("ld_file_noEstimates")}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {estimates.map((q) => (
              <li key={q.id}>
                <Link href={`/quotes/${q.id}`} className="flex min-h-11 items-center gap-2 py-2 text-sm hover:text-brand">
                  {q.quote_number && <span className="font-mono text-xs text-slate-500">{q.quote_number}</span>}
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{q.title}</span>
                  <Badge tone={statusTone(q.status)}>{estimateStatusLabel(q.status, lang, t)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {canStart && <StartEstimateButton inquiryId={leadId} />}
      </CardContent>
    </Card>
  );
}
