"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { renameMaterialList } from "../actions";

/** Rename a material list (so a typo'd list name like "Marerials" isn't stuck). */
export function RenameListButton({ listId, name }: { listId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!value.trim()) return setError("Name is required.");
    setError(null);
    start(async () => {
      const res = await renameMaterialList(listId, value);
      if (!res.ok) return setError(res.error ?? "Could not rename.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={() => { setValue(name); setOpen(true); }}
        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title="Rename list"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Rename list"
        size="sm"
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} disabled={!value.trim()} saveLabel="Save" />}
      >
        <div className="space-y-2">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Label htmlFor="ml-name">List name</Label>
          <Input id="ml-name" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </div>
      </Modal>
    </>
  );
}
