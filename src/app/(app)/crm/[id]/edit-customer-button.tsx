"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { StateSelect } from "@/components/ui/state-select";
import { updateCustomer } from "../actions";
import type { Customer } from "@/lib/types";

export function EditCustomerButton({
  customer,
  pricingLevels = [],
}: {
  customer: Customer;
  pricingLevels?: { id: string; name: string; markup_pct: number }[];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const c = customer;
  const [stateVal, setStateVal] = useState(c.state ?? "");

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await updateCustomer(c.id, formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" /> Edit
      </Button>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Edit customer"
          footer={
            <ModalActions onCancel={() => setOpen(false)} submit saving={pending} saveLabel="Save changes" />
          }
        >
          <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" name="name" required defaultValue={c.name} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="company_name">Company</Label>
              <Input id="company_name" name="company_name" defaultValue={c.company_name ?? ""} />
            </div>
            <div>
              <Label htmlFor="type">Type</Label>
              <Select id="type" name="type" defaultValue={c.type}>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
                <option value="industrial">Industrial</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="status">Status</Label>
              <Select id="status" name="status" defaultValue={c.status}>
                <option value="lead">Inquiry</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </Select>
            </div>
            {pricingLevels.length > 0 && (
              <div className="col-span-2">
                <Label htmlFor="pricing_level_id">Pricing level</Label>
                <Select id="pricing_level_id" name="pricing_level_id" defaultValue={(c as any).pricing_level_id ?? ""}>
                  <option value="">— Default —</option>
                  {pricingLevels.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} ({Number(l.markup_pct)}% markup)</option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" defaultValue={c.email ?? ""} />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <PhoneInput id="phone" name="phone" defaultValue={c.phone ?? ""} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="address">Address</Label>
              <Input id="address" name="address" defaultValue={c.address ?? ""} />
            </div>
            <div>
              <Label htmlFor="city">City</Label>
              <Input id="city" name="city" defaultValue={c.city ?? ""} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="state">State</Label>
                <StateSelect id="state" name="state" value={stateVal} onChange={setStateVal} />
              </div>
              <div>
                <Label htmlFor="zip">Zip</Label>
                <Input id="zip" name="zip" defaultValue={c.zip ?? ""} />
              </div>
            </div>
            <div className="col-span-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" name="notes" rows={2} defaultValue={c.notes ?? ""} />
            </div>
          </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
