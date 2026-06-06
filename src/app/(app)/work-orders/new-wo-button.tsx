"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createWorkOrder } from "./actions";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}
interface TechOption {
  id: string;
  full_name: string | null;
}

export function NewWorkOrderButton({
  jobs,
  techs,
  defaultJob,
}: {
  jobs: JobOption[];
  techs: TechOption[];
  defaultJob?: string;
}) {
  const [open, setOpen] = useState(Boolean(defaultJob));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await createWorkOrder(formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/work-orders/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New work order
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="New work order">
        <form action={onSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div>
            <Label htmlFor="title">Title *</Label>
            <Input id="title" name="title" required placeholder="e.g. Install 200A panel" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="job_id">Job</Label>
              <Select id="job_id" name="job_id" defaultValue={defaultJob ?? ""}>
                <option value="">— None —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.job_number} · {j.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="assigned_to">Assign to</Label>
              <Select id="assigned_to" name="assigned_to" defaultValue="">
                <option value="">— Unassigned —</option>
                {techs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name ?? "Unnamed"}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="status">Status</Label>
              <Select id="status" name="status" defaultValue="draft">
                <option value="draft">Draft</option>
                <option value="assigned">Assigned</option>
                <option value="in_progress">In progress</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="scheduled_for">Scheduled for</Label>
              <Input id="scheduled_for" name="scheduled_for" type="datetime-local" />
            </div>
          </div>
          <div>
            <Label htmlFor="description">Scope / description</Label>
            <Textarea id="description" name="description" rows={3} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Create work order"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
