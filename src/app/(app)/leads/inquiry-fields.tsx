"use client";

import { Input, Label, Select, Textarea } from "@/components/ui/input";
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
      <div>
        <Label htmlFor="type">Type</Label>
        <Select id="type" name="type" value={value.type} onChange={(e) => onChange({ type: e.target.value })}>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
          <option value="industrial">Industrial</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" value={value.email} onChange={(e) => onChange({ email: e.target.value })} />
      </div>
      <div className="col-span-2">
        <Label htmlFor="phone">Phone</Label>
        {/* PhoneInput self-formats (uncontrolled); onInput mirrors the text out. */}
        <PhoneInput
          id="phone"
          name="phone"
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
