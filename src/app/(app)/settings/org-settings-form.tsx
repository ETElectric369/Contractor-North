"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { Organization } from "@/lib/types";
import { updateOrganization } from "./actions";

export function OrgSettingsForm({ org }: { org: Organization }) {
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
          <Label htmlFor="address_line1">Address</Label>
          <Input id="address_line1" name="address_line1" defaultValue={org.address_line1 ?? ""} />
        </div>
        <div className="col-span-2">
          <Label htmlFor="address_line2">Address line 2</Label>
          <Input id="address_line2" name="address_line2" defaultValue={org.address_line2 ?? ""} />
        </div>
        <div>
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" defaultValue={org.phone ?? ""} />
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
            <span className="text-xs text-slate-400">Used across the app & documents</span>
          </div>
        </div>
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
