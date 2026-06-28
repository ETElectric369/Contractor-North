"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormEditor, fieldsToRows } from "../form-editor";
import type { FormField } from "../actions";

export function EditFormButton({
  formId,
  name,
  description,
  fields,
}: {
  formId: string;
  name: string;
  description: string | null;
  fields: FormField[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-slate-400 hover:text-brand"
      >
        <Pencil className="h-4 w-4" /> Edit
      </Button>

      <FormEditor
        open={open}
        onClose={() => setOpen(false)}
        formId={formId}
        initialName={name}
        initialDescription={description ?? ""}
        initialFields={fieldsToRows(fields)}
      />
    </>
  );
}
