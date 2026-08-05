"use client";

import { Label, Textarea } from "@/components/ui/input";
import { whyHint, whyNudge, whyProblems } from "@/lib/playbook/why";
import type { Need } from "@/lib/playbook/types";

/**
 * THE ONE PLACE A WHY LINE GETS WRITTEN. Settings and the onboarding walk render this same field,
 * because the moment they drift somebody is being taught two different things about the same box.
 *
 * Erik: "anyone including myself reviewing these proposed why lines is automatically confused as
 * fuck and we need better guidance and feet on the ground architecture around how to set this up
 * for humans."
 *
 * The old label was "Why it matters — in your words" and the placeholder asked what a wrong answer
 * costs. Both invite an essay, and an essay is what he couldn't read fifteen of. This asks the only
 * question that produces a usable line — WHERE DOES THIS END UP IN YOUR PRICE — shows the shape
 * most likely to fit this particular need, and says something the moment the line has no
 * destination in it.
 *
 * The nudge is never a validation error. Nothing is blocked, nothing turns red — a blank why is a
 * legitimate state (it means "ask me every time") and a rough line beats no line. It is a hint that
 * appears when the line looks like one of the three known-useless shapes, and it always points at
 * the destination rather than grading the prose.
 */
export function WhyField({
  need,
  rows = 3,
  onChange,
}: {
  need: Need;
  rows?: number;
  onChange: (why: string | undefined) => void;
}) {
  const { shape } = whyHint(need);
  const problems = whyProblems(need.why, need);
  // Nothing to say about a box he hasn't touched yet — the placeholder already carries the example.
  const nudge = problems.includes("empty") ? null : whyNudge(problems, shape);

  return (
    <div>
      <Label className="mb-1.5">Where does this end up in your price?</Label>
      <Textarea
        rows={rows}
        value={need.why ?? ""}
        placeholder={shape.example}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        {nudge ?? (
          <>
            One line. <span className="text-slate-400">{shape.label}</span> — {shape.hint}
          </>
        )}
      </p>
    </div>
  );
}
