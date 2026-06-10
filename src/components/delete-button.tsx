"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Confirm-guarded delete that runs a server action, then redirects or refreshes. */
export function DeleteButton({
  run,
  confirmText,
  redirectTo,
  label = "Delete",
  size = "md",
}: {
  run: () => Promise<{ ok: boolean; error?: string }>;
  confirmText: string;
  redirectTo?: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete() {
    if (!confirm(confirmText)) return;
    setError(null);
    start(async () => {
      const res = await run();
      if (!res.ok) {
        setError(res.error ?? "Could not delete.");
        return;
      }
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        size={size === "sm" ? "sm" : undefined}
        onClick={onDelete}
        disabled={pending}
        className="text-red-600 hover:bg-red-50"
      >
        <Trash2 className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        {pending ? "Deleting…" : label}
      </Button>
      {error && (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
          {error}
        </div>
      )}
    </div>
  );
}
