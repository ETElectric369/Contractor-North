"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { updateCustomer } from "../actions";
import type { Customer } from "@/lib/types";

export function EditCustomerButton({ customer }: { customer: Customer }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const c = customer;

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

      <Modal open={open} onClose={() => setOpen(false)} title="Edit customer">
        <form action={onSubmit} className="space-y-4">
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
                <Input id="state" name="state" maxLength={2} defaultValue={c.state ?? ""} />
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
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
