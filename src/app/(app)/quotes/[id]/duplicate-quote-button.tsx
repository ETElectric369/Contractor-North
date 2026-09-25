"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { duplicateQuote } from "../actions";

/** One-tap clone of this quote (header + line items) into a fresh "(copy)"
 *  draft, then opens it for editing. */
export function DuplicateQuoteButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        variant="outline"
       
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await duplicateQuote(id);
            if (!res.ok || !res.id) return setError(res.error ?? "Couldn't duplicate.");
            // The copy exists, but something it should carry didn't come: said, and it stays up
            // until read, because the page it lands on would not otherwise say what's missing.
            if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
            router.push(`/quotes/${res.id}`);
          })
        }
        title="Duplicate quote"
      >
        <Copy className="h-4 w-4" /> {pending ? "Duplicating…" : "Duplicate"}
      </Button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </>
  );
}
