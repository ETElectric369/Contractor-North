"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteFormSubmission } from "../actions";

export function DeleteSubmissionButton({
  submissionId,
  formId,
}: {
  submissionId: string;
  formId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    if (!confirm("Delete this submission? This can't be undone.")) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteFormSubmission(submissionId, formId);
      if (!res.ok) {
        setError(res.error ?? "Could not delete submission.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        disabled={pending}
        aria-label="Delete submission"
        className="-mr-2 h-7 px-1.5 text-slate-300 hover:text-red-600"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
