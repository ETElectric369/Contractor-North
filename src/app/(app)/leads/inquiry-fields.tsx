"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { KIND_LABEL, kindOptions } from "@/lib/schedule/work-shape";
import { PhoneInput } from "@/components/ui/phone-input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { StateSelect } from "@/components/ui/state-select";
import { formatCityStateZip } from "@/lib/utils";
import type { Inquiry } from "@/lib/types";

// The whole form as ONE serializable object, owned by the modal, so useDraft
// can mirror it. What the form sends goes as named inputs; the ones inside More Options are
// always sent as hidden inputs, open or not.
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
   *  (it lives in More Options) or there is none. Never sent: it only says where the town is shown. */
  town_picked: boolean;
  message: string;
  notes: string;
  /** The app-wide WorkKind (lib/schedule/work-shape) — "" means not sure yet, which is a real
   *  answer and the default. (Residential or commercial is worked out from Company: leads/actions.) */
  work_kind: string;
  /** Expected minutes as a string (it comes off a <Select>); "" means unsized. */
  planned_minutes: string;
}

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
  // is one somebody typed, and stays editable in More Options.
  town_picked: !!(inquiry?.address?.trim() && inquiry?.city?.trim()),
  message: inquiry?.message ?? "",
  notes: inquiry?.notes ?? "",
  // WHAT KIND, AND HOW LONG — asked where the answer already is. Erik: "i should be able to mark
  // the lead when it shows up … and enter the estimated time its going to take". Whoever takes the
  // call already knows it is a two-hour service call; asking later, on a calendar, asks somebody
  // to remember what they were told.
  work_kind: (inquiry as { work_kind?: string | null } | undefined)?.work_kind ?? "",
  planned_minutes:
    (inquiry as { planned_minutes?: number | null } | undefined)?.planned_minutes != null
      ? String((inquiry as { planned_minutes?: number | null }).planned_minutes)
      : "",
});

/** True when anything inside More Options holds a value: it then opens itself (a restored draft, an
 *  edited lead), so nothing filled in is ever hidden behind a closed row. */
export function moreOptionsFilled(v: InquiryFormValue): boolean {
  const typedTown = !v.town_picked && [v.city, v.state, v.zip].some((x) => String(x ?? "").trim());
  return [v.company_name, v.email, v.notes].some((x) => String(x ?? "").trim()) || typedTown;
}

/** The closed row's summary: what's filled in, else what's inside. */
export function moreOptionsSummary(v: InquiryFormValue): string {
  const typedTown = v.town_picked ? "" : formatCityStateZip(v.city, v.state, v.zip);
  const filled = [v.company_name, v.email, typedTown, v.notes.trim() ? "Notes" : ""].map((x) => String(x ?? "").trim()).filter(Boolean);
  return filled.length ? filled.join(" · ") : "Company · Email";
}

/**
 * NEW LEAD IN SEVEN (W2-07): Name, Phone, Address, What They Need, What Kind Of Work and How Long
 * side by side, and one closed More Options row — the pattern Wave 1's New Job set. It was thirteen
 * fields, one of them "Residential or commercial", which the Company box already answers (the server
 * works it out: leads/actions inferredLeadType).
 *
 *   Address is the street-only picker: the city, state and zip a pick resolves show on one grey line
 *   under it and go as hidden inputs; typing over a pick clears them (a town left from another street
 *   is the false value 0177 forbids). A street typed and not picked gets "Add The Town", which opens
 *   More Options, where its City, State and Zip are.
 *   More Options holds Company, Email and Internal Notes (and that town), and opens itself when a
 *   restored draft or an edited lead has anything inside it.
 *
 * Fragment-first is unchanged: a name, a phone or a note is enough (the modal checks). State lives in
 * the parent (draft-persisted there); phone + address are uncontrolled inside their components, so
 * the parent remounts this block (key) to show a restore — which also re-decides More Options.
 */
export function InquiryFields({
  value,
  onChange,
}: {
  value: InquiryFormValue;
  onChange: (patch: Partial<InquiryFormValue>) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(() => moreOptionsFilled(value));
  const pickedTown = value.town_picked ? formatCityStateZip(value.city, value.state, value.zip) : "";
  const needsTown = !value.town_picked && !!value.address.trim() && !value.city.trim();

  return (
    <div className="space-y-4">
      <div>
        {/* Fragment-first: a bare phone or note is a valid lead — name alone is no longer required
            (the modal checks for ANY of name/phone/message). */}
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" value={value.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Contact name (phone or note alone works)" />
      </div>
      <div>
        <Label htmlFor="phone">Phone</Label>
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
        <Label htmlFor="address">Address</Label>
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
        {/* What was stored with the street, on one grey line. */}
        {pickedTown && <p className="mt-1 text-xs text-slate-500">{pickedTown}</p>}
        {needsTown && (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
          >
            Add The Town
          </button>
        )}
      </div>
      <div>
        <Label htmlFor="message">What They Need</Label>
        <Textarea id="message" name="message" rows={2} value={value.message} onChange={(e) => onChange({ message: e.target.value })} placeholder="The work, the scope, how they found you…" />
      </div>
      {/* WHAT IT IS and HOW LONG — side by side, because they are one thought. Durations are a
          dropdown of the shapes a contractor actually books rather than a free number: "Half day"
          is one tap at 60mph and typing 240 is not. "Not sure yet" is a real option and the
          default — an honest blank beats a made-up number that later reads as a decision. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="work_kind">What Kind Of Work</Label>
          <Select id="work_kind" name="work_kind" value={value.work_kind} onChange={(e) => onChange({ work_kind: e.target.value })}>
            <option value="">Not sure yet</option>
            {/* The five a person picks (W2-06), plus this lead's own old kind (Quote, Office) when it
                carries one, so an edit never silently re-tags it. */}
            {kindOptions(value.work_kind).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="planned_minutes">How Long</Label>
          <Select id="planned_minutes" name="planned_minutes" value={value.planned_minutes} onChange={(e) => onChange({ planned_minutes: e.target.value })}>
            <option value="">Not sure yet</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="240">Half day (4h)</option>
            <option value="480">Full day</option>
            <option value="960">2 days</option>
            <option value="1440">3 days</option>
            <option value="2400">A week (5 days)</option>
          </Select>
        </div>
      </div>

      {/* MORE OPTIONS, closed: Company, Email, Internal Notes, and the town of a street that was typed.
          Their values are always sent (hidden inputs below), open or not. */}
      <div className="rounded-lg border border-slate-200">
        <button
          type="button"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm font-medium text-slate-700"
        >
          <span>More Options</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-slate-500">
            <span className="truncate">{moreOptionsSummary(value)}</span>
            <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
          </span>
        </button>
        {moreOpen && (
          <div className="space-y-3 border-t border-slate-100 px-3 pb-3 pt-2">
            <div>
              <Label htmlFor="company_name">Company</Label>
              <Input id="company_name" value={value.company_name} onChange={(e) => onChange({ company_name: e.target.value })} placeholder="(optional)" />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" value={value.email} onChange={(e) => onChange({ email: e.target.value })} />
            </div>
            {!value.town_picked && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="city">City</Label>
                  <Input id="city" value={value.city} onChange={(e) => onChange({ city: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="state">State</Label>
                  <StateSelect id="state" value={value.state} onChange={(state) => onChange({ state })} />
                </div>
                <div>
                  <Label htmlFor="zip">Zip</Label>
                  <Input id="zip" value={value.zip} onChange={(e) => onChange({ zip: e.target.value })} />
                </div>
              </div>
            )}
            <div>
              <Label htmlFor="notes">Internal Notes</Label>
              <Textarea id="notes" rows={2} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} />
            </div>
          </div>
        )}
        <input type="hidden" name="company_name" value={value.company_name} />
        <input type="hidden" name="email" value={value.email} />
        <input type="hidden" name="city" value={value.city} />
        <input type="hidden" name="state" value={value.state} />
        <input type="hidden" name="zip" value={value.zip} />
        <input type="hidden" name="notes" value={value.notes} />
      </div>
    </div>
  );
}
