"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { createInvoiceForJob } from "../actions";

/**
 * "New invoice" — the plain standard invoice, front-and-center on the Invoices tab (it used to hide
 * in the Manage ⋯ menu, so on a T&M job you'd only see "Progress payment" and think you couldn't
 * bill straight). Pulls the job's logged labor + materials into a draft. It's now IDEMPOTENT: if the
 * job already has a standard invoice it opens THAT one instead of spawning a duplicate that re-bills
 * the same hours (the accountability fix), telling you so when the existing one was already sent.
 */
export function NewInvoiceButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function go() {
    start(async () => {
      const res = await createInvoiceForJob(jobId);
      if (!res.ok || !res.id) {
        toast(res.error ?? "Could not create the invoice.", "error");
        return;
      }
      if (res.importWarning) toast(res.importWarning, "info");
      router.push(`/billing/${res.id}`);
    });
  }

  return (
    <Button variant="outline" onClick={go} disabled={pending}>
      <FileText className="h-4 w-4" /> {pending ? "Opening…" : "New invoice"}
    </Button>
  );
}
