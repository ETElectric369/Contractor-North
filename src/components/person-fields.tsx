"use client";

import { useRef, useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { PhoneInput } from "@/components/ui/phone-input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { StateSelect } from "@/components/ui/state-select";
import { formatCityStateZip } from "@/lib/utils";

/** The person, as the block holds them: one serializable object owned by the form around it. */
export interface PersonValue {
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
}

type PersonRow = {
  name?: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

/** The block's value from a stored row (a lead or a customer), or empty. */
export const personValue = (row?: PersonRow | null): PersonValue => ({
  name: row?.name ?? "",
  company_name: row?.company_name ?? "",
  email: row?.email ?? "",
  phone: row?.phone ?? "",
  address: row?.address ?? "",
  city: row?.city ?? "",
  state: row?.state ?? "",
  zip: row?.zip ?? "",
  // A stored street WITH its town reads like a picked address (the grey line); a town with no street
  // is one somebody typed, and its boxes open.
  town_picked: !!(row?.address?.trim() && row?.city?.trim()),
});

/** The town's three boxes open themselves when a TYPED town is there (a picked one is the grey line). */
export function townBoxesFilled(v: PersonValue): boolean {
  return !v.town_picked && [v.city, v.state, v.zip].some((x) => String(x ?? "").trim());
}

/**
 * ONE PERSON BLOCK, EVERY FORM THAT TYPES A PERSON IN (cn-v1171). Erik, 2026-11-19: "the lead manual
 * entry form might be one of a few, can we check on the one thing many doors for that one". This is the
 * lead form's block as he drew it the release before, lifted whole: Name; Business; Address with
 * City / State / ZIP behind a link; Phone; Email. The lead form and the customer form (New Customer,
 * Edit Customer) both draw it, so the person is typed one way everywhere.
 *
 *   BUSINESS IS A BOX, ALWAYS (cn-v1185). It was the word "Business" under Name that opened the box
 *   when tapped (his own ask, cn-v1170); two days of use later, Erik: "in the new lead box make
 *   Business a full window instead of clickable to see", and a second company the same day: "Business
 *   button not necessary". So the box is simply there, under Name, in every form that draws a person.
 *
 *   The town opens itself when it holds something; Business and the town always post as hidden
 *   inputs. Address is the street-only picker: the town a pick resolves shows on one grey
 *   line under it and posts hidden; typing over a street picked in this sitting clears its town (a
 *   town left from another street is the false value 0177 forbids), while a stored town stays.
 *
 * State lives in the parent; phone + address are uncontrolled inside their components, so the parent
 * remounts this block (key) to show a restore or a filled-in card, which also re-decides the town's link.
 * It draws its rows with no wrapper, so they sit in the parent's own spacing.
 */
export function PersonFields({
  value,
  onChange,
  namePlaceholder,
  seededTownIsSuggestion = false,
}: {
  value: PersonValue;
  onChange: (patch: Partial<PersonValue>) => void;
  /** The Name box's hint where the lead's would not be true: a lead may be a note alone, a customer
   *  needs a name or a phone (crm/actions createCustomer), so the customer form says its own. */
  namePlaceholder?: string;
  /** The street and town the block starts with were SEEDED from another record, not stored on this
   *  one (cn-v1173: a customer's New Lead, where the new job may be at another property). They are a
   *  suggestion: typing over the seeded street drops the seeded town, exactly as for a pick made in
   *  this sitting; left untouched, it posts whole. Every other form leaves this off. */
  seededTownIsSuggestion?: boolean;
}) {
  const t = translator(useLang());
  const [townOpen, setTownOpen] = useState(() => townBoxesFilled(value));
  // The street a suggestion resolved IN THIS SITTING, or null. Only that pick's town is cleared when
  // the street is typed over (cn-v1171, skeptic #74): a STORED street reads as picked for the grey
  // line, and clearing its town on the first keystroke erased the stored city, state and ZIP on save.
  const pickedHere = useRef<string | null>(seededTownIsSuggestion && value.town_picked ? value.address : null);
  const pickedTown = value.town_picked ? formatCityStateZip(value.city, value.state, value.zip) : "";
  const linkClass = "mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline";

  return (
    <>
      <div>
        {/* Fragment-first: a bare phone or note is a valid lead or customer — the form around it says
            what is enough (a name alone is no longer required). */}
        <Label htmlFor="name">{t("ld_name")}</Label>
        <Input id="name" name="name" autoComplete="name" value={value.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={namePlaceholder ?? t("ld_namePlaceholder")} />
      </div>
      <div>
        <Label htmlFor="company_name">{t("ld_business")}</Label>
        <Input autoComplete="organization" id="company_name" value={value.company_name} onChange={(e) => onChange({ company_name: e.target.value })} />
      </div>
      <input type="hidden" name="company_name" value={value.company_name} />
      <div>
        <Label htmlFor="address">{t("ld_address")}</Label>
        <AddressAutocomplete
          id="address"
          name="address"
          streetOnly
          defaultValue={value.address}
          // Guard: onTextChange also fires on mount with the unchanged value; patching then would
          // plant a pristine "draft" just from opening. Typing over a street PICKED here drops its
          // town; a stored town stays.
          onTextChange={(v) => {
            if (v === value.address || v === pickedHere.current) return;
            if (pickedHere.current !== null) {
              pickedHere.current = null;
              onChange({ address: v, city: "", state: "", zip: "", town_picked: false });
            } else onChange({ address: v });
          }}
          // The street is patched here too, and remembered, so the text change that follows a pick is
          // not read as typing over it (which would drop the town the pick just resolved).
          onResolved={(p) => {
            pickedHere.current = p.line1;
            onChange({ address: p.line1, city: p.city ?? "", state: p.state ?? "", zip: p.zip ?? "", town_picked: true });
          }}
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
    </>
  );
}
