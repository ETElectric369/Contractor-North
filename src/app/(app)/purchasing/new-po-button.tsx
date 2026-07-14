"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { createPurchaseOrder } from "./actions";
import { jobLabel } from "@/lib/schedule-options";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}
interface ListOption {
  id: string;
  name: string;
}

export function NewPoButton({
  jobs,
  lists,
}: {
  jobs: JobOption[];
  lists: ListOption[];
}) {
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState("CED");
  const [jobId, setJobId] = useState("");
  const [listId, setListId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onCreate() {
    setError(null);
    start(async () => {
      const res = await createPurchaseOrder({
        vendor,
        job_id: jobId || null,
        source_list_id: listId || null,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not create PO.");
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/purchasing/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New PO
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New purchase order"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={onCreate}
            saving={pending}
            saveLabel="Create PO"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="vendor">Vendor</Label>
              <Input id="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="po-job">Job (optional)</Label>
              <Select id="po-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">— None —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {jobLabel(j)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="po-list">Seed from material list (optional)</Label>
            <Select id="po-list" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">— Start empty —</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-slate-400">
              Pulls every item from the chosen take-off straight onto this PO.
            </p>
          </div>
        </div>
      </Modal>
    </>
  );
}
