/**
 * Renders a line-item description as orderly sub-items instead of a comma-jammed
 * run-on. Splits on newlines always; splits on commas ONLY when it clearly reads
 * like a short list (3+ parts, each short, no sentence colon) — so prose like
 * "200A panel, complete with breakers" is left alone.
 */
export function lineItemParts(desc: string): string[] {
  const s = (desc ?? "").trim();
  if (!s) return [];
  const byNewline = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (byNewline.length > 1) return byNewline;
  if (!s.includes(":")) {
    const byComma = s.split(",").map((x) => x.trim()).filter(Boolean);
    if (byComma.length >= 3 && byComma.every((x) => x.length > 0 && x.length <= 40)) return byComma;
  }
  return [s];
}

export function LineItemText({ description, className }: { description: string; className?: string }) {
  const parts = lineItemParts(description);
  if (parts.length <= 1) return <span className={className}>{description}</span>;
  // Spans (not ul/li/div) so this is valid phrasing content even inside a
  // <button> (the click-to-edit row).
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <span key={i} className="flex gap-1.5">
          <span className="shrink-0 text-slate-300">•</span>
          <span>{p}</span>
        </span>
      ))}
    </span>
  );
}
