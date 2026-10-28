import { Fragment, type ReactNode } from "react";

/**
 * A translated sentence with ELEMENTS in its slots (cn-v1138). fillText (lib/i18n) fills a {slot}
 * with a string; a sentence that carries a bold path or an emphasised word in the middle — "iPhone
 * {path} This powers GPS clock-in…", "how Nort talks to {you} and your crew" — needs a React node
 * there, and the words around the slot move with the language. The template is split on its slots
 * and each is replaced by the node handed for it; a slot nothing was handed for stays as typed, so a
 * missing node is seen, never silently dropped.
 */
export function fillNodes(template: string, slots: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/(\{\w+\})/);
  return parts.map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return part;
    return <Fragment key={i}>{m[1] in slots ? slots[m[1]] : part}</Fragment>;
  });
}
