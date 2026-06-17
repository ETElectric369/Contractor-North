"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createForm, type FieldType } from "./actions";

interface FieldRow {
  label: string;
  type: FieldType;
  options: string;
}

const TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Paragraph" },
  { value: "checkbox", label: "Checkbox" },
  { value: "number", label: "Number" },
  { value: "select", label: "Dropdown" },
];

export function NewFormButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<FieldRow[]>([
    { label: "", type: "text", options: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function updateField(i: number, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }

  function onSave() {
    setError(null);
    start(async () => {
      const res = await createForm({ name, description, fields });
      if (!res.ok) {
        setError(res.error ?? "Could not save form.");
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/forms/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New form
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New form"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={onSave}
            saving={pending}
            disabled={!name.trim()}
            saveLabel="Create form"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div>
            <Label htmlFor="form-name">Form name *</Label>
            <Input
              id="form-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Final Inspection"
            />
          </div>
          <div>
            <Label htmlFor="form-desc">Description</Label>
            <Input
              id="form-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0">Fields</Label>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setFields((p) => [...p, { label: "", type: "text", options: "" }])
                }
              >
                <Plus className="h-3.5 w-3.5" /> Add field
              </Button>
            </div>
            <div className="space-y-2">
              {fields.map((f, i) => (
                <div key={i} className="rounded-lg border border-slate-100 p-2">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Field label"
                      value={f.label}
                      onChange={(e) => updateField(i, { label: e.target.value })}
                    />
                    <Select
                      className="w-36"
                      value={f.type}
                      onChange={(e) =>
                        updateField(i, { type: e.target.value as FieldType })
                      }
                    >
                      {TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                    <button
                      onClick={() =>
                        setFields((p) => p.filter((_, idx) => idx !== i))
                      }
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      aria-label="Remove field"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {f.type === "select" && (
                    <Input
                      className="mt-2"
                      placeholder="Options, comma-separated (e.g. Pass, Fail, N/A)"
                      value={f.options}
                      onChange={(e) => updateField(i, { options: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
