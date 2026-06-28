"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { duplicateQuote } from "../actions";

/** One-tap clone of this quote (header + line items) into a fresh "(copy)"
 *  draft, then opens it for editing. */
export function DuplicateQuoteButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await duplicateQuote(id);
            if (!res.ok || !res.id) return setError(res.error ?? "Couldn't duplicate.");
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
