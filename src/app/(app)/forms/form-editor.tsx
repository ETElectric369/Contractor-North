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
import { slugifyFieldKey } from "@/lib/form-field-key";

export interface FieldRow {
  label: string;
  type: FieldType;
  options: string;
  /** "only show when <showIfKey> is one of <showIfIn>" — the tenant's own branching, as data.
   *  Empty key = always show. Held as strings here because this is a form. */
  showIfKey?: string;
  showIfIn?: string;
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
    showIfKey: (f as { showIf?: { key?: string } }).showIf?.key ?? "",
    showIfIn: ((f as { showIf?: { in?: string[] } }).showIf?.in ?? []).join(", "),
  }));
}

interface FormEditorProps {
  open: boolean;
  onClose: () => void;
  /** When provided, the editor updates this form; otherwise it creates a new one. */
  formId?: string;
  initialName?: string;
  initialDescription?: string;
  initialIsInspection?: boolean;
  initialFields?: FieldRow[];
}

/** Shared field-builder modal used for both creating and editing a form. */
export function FormEditor({
  open,
  onClose,
  formId,
  initialName = "",
  initialDescription = "",
  initialIsInspection = false,
  initialFields,
}: FormEditorProps) {
  const isEdit = Boolean(formId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [isInspection, setIsInspection] = useState(initialIsInspection);
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
        ? await updateForm(formId!, { name, description, is_inspection: isInspection, fields })
        : await createForm({ name, description, is_inspection: isInspection, fields });
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

        {/* THE PER-TRADE SHEET (0165). Marking a form as an inspection sheet makes it selectable
            on an appointment, and its answers land as TYPED values the estimator can use as-is
            rather than re-extracting them from the inspector's prose. Questions are data, so a
            new trade is a form someone types — not a module someone writes. */}
        <label className="flex items-start gap-2 rounded-lg border border-white/10 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={isInspection}
            onChange={(e) => setIsInspection(e.target.checked)}
          />
          <span>
            <span className="font-medium">Use as an inspection sheet</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Adds these questions to the inspection page so measurements are captured as numbers and carry
              straight into an estimate.
            </span>
          </span>
        </label>

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
                {/* ONLY SHOW WHEN — the branching, owned by whoever knows the trade. This is what
                    turns one long sheet into the two or three questions a given job actually has:
                    put the "what kind of work" dropdown first, then point every other field at it.
                    A field can only depend on one ABOVE it, so there is no way to author a loop. */}
                {i > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="shrink-0">Only show when</span>
                    <Select
                      className="w-40"
                      value={f.showIfKey ?? ""}
                      onChange={(e) => updateField(i, { showIfKey: e.target.value })}
                    >
                      <option value="">always show</option>
                      {fields.slice(0, i).filter((p) => p.label.trim()).map((p, pi) => (
                        <option key={pi} value={slugifyFieldKey(p.label)}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                    {f.showIfKey ? (
                      <>
                        <span className="shrink-0">is one of</span>
                        <Input
                          className="min-w-[12rem] flex-1"
                          placeholder="e.g. Service / panel, EV charger"
                          value={f.showIfIn ?? ""}
                          onChange={(e) => updateField(i, { showIfIn: e.target.value })}
                        />
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
