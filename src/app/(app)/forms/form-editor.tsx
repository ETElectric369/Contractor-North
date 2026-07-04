"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import {
  createForm,
  updateForm,
  type FieldType,
  type FormField,
} from "./actions";

export interface FieldRow {
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

/** Map a stored schema (FormField[]) back into editable rows. */
export function fieldsToRows(fields: FormField[]): FieldRow[] {
  if (!fields.length) return [{ label: "", type: "text", options: "" }];
  return fields.map((f) => ({
    label: f.label,
    type: f.type,
    options: f.options?.join(", ") ?? "",
  }));
}

interface FormEditorProps {
  open: boolean;
  onClose: () => void;
  /** When provided, the editor updates this form; otherwise it creates a new one. */
  formId?: string;
  initialName?: string;
  initialDescription?: string;
  initialFields?: FieldRow[];
}

/** Shared field-builder modal used for both creating and editing a form. */
export function FormEditor({
  open,
  onClose,
  formId,
  initialName = "",
  initialDescription = "",
  initialFields,
}: FormEditorProps) {
  const isEdit = Boolean(formId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [fields, setFields] = useState<FieldRow[]>(
    initialFields ?? [{ label: "", type: "text", options: "" }],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function updateField(i: number, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }

  function onSave() {
    setError(null);
    start(async () => {
      const res = isEdit
        ? await updateForm(formId!, { name, description, fields })
        : await createForm({ name, description, fields });
      if (!res.ok) {
        setError(res.error ?? "Could not save form.");
        return;
      }
      onClose();
      if (isEdit) {
        router.refresh();
      } else if (res.id) {
        router.push(`/forms/${res.id}`);
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit form" : "New form"}
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={onSave}
          saving={pending}
          disabled={!name.trim()}
          saveLabel={isEdit ? "Save Changes" : "Create Form"}
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
              <Plus className="h-3.5 w-3.5" /> Add Field
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
  );
}
