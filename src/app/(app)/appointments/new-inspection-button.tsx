"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createInspectionNow } from "./actions";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

/**
 * THE shared "new inspection" affordance (Erik: "sometimes we're onsite already — too many
 * steps today"). Mounted on the estimate builder's header (the Inspections page's header and the lead
 * row no longer draw it: cn-v1171 removed the header's buttons, and a lead's Schedule sheet has its
 * own Start Now). Two modes:
 *   • START AN INSPECTION — one tap: creates the type='inspection' appointment starting now
 *     (linked to the lead when launched from one) and routes STRAIGHT to /appointments/<id> capture.
 *   • BOOK — the schedule page's create door.
 * One word for the site visit, and it is the stored one: Inspection (src/lib/statuses.ts says so).
 * The CITY'S is the separate type final_inspection, "Final Inspection", on the job's permit.
 */
export function NewInspectionButton({
  inquiryId,
  size,
  variant,
}: {
  /** Lead context: links the inspection to this inquiry (provenance + capture → estimate threading). */
  inquiryId?: string;
  size?: "sm";
  variant?: "outline";
}) {
  const router = useRouter();
  const t = translator(useLang());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspectNow() {
    setBusy(true);
    setError(null);
    const res = await createInspectionNow({ inquiryId: inquiryId ?? null });
    if (!res.ok || !res.id) {
      setError(res.error ?? t("qt_couldNotStartInspection"));
      setBusy(false);
      return;
    }
    // Straight to the capture surface — busy stays on until the nav lands.
    router.push(`/appointments/${res.id}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size={size} variant={variant} onClick={inspectNow} disabled={busy} className="shrink-0 whitespace-nowrap">
        <ClipboardCheck className="h-4 w-4" /> {busy ? t("qt_btn_starting") : t("qt_btn_startAnInspection")}
      </Button>
      {/* CAVEAT, as before: the schedule page's generic create modal defaults its type to "other",
          a record that never shows on /inspections unless the Type select is flipped. */}
      <Link href="/schedule?new=appointment">
        <Button size={size} variant="outline" className="shrink-0 whitespace-nowrap">
          {t("qt_btn_bookAnInspection")}
        </Button>
      </Link>
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
