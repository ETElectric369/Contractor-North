"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createJob } from "./actions";

interface CustomerOption {
  id: string;
  name: string;
}

export function NewJobButton({ customers }: { customers: CustomerOption[] }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await createJob(formData);
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
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New job
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="New job">
        <form action={onSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div>
            <Label htmlFor="name">Job name *</Label>
            <Input id="name" name="name" required placeholder="e.g. Smith panel upgrade" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="customer_id">Customer</Label>
              <Select id="customer_id" name="customer_id" defaultValue="">
                <option value="">— None —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="status">Status</Label>
              <Select id="status" name="status" defaultValue="estimate">
                <option value="estimate">Estimate</option>
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In progress</option>
                <option value="on_hold">On hold</option>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="address">Site address</Label>
            <Input id="address" name="address" />
          </div>
          <div>
            <Label htmlFor="scheduled_start">Scheduled start</Label>
            <Input id="scheduled_start" name="scheduled_start" type="datetime-local" />
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" rows={2} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Create job"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
