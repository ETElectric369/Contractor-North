"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Badge, statusTone } from "@/components/ui/badge";
import { setChangeOrderStatus } from "./actions";

export function CoStatusControl({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function set(next: string) {
    start(async () => {
      await setChangeOrderStatus(id, next);
      router.refresh();
    });
  }

  if (status !== "pending") {
    return (
      <button
        onClick={() => set("pending")}
        disabled={pending}
        title="Reset to pending"
      >
        <Badge tone={statusTone(status)}>{status}</Badge>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => set("approved")}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
      >
        <Check className="h-4 w-4 shrink-0" /> Approve
      </button>
      <button
        onClick={() => set("rejected")}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
      >
        <X className="h-4 w-4 shrink-0" /> Reject
      </button>
    </div>
  );
}
