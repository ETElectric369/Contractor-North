"use client";

import { useState } from "react";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import type { Inquiry } from "@/lib/types";

/** Form body shared by the New-inquiry and Edit-inquiry modals. */
export function InquiryFields({ inquiry }: { inquiry?: Inquiry }) {
  const [city, setCity] = useState(inquiry?.city ?? "");
  const [state, setState] = useState(inquiry?.state ?? "");
  const [zip, setZip] = useState(inquiry?.zip ?? "");

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <Label htmlFor="name">Name *</Label>
        <Input id="name" name="name" required defaultValue={inquiry?.name} placeholder="Contact name" />
      </div>
      <div className="col-span-2">
        <Label htmlFor="company_name">Company</Label>
        <Input id="company_name" name="company_name" defaultValue={inquiry?.company_name ?? ""} placeholder="(optional)" />
      </div>
      <div>
        <Label htmlFor="type">Type</Label>
        <Select id="type" name="type" defaultValue={inquiry?.type ?? "residential"}>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
          <option value="industrial">Industrial</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" defaultValue={inquiry?.email ?? ""} />
      </div>
      <div className="col-span-2">
        <Label htmlFor="phone">Phone</Label>
        <PhoneInput id="phone" name="phone" defaultValue={inquiry?.phone ?? ""} />
      </div>
      <div className="col-span-2">
        <Label htmlFor="address">Address</Label>
        <AddressAutocomplete
          id="address"
          name="address"
          streetOnly
          defaultValue={inquiry?.address ?? ""}
          onResolved={(p) => {
            setCity(p.city);
            setState(p.state);
            setZip(p.zip);
          }}
        />
      </div>
      <div>
        <Label htmlFor="city">City</Label>
        <Input id="city" name="city" value={city} onChange={(e) => setCity(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="state">State</Label>
          <Input id="state" name="state" maxLength={2} value={state} onChange={(e) => setState(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="zip">Zip</Label>
          <Input id="zip" name="zip" value={zip} onChange={(e) => setZip(e.target.value)} />
        </div>
      </div>
      <div className="col-span-2">
        <Label htmlFor="message">What they need</Label>
        <Textarea id="message" name="message" rows={2} defaultValue={inquiry?.message ?? ""} placeholder="Job request, scope, how they found you…" />
      </div>
      <div className="col-span-2">
        <Label htmlFor="notes">Internal notes</Label>
        <Textarea id="notes" name="notes" rows={2} defaultValue={inquiry?.notes ?? ""} />
      </div>
    </div>
  );
}
