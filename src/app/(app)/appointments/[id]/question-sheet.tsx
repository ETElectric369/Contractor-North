"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, ClipboardList, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import {
  coerceAnswers,
  parseInspectionSchema,
  unansweredFields,
  type InspectionAnswers,
  type InspectionField,
} from "@/lib/inspection/schema";
import { saveInspectionAnswers } from "../actions";

export type InspectionTemplate = { id: string; name: string; schema: unknown };

/**
 * THE TYPED HALF OF AN INSPECTION.
 *
 * The three prose boxes below this component stay exactly as they were — a sheet only asks what
 * its author thought of, and the sentence nobody anticipated ("the meter base is pulling away from
 * the wall") is often the one that saves the job. What this adds is the part that CAN be a number:
 * once "85" is stored as 85 under `run_ft`, everything downstream of it can be arithmetic instead
 * of a model re-reading the inspector's sentence.
 *
 * The template is per-trade DATA (rows in a form's schema), which is what keeps this from becoming
 * a module per trade — the thing that would stop the whole approach scaling past a few trades.
 */
export function QuestionSheet({
  appointmentId,
  templates,
  initialTemplateId,
  initialAnswers,
}: {
  appointmentId: string;
  templates: InspectionTemplate[];
  initialTemplateId: string | null;
  initialAnswers: InspectionAnswers;
}) {
  // Default to the org's only sheet when there is exactly one — picking from a list of one is a
  // tap the inspector shouldn't have to make while standing on a ladder.
  const [templateId, setTemplateId] = useState<string | null>(
    initialTemplateId ?? (templates.length === 1 ? templates[0].id : null),
  );
  const [answers, setAnswers] = useState<InspectionAnswers>(initialAnswers ?? {});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const fields = useMemo<InspectionField[]>(() => {
    const t = templates.find((x) => x.id === templateId);
    return t ? parseInspectionSchema(t.schema) : [];
  }, [templates, templateId]);

  const missing = useMemo(() => unansweredFields(fields, answers), [fields, answers]);

  if (!templates.length) return null;

  const set = (key: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [key]: value as never }));
    setSaved(false);
  };

  const save = () =>
    start(async () => {
      setError(null);
      // Coerce client-side too, so what's shown as saved matches what the server stored. The
      // server re-coerces against the template it re-reads — this is convenience, not the guard.
      const res = await saveInspectionAnswers(appointmentId, templateId, coerceAnswers(fields, answers));
      if (!res.ok) setError(res.error ?? "Couldn't save.");
      else setSaved(true);
    });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ClipboardList className="h-4 w-4 text-slate-400" />
          Inspection sheet
        </div>
        {templates.length > 1 && (
          <Select
            className="max-w-[16rem]"
            value={templateId ?? ""}
            onChange={(e) => {
              setTemplateId(e.target.value || null);
              setAnswers({});
              setSaved(false);
            }}
          >
            <option value="">Choose a sheet…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {!templateId ? (
        <p className="text-sm text-slate-400">Pick the sheet for this kind of work to capture measurements as numbers.</p>
      ) : fields.length === 0 ? (
        <p className="text-sm text-slate-400">That sheet has no questions yet — add them in Forms.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : undefined}>
                <Label htmlFor={`isp-${f.key}`}>{f.label}</Label>
                {f.type === "number" ? (
                  <NumberInput
                    id={`isp-${f.key}`}
                    value={typeof answers[f.key] === "number" ? (answers[f.key] as number) : ("" as never)}
                    onValueChange={(v) => set(f.key, v)}
                  />
                ) : f.type === "checkbox" ? (
                  <label className="flex h-10 items-center gap-2 text-sm">
                    <input
                      id={`isp-${f.key}`}
                      type="checkbox"
                      className="h-4 w-4"
                      checked={answers[f.key] === true}
                      onChange={(e) => set(f.key, e.target.checked)}
                    />
                    <span className="text-slate-400">{answers[f.key] === true ? "Yes" : "No"}</span>
                  </label>
                ) : f.type === "select" ? (
                  <Select id={`isp-${f.key}`} value={String(answers[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : f.type === "textarea" ? (
                  <Textarea id={`isp-${f.key}`} rows={2} value={String(answers[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
                ) : (
                  <Input id={`isp-${f.key}`} value={String(answers[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} disabled={pending}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : saved ? <Check className="mr-2 h-4 w-4" /> : null}
              {saved ? "Saved" : "Save answers"}
            </Button>
            {/* WHAT'S STILL MISSING, computed from the sheet rather than guessed — the cheapest
                moment to catch a gap is while you're still standing at the panel. */}
            {missing.length > 0 && (
              <p className="text-xs text-amber-400">
                Still open: {missing.slice(0, 4).map((f) => f.label).join(" · ")}
                {missing.length > 4 ? ` +${missing.length - 4} more` : ""}
              </p>
            )}
          </div>
        </>
      )}
      {error && <p className="text-sm text-rose-400">{error}</p>}
    </Card>
  );
}
