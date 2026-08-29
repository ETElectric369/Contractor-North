"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { openJobInspector } from "../../appointments/actions";

/** An access point, not a wall (Erik) — the Inspector with every note, photo and intake answer
 *  this work has collected from ANY entrance, one tap from the job. Finds the record that already
 *  holds the data; only starts a fresh one when nothing anywhere exists. */
export function OpenInspectorButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await openJobInspector(jobId);
          if (!res.ok || !res.redirect) {
            toast(res.error ?? "Couldn't open the Inspector.", "error");
            return;
          }
          router.push(res.redirect);
        })
      }
    >
      <ClipboardList className="h-4 w-4" /> {pending ? "Opening…" : "Inspector"}
    </Button>
  );
}
