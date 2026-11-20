import type { Tone } from "@/components/ui/badge";
import { fillText, type Lang } from "@/lib/i18n";
import { appointmentTypeLabel } from "@/lib/statuses";
import type { LeadStage } from "@/lib/leads/new-intake";
import type { FileVisitRow } from "@/lib/appointments/file-visit";
import { visitWhen } from "./visit-list";

type Words = (key: string) => string;

/** The one word for where a converted lead went. */
export function convertedKey(to: string | null | undefined): string {
  if (to === "customer") return "ld_file_stageCustomer";
  if (to === "quote" || to === "estimate") return "ld_file_stageEstimate";
  if (to === "job") return "ld_file_stageJob";
  return "ld_file_stageConverted";
}

/**
 * A LEAD'S STAGE IN WORDS (cn-v1171): the lead's file draws it as its header badge and the customer's
 * page draws it on each of their Requests, so a lead is called the same thing on both screens.
 * `standingVisit` names the visit that keeps it off the list; a standing lead whose visit is not in
 * hand (its read failed) says Booked, the visit's own word, rather than guess a day.
 */
export function leadStageWords(
  stage: LeadStage,
  p: {
    convertedTo: string | null | undefined;
    standingVisit: Pick<FileVisitRow, "type" | "status" | "starts_at"> | null;
    tz: string;
    lang: Lang;
    t: Words;
  },
): { tone: Tone; text: string } {
  const { t } = p;
  if (stage === "open") return { tone: "amber", text: t("ld_file_stageOpen") };
  if (stage === "notSold") return { tone: "red", text: t("ld_file_stageNotSold") };
  if (stage === "converted") return { tone: "green", text: t(convertedKey(p.convertedTo)) };
  if (!p.standingVisit) return { tone: "blue", text: t("ld_btn_fileVisitBooked") };
  return {
    tone: "blue",
    text: fillText(t("ld_btn_fileStageStanding"), {
      what: appointmentTypeLabel(p.standingVisit.type, p.lang, t),
      when: visitWhen(p.standingVisit, p.tz, p.lang, t),
    }),
  };
}
