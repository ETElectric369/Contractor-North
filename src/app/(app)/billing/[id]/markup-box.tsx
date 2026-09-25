import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";

/**
 * THE % BOX BESIDE MATERIALS FROM COSTS, AND THE WORDS THAT SAY WHAT IT MEANS (2026-09-25).
 *
 * Stateless: InvoiceDetail holds what is typed and what the lines were last set to
 * (lib/invoice-markup's MarkupBoxState). This only draws them and hands the taps back.
 *
 * APPLY IS A BUTTON NOW, NOT "LEAVING THE BOX". The box used to reprice when it lost focus. On a
 * phone that is not a thing a person can count on: the iPhone's number pad has no return key, and
 * tapping blank page beside a field does not take the focus off it, so Erik typed 15, tapped away,
 * and nothing happened - while on a desk the same tap-away repriced the invoice with no button
 * pressed at all. One door that works the same everywhere: type a number and Apply appears beside
 * it; Enter on a keyboard is the same tap. Leaving the box does nothing, so opening the page and
 * wandering through the box can never reprice anything.
 */
export function MarkupBox({
  value,
  applied,
  canApply,
  pending,
  words,
  onChange,
  onApply,
}: {
  /** What is in the box. */
  value: number;
  /** What the lines were last set to from here (the seed until something is applied). */
  applied: number;
  /** Is there anything to reprice? No materials lines yet: the box is only the figure the
   *  Materials from Costs button will use, and an Apply with nothing to apply would be a dead door. */
  canApply: boolean;
  pending: boolean;
  words: { main: string | null; usual: string | null };
  onChange: (pct: number) => void;
  onApply: () => void;
}) {
  const typed = value !== applied;
  return (
    <>
      <span
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (typed && canApply && !pending) onApply();
        }}
      >
        <NumberInput value={value} onValueChange={onChange} className="h-8 w-14 text-center text-sm" aria-label="Material markup percent" />
      </span>
      <span className="text-xs text-slate-400">% markup</span>
      {typed && canApply && (
        <Button size="sm" onClick={onApply} disabled={pending}>
          Apply
        </Button>
      )}
      {(words.main || words.usual) && (
        <span className="flex flex-col leading-tight">
          {words.main && <span className="text-xs text-slate-600">{words.main}</span>}
          {words.usual && <span className="text-[11px] text-slate-400">{words.usual}</span>}
        </span>
      )}
    </>
  );
}
