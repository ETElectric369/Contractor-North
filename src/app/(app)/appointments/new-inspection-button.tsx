"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createInspectionNow } from "./actions";

/**
 * THE shared "new walk-through" affordance (Erik: "sometimes we're onsite already — too many
 * steps today"). Mounted on the Walk-Throughs tab header, the lead row's convert menu, and the
 * estimate builder header. Two modes:
 *   • START A WALK-THROUGH — one tap: creates the type='inspection' appointment starting now
 *     (linked to the lead when launched from one) and routes STRAIGHT to /appointments/<id> capture.
 *   • BOOK — opens the EXISTING scheduling flow, never a fork: pass a `schedule` node
 *     (e.g. an <AppointmentButton defaultType="inspection">, whose modal has Set a Time |
 *     Propose Times) or fall back to the schedule page's create door. `nowOnly` hides the
 *     booking half where an existing schedule affordance already sits alongside (lead row).
 * One word for the site visit (W2-10): Walk-Through. "Inspection" is the city's, on a permit.
 */
export function NewInspectionButton({
  label,
  title,
  iconClassName,
  inquiryId,
  nowOnly = false,
  schedule,
  size,
  variant,
}: {
  /** Lead context: links the walk-through to this inquiry (provenance + capture → estimate threading). */
  inquiryId?: string;
  /** Override the button's word. The lead row uses a bare "Walk-Through" so the three verbs read as
   *  one set (Walk-Through · Schedule · Estimate); everywhere else keeps "Start A Walk-Through",
   *  where "Start" is doing real work distinguishing it from booking one. */
  label?: string;
  /** The hover line: what the one tap does, where the bare word leaves it out. */
  title?: string;
  /** The icon's own classes: the lead row drops it on a phone so its three verbs fit one line. */
  iconClassName?: string;
  /** Render only the one-tap "Start A Walk-Through" button (the lead row already has schedule options). */
  nowOnly?: boolean;
  /** Custom schedule-mode affordance (the existing flow); defaults to the schedule page's create door. */
  schedule?: ReactNode;
  size?: "sm";
  variant?: "outline";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspectNow() {
    setBusy(true);
    setError(null);
    const res = await createInspectionNow({ inquiryId: inquiryId ?? null });
    if (!res.ok || !res.id) {
      setError(res.error ?? "Could not start the walk-through.");
      setBusy(false);
      return;
    }
    // Straight to the capture surface — busy stays on until the nav lands.
    router.push(`/appointments/${res.id}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size={size} variant={variant} onClick={inspectNow} disabled={busy} title={title} className="shrink-0 whitespace-nowrap">
        <ClipboardCheck className={iconClassName ?? "h-4 w-4"} /> {busy ? "Starting…" : (label ?? "Start A Walk-Through")}
      </Button>
      {!nowOnly &&
        (schedule ?? (
          // FALLBACK CAVEAT: the schedule page's generic create modal defaults type to
          // "other" — a record that never shows on /inspections unless the user flips
          // the Type select. Prefer passing a `schedule` node with an
          // <AppointmentButton defaultType="inspection"> wherever pickers are available
          // (the /inspections header AND empty state both do now).
          <Link href="/schedule?new=appointment">
            <Button size={size} variant="outline" className="shrink-0 whitespace-nowrap">
              Book A Walk-Through
            </Button>
          </Link>
        ))}
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
