import { SCREEN_ANCHOR_RE, fillText } from "@/lib/assistant-protocol";

/**
 * THE PHONE'S WORD ON ITS OWN BOXES (rung 2), clamped for the model. The chat sends the page's door
 * list (lib/nort/doors listNortDoors) and the lines its last fills came to; the route turns both
 * into app-context text at the message tail. Names in the spot alphabet, labels plain text, both
 * capped — anything else is dropped, never "fixed". Kept out of the route file (a Next route may
 * export only its handlers) and dependency-free so the route test can read it alone.
 */

/** ≤ 80 doors as "[name] what it is (add a row: label, value, unit) — choices: A / B — now: "…"". */
export function doorContextLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const { name, label, can, fields, now, options } = d as Record<string, unknown>;
    if (typeof name !== "string" || !SCREEN_ANCHOR_RE.test(name)) continue;
    const text = fillText(label, 80)?.replace(/\s+/g, " ") ?? "";
    const kinds = Array.isArray(can) ? can.filter((k): k is "fill" | "add" => k === "fill" || k === "add") : [];
    if (!kinds.length) continue;
    const fs = Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string" && /^[a-z][a-z_]{0,19}$/.test(f)).slice(0, 8) : [];
    const opts = Array.isArray(options) ? options.map((o) => fillText(o, 40)?.replace(/\s+/g, " ") ?? "").filter(Boolean).slice(0, 12) : [];
    const cur = fillText(now, 60)?.replace(/\s+/g, " ") ?? "";
    out.push(
      `[${name}] ${text || "a box"}${kinds.includes("add") ? ` (add a row: ${fs.length ? fs.join(", ") : "fields"})` : ""}${opts.length ? ` — choices: ${opts.join(" / ")}` : ""}${cur ? ` — now: "${cur}"` : ""}`,
    );
    if (out.length >= 80) break;
  }
  return out;
}

/** What the phone says landed since the last turn: ≤ 20 plain lines, each "- …". */
export function seenLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => fillText(l, 160)?.replace(/\s+/g, " ") ?? "")
    .filter(Boolean)
    .slice(0, 20)
    .map((l) => `- ${l}`);
}
