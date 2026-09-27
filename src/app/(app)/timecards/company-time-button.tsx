"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { fileShiftAsCompanyTime } from "../timeclock/actions";

/**
 * COMPANY TIME, one tap, on a Fix These row for a shift on no job: the other honest answer to
 * "which job was this?" when the answer is none (shop, errands, the office). Files it under the
 * company's non-billable time code (SHOP when there is one), which labor billing already leaves off
 * invoices, and the row leaves Hours On No Job. Undo on the toast puts back what it had.
 */
export function CompanyTimeButton({ entryId, code }: { entryId: string; code: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const inFlight = useRef(false);

  const file = () => {
    if (inFlight.current || pending) return;
    inFlight.current = true;
    start(async () => {
      try {
        const r = await fileShiftAsCompanyTime({ entry_id: entryId });
        if (!r.ok) {
          toast(r.error ?? "That shift didn't change.", "error");
          return;
        }
        const filed = r.code ?? code;
        toast(r.sentence ?? `Filed as ${filed}.`, "success", {
          label: "Undo",
          onClick: () => {
            void fileShiftAsCompanyTime({ entry_id: entryId, undo: { code: filed, previous: r.previous ?? null } }).then((u) => {
              toast(u.ok ? "Back on Hours On No Job." : (u.error ?? "Couldn't undo."), u.ok ? "success" : "error");
              router.refresh();
            });
          },
        });
        router.refresh();
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <button
      type="button"
      onClick={file}
      disabled={pending}
      title={`Files it as ${code}, the company's own time, off every invoice`}
      className="inline-flex min-h-[44px] items-center rounded-lg px-2 text-sm font-medium text-slate-600 hover:bg-amber-100/60 disabled:opacity-50"
    >
      {pending ? "Filing…" : "Company Time"}
    </button>
  );
}
