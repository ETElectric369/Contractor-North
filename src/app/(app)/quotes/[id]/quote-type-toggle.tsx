"use client";

import { useState, useTransition } from "react";
import { SegmentedControl } from "@/components/ui/segmented";
import { setQuoteType } from "../actions";

/** Fixed-price quote vs time-&-materials estimate — same document, the label and
 *  the printed wording follow this. */
export function QuoteTypeToggle({ id, value }: { id: string; value: "estimate" | "quote" }) {
  const [type, setType] = useState<"estimate" | "quote">(value);
  const [pending, start] = useTransition();

  function pick(t: "estimate" | "quote") {
    if (t === type || pending) return;
    setType(t);
    start(() => {
      void setQuoteType(id, t);
    });
  }

  return (
    <div title="Quote = fixed price · Estimate = time & materials">
      <SegmentedControl
        activeId={type}
        onSelect={(id) => pick(id as "estimate" | "quote")}
        items={[
          { id: "quote", label: "Quote (fixed)" },
          { id: "estimate", label: "Estimate (T&M)" },
        ]}
      />
    </div>
  );
}
