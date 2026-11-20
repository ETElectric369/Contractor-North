import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
import type { Lang } from "@/lib/i18n";
import { formatDateTime } from "@/lib/utils";
import { appointmentTypeLabel, visitTitle } from "@/lib/statuses";
import { visitStateKey, type FileVisitRow } from "@/lib/appointments/file-visit";

type Words = (key: string) => string;

/** Each state's tone. Cancelled is plain slate: it is a fact, not a deadline. */
const STATE_TONE: Record<string, Tone> = {
  ld_btn_fileVisitWon: "green",
  ld_btn_fileVisitNotSold: "red",
  ld_btn_fileVisitCancelled: "slate",
  ld_btn_fileVisitDone: "slate",
  ld_btn_fileVisitBooked: "blue",
};

/** When a visit is: its day, or that it waits on the customer's pick, or for a day. A cancelled
 *  visit that never had a day says nothing here (its badge says Cancelled). */
export function visitWhen(v: Pick<FileVisitRow, "status" | "starts_at">, tz: string, lang: Lang, t: Words): string {
  if (v.status === "proposed") return t("ld_btn_fileWaitingOnPick");
  if (!v.starts_at) return v.status === "cancelled" ? "" : t("ld_btn_fileWaitingForADay");
  return formatDateTime(v.starts_at, tz, lang);
}

function Unread({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="text-sm text-amber-700">
      {children}
    </p>
  );
}

/**
 * A PERSON'S INSPECTIONS (cn-v1171): the one list the lead's file and the customer's page both draw.
 * Each row is a door to the visit: its kind, when, its state, and its title under it. `visits` null is
 * a failed read and says `unread`, never `empty`.
 */
export function FileVisitList({
  visits,
  tz,
  lang,
  t,
  empty,
  unread,
}: {
  visits: readonly FileVisitRow[] | null;
  tz: string;
  lang: Lang;
  t: Words;
  /** The words for no visit at all. */
  empty: string;
  /** The words for a read that failed. */
  unread: string;
}) {
  if (visits === null) return <Unread>{unread}</Unread>;
  if (visits.length === 0) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {visits.map((v) => {
        const key = visitStateKey(v);
        const shown = visitTitle(v.title);
        const when = visitWhen(v, tz, lang, t);
        return (
          <li key={v.id}>
            <Link href={`/appointments/${v.id}`} className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-sm hover:text-brand">
              <span className="font-medium text-slate-800">{appointmentTypeLabel(v.type, lang, t)}</span>
              {when && <span className="text-slate-500">{when}</span>}
              <Badge tone={key ? STATE_TONE[key] : "slate"} className="ml-auto normal-case">
                {key ? t(key) : String(v.status ?? "")}
              </Badge>
              {shown && <span className="w-full truncate text-xs text-slate-400">{shown}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
