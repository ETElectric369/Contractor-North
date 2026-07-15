"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createInspectionNow } from "./actions";

/**
 * THE shared "New inspection" affordance (Erik: "sometimes we're onsite already — too many
 * steps today"). Mounted on the Inspections tab header, the lead row's convert menu, and the
 * estimate builder header. Two modes:
 *   • INSPECT NOW — one tap: creates the type='inspection' appointment starting now (linked
 *     to the lead when launched from one) and routes STRAIGHT to /appointments/<id> capture.
 *   • SCHEDULE — opens the EXISTING scheduling flow, never a fork: pass a `schedule` node
 *     (e.g. an <AppointmentButton defaultType="inspection">, whose modal has Set a Time |
 *     Propose Times) or fall back to the schedule page's create door. `nowOnly` hides the
 *     schedule half where an existing schedule affordance already sits alongside (lead row).
 */
export function NewInspectionButton({
  inquiryId,
  nowOnly = false,
  schedule,
  size,
  variant,
}: {
  /** Lead context: links the inspection to this inquiry (provenance + capture → estimate threading). */
  inquiryId?: string;
  /** Render only the one-tap "Inspect now" button (the lead row already has schedule options). */
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
      setError(res.error ?? "Could not start the inspection.");
      setBusy(false);
      return;
    }
    // Straight to the capture surface — busy stays on until the nav lands.
    router.push(`/appointments/${res.id}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size={size} variant={variant} onClick={inspectNow} disabled={busy} className="shrink-0 whitespace-nowrap">
        <ClipboardCheck className="h-4 w-4" /> {busy ? "Starting…" : "Inspect now"}
      </Button>
      {!nowOnly &&
        (schedule ?? (
          <Link href="/schedule?new=appointment">
            <Button size={size} variant="outline" className="shrink-0 whitespace-nowrap">
              Schedule inspection
            </Button>
          </Link>
        ))}
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
