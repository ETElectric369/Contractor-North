"use client";

import { Label, Select, Textarea } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { PersonFields, personValue, type PersonValue } from "@/components/person-fields";
import { MANUAL_SOURCE, isWebSource } from "@/lib/inquiries/sources";
import type { Inquiry } from "@/lib/types";

// The whole form as ONE serializable object, owned by the modal, so useDraft
// can mirror it. What the form sends goes as named inputs; the Business box and the town's three
// boxes, which can be closed, are always sent as hidden inputs, open or not (the person block,
// components/person-fields, cn-v1171).
export interface InquiryFormValue extends PersonValue {
  /** The Scope (stored as inquiries.message). */
  message: string;
  notes: string;
  /** Where the lead came from: a label of the company's list, a website door's own value, or "" for
   *  nothing picked ('manual' reads as ""). */
  source: string;
}

/** The keys of the form, so a draft saved by an older form (with fields since removed) restores clean. */
export const INQUIRY_FORM_KEYS = [
  "name", "company_name", "email", "phone", "address", "city", "state", "zip", "town_picked", "message", "notes", "source",
] as const satisfies readonly (keyof InquiryFormValue)[];

export const inquiryFormValue = (inquiry?: Inquiry): InquiryFormValue => ({
  ...personValue(inquiry),
  message: inquiry?.message ?? "",
  notes: inquiry?.notes ?? "",
  source: !inquiry?.source || inquiry.source === MANUAL_SOURCE ? "" : inquiry.source,
});

/**
 * THE LEAD SOURCE SELECT'S OPTIONS, after its blank one (cn-v1170): the company's list, and the lead's
 * own current source as an option of its own when the list does not hold it (a website door, or a label
 * since taken off the list), so saving an edit never changes where a lead came from by accident.
 */
export function leadSourceOptions(
  list: readonly string[],
  current: string,
  fromWebsite: string,
): { value: string; label: string }[] {
  const out = list.map((s) => ({ value: s, label: s }));
  const cur = current.trim();
  if (cur && cur !== MANUAL_SOURCE && !list.includes(cur)) out.unshift({ value: cur, label: isWebSource(cur) ? fromWebsite : cur });
  return out;
}

/**
 * THE ONE LEAD FORM (cn-v1170). Erik, 2026-11-19: "Name / Business / Address / phone / email / Scope /
 * Notes", "what they need + kind of work = SCOPE", "Remove how long (will be determined in Inspector)",
 * and "under Name lets have "Business" as text that can be clicked to open the field to enter a
 * business name to save space". Then Lead Source, the company's own list (Settings).
 *
 *   The person (Name through Email) is the one person block (components/person-fields, cn-v1171),
 *   which the customer form draws too. Residential or commercial is worked out from Business on the
 *   server.
 *
 * Fragment-first is unchanged: a name, a phone or a scope is enough (the modal checks). State lives in
 * the parent (draft-persisted there); phone + address are uncontrolled inside their components, so
 * the parent remounts this block (key) to show a restore, which also re-decides the two links.
 * `sources` is the company's list (null while it is read); `sourcesFailed` says the read failed.
 */
export function InquiryFields({
  value,
  onChange,
  sources = null,
  sourcesFailed = false,
}: {
  value: InquiryFormValue;
  onChange: (patch: Partial<InquiryFormValue>) => void;
  sources?: readonly string[] | null;
  sourcesFailed?: boolean;
}) {
  const lang = useLang();
  const t = translator(lang);

  return (
    <div className="space-y-4">
      {/* Fragment-first: a bare phone or note is a valid lead (the modal checks for ANY of
          name/phone/message). */}
      <PersonFields value={value} onChange={onChange} />
      <div>
        <Label htmlFor="message">{t("ld_scope")}</Label>
        <Textarea id="message" name="message" rows={2} value={value.message} onChange={(e) => onChange({ message: e.target.value })} placeholder={t("ld_scopePlaceholder")} />
      </div>
      <div>
        <Label htmlFor="notes">{t("ld_notes")}</Label>
        <Textarea id="notes" name="notes" rows={2} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} placeholder={t("ld_notesPlaceholder")} />
      </div>
      <div>
        <Label htmlFor="source">{t("ld_leadSource")}</Label>
        <Select id="source" name="source" value={value.source} onChange={(e) => onChange({ source: e.target.value })}>
          <option value=""></option>
          {leadSourceOptions(sources ?? [], value.source, t("ld_fromYourWebsite")).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
        {sourcesFailed && <p className="mt-1 text-xs text-red-700">{t("ld_leadSourcesUnread")}</p>}
      </div>
    </div>
  );
}
