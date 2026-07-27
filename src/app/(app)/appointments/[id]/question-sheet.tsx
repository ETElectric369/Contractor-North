"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Check, ClipboardList, CloudOff, Loader2 } from "lucide-react";
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
import { enqueue, remove as removeQueued, registerReplayer, startAutoDrain } from "@/lib/offline/queue";
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
  userId,
}: {
  appointmentId: string;
  templates: InspectionTemplate[];
  initialTemplateId: string | null;
  initialAnswers: InspectionAnswers;
  /** Who is signed in — a queued save only ever replays for the person who made it. */
  userId: string | null;
}) {
  // Default to the org's only sheet when there is exactly one — picking from a list of one is a
  // tap the inspector shouldn't have to make while standing on a ladder.
  const [templateId, setTemplateId] = useState<string | null>(
    initialTemplateId ?? (templates.length === 1 ? templates[0].id : null),
  );
  const [answers, setAnswers] = useState<InspectionAnswers>(initialAnswers ?? {});
  const [saved, setSaved] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const fields = useMemo<InspectionField[]>(() => {
    const t = templates.find((x) => x.id === templateId);
    return t ? parseInspectionSchema(t.schema) : [];
  }, [templates, templateId]);

  const missing = useMemo(() => unansweredFields(fields, answers), [fields, answers]);

  // Teach the queue how to replay this action, then drain whatever is waiting — on mount, when
  // the connection returns, and when the app comes back to the foreground (a backgrounded phone
  // regains signal without ever firing `online`).
  useEffect(() => {
    registerReplayer("inspection.answers", async (args, clientOpId) => {
      const a = args as { appointmentId: string; templateId: string | null; answers: Record<string, unknown> };
      return saveInspectionAnswers(a.appointmentId, a.templateId, a.answers, clientOpId);
    });
    // `remaining - blocked`: a quarantined op is parked, not pending.
    return startAutoDrain((r) => {
      if (r.remaining - r.blocked === 0) setQueued(false);
    }, userId);
  }, [userId]);

  // NEVER RENDER AS NOTHING. This used to `return null`, which is how the whole per-trade
  // inspection feature was invisible in production: the engine shipped, no org had a sheet, and
  // the component silently vanished — so from the field it looked like nothing had been built.
  // An empty state that says where to go is the difference between "not set up" and "not there".
  if (!templates.length) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ClipboardList className="h-4 w-4 text-slate-400" />
          Inspection sheet
        </div>
        <p className="mt-1 text-sm text-slate-400">
          No question sheet for your trade yet — build one in{" "}
          <Link href="/forms" className="text-brand underline-offset-2 hover:underline">Forms</Link>{" "}
          and tick &ldquo;Use as an inspection sheet&rdquo;. Measurements captured there carry straight into an estimate.
        </p>
      </Card>
    );
  }

  const set = (key: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [key]: value as never }));
    setSaved(false);
  };

  const save = () =>
    start(async () => {
      setError(null);
      // Coerce client-side too, so what's shown as saved matches what the server stored. The
      // server re-coerces against the template it re-reads — this is convenience, not the guard.
      const clean = coerceAnswers(fields, answers);

      /**
       * QUEUE FIRST, THEN SEND (0167). An inspection happens in the exact places signal doesn't
       * reach — a crawlspace, a mechanical room, the back of a property. Writing the intent to
       * IndexedDB BEFORE attempting the network means a failed save is never a lost one: the
       * op carries an idempotency key, runOnce makes the eventual replay exactly-once, and the
       * queue drains itself when the connection returns.
       */
      const op = await enqueue(
        "inspection.answers",
        { appointmentId, templateId, answers: clean },
        "Inspection answers",
        userId,
      );
      try {
        const res = await saveInspectionAnswers(appointmentId, templateId, clean, op.clientOpId);
        if (res.ok) {
          await removeQueued(op.clientOpId);
          setSaved(true);
          setQueued(false);
        } else {
          // A REJECTION is not a connectivity problem — replaying it would just fail again.
          await removeQueued(op.clientOpId);
          setError(res.error ?? "Couldn't save.");
        }
      } catch {
        // Network. Leave it queued and say so plainly rather than showing a failure the user
        // would respond to by retyping everything.
        setQueued(true);
        setSaved(false);
      }
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
            {/* Say it plainly. A tech who thinks a save failed retypes everything; a tech who
                knows it's held will carry on and let it sync. */}
            {queued && (
              <p className="flex items-center gap-1.5 text-xs text-sky-400">
                <CloudOff className="h-3.5 w-3.5" />
                Held on this phone — it&rsquo;ll save itself when you&rsquo;re back in signal.
              </p>
            )}
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
