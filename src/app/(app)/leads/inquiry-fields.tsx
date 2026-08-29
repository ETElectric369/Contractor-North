"use client";

import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { KIND_LABEL, WORK_KINDS } from "@/lib/schedule/work-shape";
import { PhoneInput } from "@/components/ui/phone-input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { StateSelect } from "@/components/ui/state-select";
import type { Inquiry } from "@/lib/types";

// The whole form as ONE serializable object, owned by the modal, so useDraft
// can mirror it. Fields keep their `name` attributes — controlled values still
// serialize into the <form>'s FormData.
export interface InquiryFormValue {
  name: string;
  company_name: string;
  type: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  message: string;
  notes: string;
  /** The app-wide WorkKind (lib/schedule/work-shape) — "" means not sure yet, which is a real
   *  answer and the default. NOT `type`, which means residential/commercial. */
  work_kind: string;
  /** Expected minutes as a string (it comes off a <Select>); "" means unsized. */
  planned_minutes: string;
}

export const inquiryFormValue = (inquiry?: Inquiry): InquiryFormValue => ({
  name: inquiry?.name ?? "",
  company_name: inquiry?.company_name ?? "",
  type: inquiry?.type ?? "residential",
  email: inquiry?.email ?? "",
  phone: inquiry?.phone ?? "",
  address: inquiry?.address ?? "",
  city: inquiry?.city ?? "",
  state: inquiry?.state ?? "",
  zip: inquiry?.zip ?? "",
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

/** Form body shared by the New-inquiry and Edit-inquiry modals. State lives in
 *  the parent (draft-persisted there); phone + address are uncontrolled inside
 *  their components, so the parent remounts this block (key) to show a restore. */
export function InquiryFields({
  value,
  onChange,
}: {
  value: InquiryFormValue;
  onChange: (patch: Partial<InquiryFormValue>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        {/* Fragment-first: a bare phone or note is a valid lead — name alone is
            no longer required (the modal checks for ANY of name/phone/message). */}
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" value={value.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Contact name (phone or note alone works)" />
      </div>
      <div className="col-span-2">
        <Label htmlFor="company_name">Company</Label>
        <Input id="company_name" name="company_name" value={value.company_name} onChange={(e) => onChange({ company_name: e.target.value })} placeholder="(optional)" />
      </div>
      {/* WHAT IT IS and HOW LONG — side by side, because they are one thought. Durations are a
          dropdown of the shapes a contractor actually books rather than a free number: "Half day"
          is one tap at 60mph and typing 240 is not. "Not sure yet" is a real option and the
          default — an honest blank beats a made-up number that later reads as a decision. */}
      <div>
        <Label htmlFor="work_kind">What kind of work</Label>
        <Select id="work_kind" name="work_kind" value={value.work_kind} onChange={(e) => onChange({ work_kind: e.target.value })}>
          {/* BUILT FROM THE ONE LIST, never hand-listed. An option that exists is an option the
              validator accepts — the hand-written copies are how "Phone call" came to be offered
              and then refused. */}
          <option value="">Not sure yet</option>
          {WORK_KINDS.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="planned_minutes">How long will it take</Label>
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
      <div>
        <Label htmlFor="type">Residential or commercial</Label>
        <Select id="type" name="type" value={value.type} onChange={(e) => onChange({ type: e.target.value })}>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
          <option value="industrial">Industrial</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" value={value.email} onChange={(e) => onChange({ email: e.target.value })} />
      </div>
      <div className="col-span-2">
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
      <div className="col-span-2">
        <Label htmlFor="address">Address</Label>
        <AddressAutocomplete
          id="address"
          name="address"
          streetOnly
          defaultValue={value.address}
          // Guard: onTextChange also fires on mount with the unchanged value;
          // patching then would plant a pristine "draft" just from opening.
          onTextChange={(v) => v !== value.address && onChange({ address: v })}
          onResolved={(p) => onChange({ city: p.city, state: p.state, zip: p.zip })}
        />
      </div>
      <div>
        <Label htmlFor="city">City</Label>
        <Input id="city" name="city" value={value.city} onChange={(e) => onChange({ city: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="state">State</Label>
          <StateSelect id="state" name="state" value={value.state} onChange={(state) => onChange({ state })} />
        </div>
        <div>
          <Label htmlFor="zip">Zip</Label>
          <Input id="zip" name="zip" value={value.zip} onChange={(e) => onChange({ zip: e.target.value })} />
        </div>
      </div>
      <div className="col-span-2">
        <Label htmlFor="message">What they need</Label>
        <Textarea id="message" name="message" rows={2} value={value.message} onChange={(e) => onChange({ message: e.target.value })} placeholder="Job request, scope, how they found you…" />
      </div>
      <div className="col-span-2">
        <Label htmlFor="notes">Internal notes</Label>
        <Textarea id="notes" name="notes" rows={2} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </div>
    </div>
  );
}
