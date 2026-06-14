"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ChevronDown } from "lucide-react";
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

export type ConvertOption = {
  label: string;
  /** Run a server action that returns { ok, id }; navigate to hrefPrefix+id. */
  run?: () => Promise<{ ok: boolean; error?: string; id?: string }>;
  hrefPrefix?: string;
  /** Or a direct link (e.g. "View invoice" once it already exists). */
  href?: string;
};

/** One "Convert ▾" menu that collects every conversion for a record. */
export function ConvertMenu({ options, label = "Convert" }: { options: ConvertOption[]; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick(o: ConvertOption) {
    setOpen(false);
    if (o.href) {
      router.push(o.href);
      return;
    }
    if (!o.run || !o.hrefPrefix) return;
    setBusy(o.label);
    setErr(null);
    const res = await o.run();
    if (res.ok && res.id) {
      router.push(`${o.hrefPrefix}${res.id}`);
      return;
    }
    setErr(res.error ?? "Something went wrong.");
    setBusy(null);
  }

  if (!options.length) return null;

  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen((v) => !v)} disabled={!!busy}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> {busy}…
          </>
        ) : (
          <>
            {label} <ChevronDown className="h-4 w-4" />
          </>
        )}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {options.map((o) => (
              <button
                key={o.label}
                onClick={() => pick(o)}
                className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
      {err && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
          {err}
        </div>
      )}
    </div>
  );
}
