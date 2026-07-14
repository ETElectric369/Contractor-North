"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { updateMaterialList } from "../actions";
import { jobLabel } from "@/lib/schedule-options";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

/** Edit a material list: rename it AND re-link it to a different job (or
 *  detach it). Fixes the dead-end where a list saved to the wrong job — or
 *  none — could only have its name fixed, never its job. */
export function RenameListButton({
  listId,
  name,
  jobId,
  jobs,
}: {
  listId: string;
  name: string;
  jobId: string | null;
  jobs: JobOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [job, setJob] = useState(jobId ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!value.trim()) return setError("Name is required.");
    setError(null);
    start(async () => {
      const res = await updateMaterialList(listId, {
        name: value,
        job_id: job || null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={() => {
          setValue(name);
          setJob(jobId ?? "");
          setError(null);
          setOpen(true);
        }}
        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title="Edit list"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit list"
        size="sm"
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} disabled={!value.trim()} saveLabel="Save" />}
      >
        <div className="space-y-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div>
            <Label htmlFor="ml-name">List name</Label>
            <Input id="ml-name" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </div>
          <div>
            <Label htmlFor="ml-job">Job</Label>
            <Select id="ml-job" value={job} onChange={(e) => setJob(e.target.value)}>
              <option value="">— None —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {jobLabel(j)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Modal>
    </>
  );
}
