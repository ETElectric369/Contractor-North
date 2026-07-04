import * as React from "react";
import { cn } from "@/lib/utils";

export type Tone =
  | "slate"
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "purple"
  | "indigo";

const tones: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700",
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-700",
  purple: "bg-purple-100 text-purple-700",
  indigo: "bg-indigo-100 text-indigo-700",
};

/** THE tone→classes map, for surfaces that can't use <Badge> (e.g. a bare portal span)
 *  but must still pull their colors from the ONE palette — never a hand-rolled color pair. */
export function toneClasses(tone: Tone): string {
  return tones[tone];
}

export function Badge({
  tone = "slate",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Map a status string to a sensible badge tone. */
export function statusTone(status: string): Tone {
  switch (status) {
    case "active":
    case "accepted":
    case "complete":
    case "approved":
    case "in_progress":
    case "paid":
    case "signed":
      return "green";
    case "lead":
    case "draft":
    case "estimate":
    case "pending":
    case "open":
    case "unpaid":
    case "partial":
      return "amber";
    case "scheduled":
    case "sent":
    case "assigned":
      return "blue";
    case "declined":
    case "rejected":
    case "cancelled":
    case "expired":
    case "inactive":
    case "overdue":
      return "red";
    case "invoiced":
      return "purple";
    default:
      return "slate";
  }
}
