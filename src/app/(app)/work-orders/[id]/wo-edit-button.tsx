"use client";

import { useState, useTransition } from "react";
import { jobLabel } from "@/lib/schedule-options";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { updateWorkOrder } from "../actions";

export function WoEditButton({
  wo,
  jobs,
  techs,
  scheduledLocal,
  menuItem = false,
}: {
  wo: {
    id: string;
    title: string;
    description: string | null;
    job_id: string | null;
    assigned_to: string | null;
    scheduled_for: string | null;
  };
  jobs: { id: string; job_number: string; name: string }[];
  techs: { id: string; full_name: string | null }[];
  /** Scheduled For as the ORG's wall clock ("YYYY-MM-DDTHH:MM"), worked out on the server with the
   *  same timezone the save reads it back in (audit v994 TZ2). The phone's own zone never enters. */
  scheduledLocal: string;
  /** Render the trigger as an Actions-menu row instead of a standalone button. */
  menuItem?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    // An untouched box is not a new time: sent only when it changed, so fixing a typo in the title
    // can never move the visit, whatever the zone the phone is in.
    if (String(formData.get("scheduled_for") ?? "") === scheduledLocal) formData.delete("scheduled_for");
    start(async () => {
      const res = await updateWorkOrder(wo.id, formData);
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
      {menuItem ? (
        <button type="button" onClick={() => setOpen(true)} className={ACTIONS_ROW_CLS}>
          <Pencil className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Edit
        </button>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Pencil className="h-4 w-4" /> Edit
        </Button>
      )}

      {/* The full cn-v463 treatment, because the trigger sits in the glass ⋯ Actions panel whose
          backdrop-filter traps + clips a non-portaled overlay: portal the Modal, and move the
          <form> INSIDE it with an id so the pinned footer (which lives outside the form) still
          submits via the HTML `form=` attribute. Portaling alone would have broken Save — the
          old wrapping <form> submitted by DOM nesting, which createPortal severs. */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit work order"
        portal
        footer={
          <ModalActions onCancel={() => setOpen(false)} submit formId="wo-edit-form" saving={pending} saveLabel="Save Changes" />
        }
      >
        <form id="wo-edit-form" action={onSubmit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div>
            <Label htmlFor="wo-title">Title *</Label>
            <Input id="wo-title" name="title" required defaultValue={wo.title} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="wo-job">Job</Label>
              <Select id="wo-job" name="job_id" defaultValue={wo.job_id ?? ""}>
                <option value="">— None —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>{jobLabel(j)}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="wo-tech">Assigned to</Label>
              <Select id="wo-tech" name="assigned_to" defaultValue={wo.assigned_to ?? ""}>
                <option value="">— Unassigned —</option>
                {techs.map((t) => (
                  <option key={t.id} value={t.id}>{t.full_name ?? "Unnamed"}</option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="wo-sched">Scheduled for</Label>
            <Input id="wo-sched" name="scheduled_for" type="datetime-local" defaultValue={scheduledLocal} />
          </div>
          <div>
            <Label htmlFor="wo-desc">Scope / description</Label>
            <Textarea id="wo-desc" name="description" rows={4} defaultValue={wo.description ?? ""} />
          </div>
        </form>
      </Modal>
    </>
  );
}
