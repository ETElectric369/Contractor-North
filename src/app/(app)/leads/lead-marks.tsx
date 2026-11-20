import { Badge } from "@/components/ui/badge";
import { leadBucketWords, type LeadBucket } from "@/lib/lead-triage";
import type { Lang } from "@/lib/i18n";

type Words = (key: string) => string;

// The bucket's colored dot (the triage's dot language: green ready · amber measure · blue consult).
const BUCKET_DOT: Record<LeadBucket, string> = { A: "bg-emerald-500", B: "bg-amber-500", C: "bg-sky-500" };

function bucketOf(raw: unknown): LeadBucket | null {
  const b = String(raw ?? "").trim().toUpperCase();
  return b === "A" || b === "B" || b === "C" ? b : null;
}

/**
 * TWO MARKS THE ROW CARRIED BEFORE cn-v1170, KEPT (nobody decided to drop them): the triage's bucket
 * (its letter, dot and words, the blurb on hover) and the customer's own "I want a site visit"
 * request. `needsVisit` is the caller's: only while nothing from the lead stands. Drawn on the row and
 * on the lead's file.
 */
export function LeadMarks({
  bucket,
  needsVisit,
  lang,
  t,
}: {
  bucket: unknown;
  needsVisit: boolean;
  lang: Lang;
  t: Words;
}) {
  const letter = bucketOf(bucket);
  const words = letter ? leadBucketWords(letter, lang, t) : null;
  if (!letter && !needsVisit) return null;
  return (
    <>
      {letter && words && (
        <Badge tone="slate" className="gap-1.5 normal-case" title={words.blurb}>
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${BUCKET_DOT[letter]}`} />
          {letter} · {words.label}
        </Badge>
      )}
      {needsVisit && (
        <Badge tone="amber" className="normal-case">
          {t("ld_needsVisit")}
        </Badge>
      )}
    </>
  );
}
