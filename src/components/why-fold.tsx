import { ChevronRight } from "lucide-react";

/**
 * "IT LOOKS LIKE ONE BIG RUN-ON SENTENCE" (Erik, Bills plan Wave B). A screen says a one-line
 * label and a count; the reasoning behind it waits in a small "Why?" fold he opens when he wants
 * it. The words are still there (nothing silent), just not in his way at 60mph.
 *
 * A native <details>: no state, renders on the server or the client, and what is inside is in the
 * page (a laptop's Find still reaches it).
 */
export function WhyFold({
  children,
  label = "Why?",
  className = "",
}: {
  children: React.ReactNode;
  /** The fold's own words. "Why?" unless the question is a different one ("What Counts?"). */
  label?: string;
  className?: string;
}) {
  return (
    <details className={`text-xs text-slate-500 ${className}`}>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center font-medium text-brand [&::-webkit-details-marker]:hidden">
        {label}
      </summary>
      <div className="mb-2 space-y-1 leading-relaxed">{children}</div>
    </details>
  );
}

/**
 * A folded section: one line (its label and count) that opens to what it holds. The same native
 * <details>, so a link to anything inside it can open it (FoldOpener) and it costs no state.
 */
export function Fold({
  id,
  summary,
  children,
  open = false,
  className = "",
  summaryClassName = "",
}: {
  id?: string;
  summary: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  return (
    <details id={id} open={open || undefined} className={`scroll-mt-20 ${className}`}>
      <summary
        className={`flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden ${summaryClassName}`}
      >
        {/* Bound to THIS fold's own summary, so opening an outer fold never turns an inner chevron. */}
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-slate-400 motion-safe:transition-transform [details[open]>summary>&]:rotate-90" />
        <span className="min-w-0 flex-1">{summary}</span>
      </summary>
      {children}
    </details>
  );
}
