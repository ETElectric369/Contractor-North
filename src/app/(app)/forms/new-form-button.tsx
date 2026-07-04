"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormEditor } from "./form-editor";

export function NewFormButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New Form
      </Button>

      <FormEditor open={open} onClose={() => setOpen(false)} />
    </>
  );
}
