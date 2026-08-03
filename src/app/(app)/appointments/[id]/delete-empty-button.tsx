"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { deleteAppointment } from "../actions";

/**
 * DELETE A VISIT THAT NEVER HAPPENED — one tap, at the top, where the other verbs are.
 *
 * Erik, to the minute, in production:
 *   01:08:08  Site inspection: Sarah Cain → cancelled  (no capture)
 *   01:10:19  Site inspection: Sarah Cain → completed  (full capture)
 *
 * He made one, tried to get rid of it, couldn't, and made another two minutes later. The first is
 * still there. Six rows across two tenants are in that state; nobody has ever successfully deleted
 * one.
 *
 * Why he couldn't: the only real delete lives in the FOOTER OF THE EDIT DETAILS MODAL. The thing
 * that looks like delete — a bare ✗ next to a bare ✓ — cancels, and its confirm read
 * `Cancel "Site inspection"?` inside a dialog whose own dismiss button is also "Cancel".
 *
 * SCOPED ON PURPOSE. This only renders when the appointment carries NO field data: no notes, no
 * measurements, no materials, no photos, no typed answers. A walk-through you actually did is an
 * asset, and one tap at the top of the screen is the wrong amount of friction for destroying it —
 * that stays behind Edit Details, where a deliberate act belongs. A false start is not an asset,
 * and making someone hunt for a modal footer to remove one is how you end up with six of them.
 */
export function DeleteEmptyInspectionButton({
  id,
  label = "Delete",
  afterHref,
}: {
  id: string;
  label?: string;
  /** Where to land afterwards — the page being deleted can't re-render itself. */
  afterHref: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() => {
        // Named plainly, and it says WHY this one is safe to remove — so the offer itself
        // reassures rather than alarms.
        if (!confirm("Delete this visit? Nothing was captured on it, so nothing is lost.")) return;
        start(async () => {
          const r = await deleteAppointment(id);
          if (!r.ok) return toast(r.error ?? "Couldn't delete that.", "error");
          toast("Deleted.");
          router.push(afterHref);
        });
      }}
      className="text-rose-700"
    >
      <Trash2 className="h-4 w-4" /> {label}
    </Button>
  );
}
