"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Textarea } from "@/components/ui/input";
import { createChangeOrder } from "./actions";
import { jobLabel } from "@/lib/schedule-options";
import { CO_OPEN_A_JOB } from "./co-words";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

/**
 * NEW CHANGE ORDER, ON ITS JOB (W2-12). The job's Change Orders tab hands in its one job, and that
 * job is posted with the form: there is no Job box, so no "no job" choice either, and a change order
 * can never save without its job (it would show on no job, and nothing else could open it). Handed
 * anything but exactly one job, it draws a plain line instead of a form that could.
 */
export function NewChangeOrderButton({ jobs }: { jobs: JobOption[] }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  if (jobs.length !== 1) return <p className="text-sm text-slate-500">{CO_OPEN_A_JOB}</p>;
  const job = jobs[0];

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await createChangeOrder(formData);
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
        <Plus className="h-4 w-4" /> New Change Order
      </Button>

      <form action={onSubmit}>
        <input type="hidden" name="job_id" value={job.id} />
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="New change order"
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              submit
              saving={pending}
              saveLabel="Create Change Order"
            />
          }
        >
          <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <p className="text-sm text-slate-500">On {jobLabel(job)}.</p>
          <div>
            <Label htmlFor="description">Description of change *</Label>
            <Textarea
              id="description"
              name="description"
              rows={3}
              required
              placeholder="What's changing from the original scope, in plain words."
            />
          </div>
          <div>
            <Label htmlFor="amount">Amount ($)</Label>
            <Input id="amount" name="amount" type="number" step="any" defaultValue={0} />
          </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
