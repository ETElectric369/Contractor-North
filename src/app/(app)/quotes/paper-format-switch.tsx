"use client";

import { SegmentedControl } from "@/components/ui/segmented";
import { Label } from "@/components/ui/input";
import type { EstimateFormat } from "@/lib/doc-style";

/**
 * LABOR AND PARTS ON THE PAPER (cn-v1131). Erik: "time and material line items for each task
 * optionally visible on the estimate itself". The company's Doc Studio choice is the default; one
 * estimate may say otherwise for itself (quotes.estimate_format, 0395: null = the company's).
 *
 * Three segments: the company default (named with what it currently means, so "Company Default"
 * never reads as a mystery), Show, Hide. PRESENTATIONAL ONLY — the builder (quotes/new) and the
 * saved page each own the value and the save; this draws the control and reports the pick. The
 * words are the same on both doors, so the paper reads the same whichever one he set it from.
 */
const SEGMENT = { default: null, show: "detailed", hide: "tasks" } as const;
type SegmentId = keyof typeof SEGMENT;

const segmentFor = (value: EstimateFormat | null): SegmentId => (value === "detailed" ? "show" : value === "tasks" ? "hide" : "default");

export function PaperFormatSwitch({
  value,
  companyDefault,
  onChange,
  disabled,
}: {
  /** The estimate's own choice; null = the company default. */
  value: EstimateFormat | null;
  /** What the company default currently means (Doc Studio's Estimate Lines). */
  companyDefault: EstimateFormat;
  onChange: (v: EstimateFormat | null) => void;
  /** While a save is in flight: the pill stays where it is and a tap does nothing. */
  disabled?: boolean;
}) {
  return (
    <div>
      <Label>Labor And Parts On The Paper</Label>
      <div className={disabled ? "pointer-events-none opacity-60" : undefined} aria-disabled={disabled || undefined}>
        <SegmentedControl
          activeId={segmentFor(value)}
          onSelect={(id) => {
            if (disabled || !(id in SEGMENT)) return;
            onChange(SEGMENT[id as SegmentId]);
          }}
          items={[
            { id: "default", label: companyDefault === "detailed" ? "Company Default · On" : "Company Default · Off" },
            { id: "show", label: "Show" },
            { id: "hide", label: "Hide" },
          ]}
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Prints each task&apos;s hours at the rate and its parts beneath it, on the paper and the customer&apos;s link. The company default is set in Document Studio.
      </p>
    </div>
  );
}
