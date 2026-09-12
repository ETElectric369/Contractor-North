"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { createInvoiceForJob } from "../actions";

/**
 * "New Invoice" — the plain standard invoice, front-and-center on the Invoices tab (it used to hide
 * in the Manage ⋯ menu, so on a T&M job you'd only see "Progress payment" and think you couldn't
 * bill straight). Pulls the job's logged labor + materials into a draft — only the hours and bills
 * not already on another invoice, so a job can be invoiced AGAIN for what is new since the last one
 * (85 Whitney, 2026-09-11: a PAID invoice used to capture this click and open itself, locked, while
 * the new time and bills had no door). An open DRAFT on the job is opened instead of a second one,
 * and the note says so.
 *
 * NOTHING SILENT: the server's note (opened the draft / what was pulled in / what couldn't be) is
 * toasted BEFORE the redirect, and a refusal carries its own door — "Open INV-0xx" when everything
 * is already billed there.
 */
export function NewInvoiceButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function go() {
    start(async () => {
      const res = await createInvoiceForJob(jobId);
      if (!res.ok || !res.id) {
        const door = res.billedOn;
        toast(
          res.error ?? "Could not create the invoice.",
          "error",
          door ? { label: `Open ${door.number}`, onClick: () => router.push(`/billing/${door.id}`) } : undefined,
        );
        return;
      }
      if (res.importWarning) toast(res.importWarning, "info");
      router.push(`/billing/${res.id}`);
    });
  }

  return (
    <Button variant="outline" onClick={go} disabled={pending}>
      <FileText className="h-4 w-4" /> {pending ? "Opening…" : "New Invoice"}
    </Button>
  );
}
