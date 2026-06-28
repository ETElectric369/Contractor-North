"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import type { Organization } from "@/lib/types";
import { getOrgSettings, CURRENCIES, TIMEZONES } from "@/lib/org-settings";
import { updateOrganization } from "./actions";

export function OrgSettingsForm({ org }: { org: Organization }) {
  const s = getOrgSettings((org as any).settings);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    setDone(false);
    start(async () => {
      const res = await updateOrganization(formData);
      if (!res.ok) {
        setError(res.error ?? "Could not save.");
        return;
      }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label htmlFor="name">Company name</Label>
          <Input id="name" name="name" defaultValue={org.name} required />
        </div>
        <div className="col-span-2">
          <Label htmlFor="address_line1">Street address</Label>
          <Input id="address_line1" name="address_line1" defaultValue={org.address_line1 ?? ""} />
        </div>
        <div className="col-span-2">
          <Label htmlFor="address_line2">Suite / Unit (optional)</Label>
          <Input id="address_line2" name="address_line2" defaultValue={org.address_line2 ?? ""} />
        </div>
        <div className="col-span-2 grid grid-cols-6 gap-3">
          <div className="col-span-3">
            <Label htmlFor="city">City</Label>
            <Input id="city" name="city" defaultValue={org.city ?? ""} />
          </div>
          <div className="col-span-1">
            <Label htmlFor="state">State</Label>
            <Input id="state" name="state" maxLength={2} defaultValue={org.state ?? ""} />
          </div>
          <div className="col-span-2">
            <Label htmlFor="zip">Zip</Label>
            <Input id="zip" name="zip" defaultValue={org.zip ?? ""} />
          </div>
        </div>
        <div>
          <Label htmlFor="phone">Phone</Label>
          <PhoneInput id="phone" name="phone" defaultValue={org.phone ?? ""} />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" defaultValue={org.email ?? ""} />
        </div>
        <div>
          <Label htmlFor="license">License # (TECL/EC)</Label>
          <Input id="license" name="license" defaultValue={org.license ?? ""} />
        </div>
        <div>
          <Label htmlFor="default_tax_pct">Default tax rate %</Label>
          <Input
            id="default_tax_pct"
            name="default_tax_pct"
            type="number"
            step="any"
            defaultValue={(org.default_tax_rate * 100).toString()}
          />
        </div>
        <div>
          <Label htmlFor="brand_color">Brand color</Label>
          <div className="flex items-center gap-2">
            <input
              id="brand_color"
              name="brand_color"
              type="color"
              defaultValue={org.brand_color}
              className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 bg-white"
            />
            <span className="text-xs text-slate-400">Used on your documents</span>
          </div>
        </div>
        <div>
          <Label htmlFor="glass_tint">App glass color</Label>
          <div className="flex items-center gap-2">
            <input
              id="glass_tint"
              name="glass_tint"
              type="color"
              defaultValue={s.glass_tint}
              className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 bg-white"
            />
            <span className="text-xs text-slate-400">The dock & menu tint</span>
          </div>
        </div>
        <div>
          <Label htmlFor="tax_number">Tax # / EIN</Label>
          <Input id="tax_number" name="tax_number" defaultValue={s.tax_number} />
        </div>
        <div>
          <Label htmlFor="currency">Currency</Label>
          <Select id="currency" name="currency" defaultValue={s.currency}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="timezone">Time zone</Label>
          <Select id="timezone" name="timezone" defaultValue={s.timezone}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz.replace("_", " ")}</option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="weather_source">My Day weather location</Label>
        <Select id="weather_source" name="weather_source" defaultValue={s.weather_source}>
          <option value="device">My location — each user&apos;s GPS</option>
          <option value="business">Business address</option>
        </Select>
        <p className="mt-1 text-xs text-slate-500">
          &ldquo;My location&rdquo; shows weather where each person actually is; if location is off it
          shows a one-tap &ldquo;turn on location&rdquo; prompt — never the shop&apos;s city in disguise.
          &ldquo;Business address&rdquo; always uses your shop&apos;s location.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {done && (
          <span className="flex items-center gap-1 text-sm font-medium text-green-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
      </div>
    </form>
  );
}
