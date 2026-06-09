"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { InquiryFields } from "./inquiry-fields";
import { createInquiry, updateInquiry } from "./actions";
import type { Inquiry } from "@/lib/types";

/** New-inquiry button, or (mode="edit") an edit trigger for an existing one. */
export function InquiryModal({ inquiry, mode = "new" }: { inquiry?: Inquiry; mode?: "new" | "edit" }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const editing = mode === "edit" && !!inquiry;

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = editing ? await updateInquiry(inquiry!.id, formData) : await createInquiry(formData);
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
      {editing ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      ) : (
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> New inquiry
        </Button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Edit inquiry" : "New inquiry"}>
        <form action={onSubmit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <InquiryFields inquiry={inquiry} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Create inquiry"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
