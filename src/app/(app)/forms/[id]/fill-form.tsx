"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { submitForm, type FormField } from "../actions";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

export function FillForm({
  formId,
  fields,
  jobs,
}: {
  formId: string;
  fields: FormField[];
  jobs: JobOption[];
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function set(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function onSubmit() {
    setError(null);
    start(async () => {
      const res = await submitForm({
        form_id: formId,
        job_id: jobId || null,
        data: values,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not submit.");
        return;
      }
      setDone(true);
      setValues({});
      router.refresh();
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="ff-job">Attach to job (optional)</Label>
        <Select id="ff-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">— None —</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.job_number} · {j.name}
            </option>
          ))}
        </Select>
      </div>

      {fields.map((f) => (
        <div key={f.key}>
          {f.type === "checkbox" ? (
            <label className="flex items-center gap-2.5 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={Boolean(values[f.key])}
                onChange={(e) => set(f.key, e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
              />
              {f.label}
            </label>
          ) : (
            <>
              <Label htmlFor={f.key}>{f.label}</Label>
              {f.type === "textarea" ? (
                <Textarea
                  id={f.key}
                  rows={3}
                  value={(values[f.key] as string) ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : f.type === "select" ? (
                <Select
                  id={f.key}
                  value={(values[f.key] as string) ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  <option value="">— Select —</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={f.key}
                  type={f.type === "number" ? "number" : "text"}
                  value={(values[f.key] as string) ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </>
          )}
        </div>
      ))}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-3 pt-1">
        <Button onClick={onSubmit} disabled={pending}>
          {pending ? "Submitting…" : "Submit Form"}
        </Button>
        {done && (
          <span className="flex items-center gap-1 text-sm font-medium text-green-600">
            <Check className="h-4 w-4" /> Submitted
          </span>
        )}
      </div>
    </div>
  );
}
