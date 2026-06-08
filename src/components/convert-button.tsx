"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Runs a server action that returns { ok, id } and navigates to hrefPrefix+id. */
export function ConvertButton({
  label,
  run,
  hrefPrefix,
  variant = "primary",
}: {
  label: string;
  run: () => Promise<{ ok: boolean; error?: string; id?: string }>;
  hrefPrefix: string;
  variant?: "primary" | "outline";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    const res = await run();
    if (res.ok && res.id) {
      router.push(`${hrefPrefix}${res.id}`);
      return;
    }
    setErr(res.error ?? "Something went wrong.");
    setBusy(false);
  }

  return (
    <div className="relative">
      <Button variant={variant} onClick={go} disabled={busy}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}
      </Button>
      {err && (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
          {err}
        </div>
      )}
    </div>
  );
}
