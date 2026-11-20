"use client";

import { useState } from "react";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { PhoneInput } from "@/components/ui/phone-input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { StateSelect } from "@/components/ui/state-select";
import { formatCityStateZip } from "@/lib/utils";
import { MANUAL_SOURCE, isWebSource } from "@/lib/inquiries/sources";
import type { Inquiry } from "@/lib/types";

// The whole form as ONE serializable object, owned by the modal, so useDraft
// can mirror it. What the form sends goes as named inputs; the Business box and the town's three
// boxes, which can be closed, are always sent as hidden inputs, open or not.
export interface InquiryFormValue {
  name: string;
  company_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  /** The town came from a pick in the address box (shown on the grey line); false when it was typed
   *  or there is none. Never sent: it only says where the town is shown. */
  town_picked: boolean;
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
  name: inquiry?.name ?? "",
  company_name: inquiry?.company_name ?? "",
  email: inquiry?.email ?? "",
  phone: inquiry?.phone ?? "",
  address: inquiry?.address ?? "",
  city: inquiry?.city ?? "",
  state: inquiry?.state ?? "",
  zip: inquiry?.zip ?? "",
  // A stored street WITH its town reads like a picked address (the grey line); a town with no street
  // is one somebody typed, and its boxes open.
  town_picked: !!(inquiry?.address?.trim() && inquiry?.city?.trim()),
  message: inquiry?.message ?? "",
  notes: inquiry?.notes ?? "",
  source: !inquiry?.source || inquiry.source === MANUAL_SOURCE ? "" : inquiry.source,
});

/** The town's three boxes open themselves when a TYPED town is there (a picked one is the grey line). */
export function townBoxesFilled(v: InquiryFormValue): boolean {
  return !v.town_picked && [v.city, v.state, v.zip].some((x) => String(x ?? "").trim());
}

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
 *   Business and the town's City / State / ZIP sit behind text links and open themselves when they
 *   hold something; both always post as hidden inputs, open or not.
 *   Address is the street-only picker: the town a pick resolves shows on one grey line under it and
 *   posts hidden; typing over a pick clears it (a town left from another street is the false value
 *   0177 forbids). Residential or commercial is worked out from Business on the server.
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
  const [businessOpen, setBusinessOpen] = useState(() => !!value.company_name.trim());
  const [townOpen, setTownOpen] = useState(() => townBoxesFilled(value));
  const pickedTown = value.town_picked ? formatCityStateZip(value.city, value.state, value.zip) : "";
  const linkClass = "mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline";

  return (
    <div className="space-y-4">
      <div>
        {/* Fragment-first: a bare phone or note is a valid lead — name alone is no longer required
            (the modal checks for ANY of name/phone/message). */}
        <Label htmlFor="name">{t("ld_name")}</Label>
        <Input id="name" name="name" autoComplete="name" value={value.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={t("ld_namePlaceholder")} />
        {!businessOpen && (
          <button type="button" onClick={() => setBusinessOpen(true)} className={linkClass}>
            {t("ld_btn_business")}
          </button>
        )}
      </div>
      {businessOpen && (
        <div>
          <Label htmlFor="company_name">{t("ld_business")}</Label>
          <Input autoComplete="organization" id="company_name" value={value.company_name} onChange={(e) => onChange({ company_name: e.target.value })} />
        </div>
      )}
      <input type="hidden" name="company_name" value={value.company_name} />
      <div>
        <Label htmlFor="address">{t("ld_address")}</Label>
        <AddressAutocomplete
          id="address"
          name="address"
          streetOnly
          defaultValue={value.address}
          // Guard: onTextChange also fires on mount with the unchanged value; patching then would
          // plant a pristine "draft" just from opening. Typing over a PICKED street drops its town.
          onTextChange={(v) => {
            if (v === value.address) return;
            onChange(value.town_picked ? { address: v, city: "", state: "", zip: "", town_picked: false } : { address: v });
          }}
          // The street is patched here too, so the text change that follows a pick is not read as
          // typing over it (which would drop the town the pick just resolved).
          onResolved={(p) => onChange({ address: p.line1, city: p.city ?? "", state: p.state ?? "", zip: p.zip ?? "", town_picked: true })}
        />
        {/* What was stored with the street, on one grey line (the boxes below take over when opened). */}
        {pickedTown && !townOpen && <p className="mt-1 text-xs text-slate-500">{pickedTown}</p>}
        {!townOpen && (
          <button type="button" onClick={() => setTownOpen(true)} className={linkClass}>
            {t("ld_btn_cityStateZip")}
          </button>
        )}
      </div>
      {townOpen && (
        // A box typed in is a typed town: the grey line of a pick goes.
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="city">{t("ld_city")}</Label>
            <Input id="city" value={value.city} onChange={(e) => onChange({ city: e.target.value, town_picked: false })} />
          </div>
          <div>
            <Label htmlFor="state">{t("ld_state")}</Label>
            <StateSelect id="state" value={value.state} onChange={(state) => onChange({ state, town_picked: false })} />
          </div>
          <div>
            <Label htmlFor="zip">{t("ld_zip")}</Label>
            <Input id="zip" value={value.zip} onChange={(e) => onChange({ zip: e.target.value, town_picked: false })} />
          </div>
        </div>
      )}
      <input type="hidden" name="city" value={value.city} />
      <input type="hidden" name="state" value={value.state} />
      <input type="hidden" name="zip" value={value.zip} />
      <div>
        <Label htmlFor="phone">{t("ld_phone")}</Label>
        {/* PhoneInput self-formats (uncontrolled); onInput mirrors the text out. */}
        <PhoneInput
          id="phone"
          name="phone"
          autoComplete="tel"
          defaultValue={value.phone}
          onInput={(e) => onChange({ phone: (e.target as HTMLInputElement).value })}
        />
      </div>
      <div>
        <Label htmlFor="email">{t("ld_email")}</Label>
        <Input id="email" name="email" type="email" autoComplete="email" value={value.email} onChange={(e) => onChange({ email: e.target.value })} />
      </div>
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
