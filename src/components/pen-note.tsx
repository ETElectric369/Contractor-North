/**
 * WHAT INK WAS READ, AS ITS OWN LINE (cn-v1181 fixer, skeptic #84 S7). The pen sentence
 * (lib/pen-marks penSentence) is a fact about the paper, not a warning: it is drawn plain and slate
 * wherever a receipt's read is drawn, never amber (amber means a real clock), and never folded into
 * a warning's tone. Nothing at all when there is nothing to say.
 */
export function PenNote({ text, className = "" }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  return (
    <span data-pen-note="" className={`block text-xs text-slate-600 ${className}`.trim()}>
      {text}
    </span>
  );
}
