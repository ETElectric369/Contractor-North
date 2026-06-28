"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteForm } from "../actions";

export function DeleteFormButton({ formId }: { formId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    if (!confirm("Archive this form? It will no longer appear in the list.")) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteForm(formId);
      if (!res.ok) {
        setError(res.error ?? "Could not archive form.");
        return;
      }
      router.push("/forms");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        disabled={pending}
        className="text-slate-400 hover:text-red-600"
      >
        <Trash2 className="h-4 w-4" />
        {pending ? "Archiving…" : "Archive"}
      </Button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
