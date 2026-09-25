import type Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { parseQuoteBreaker } from "./model";
import { cleanAmps, cleanKind, cleanPoles, cleanText, type ReadRow } from "./readers";
import { photoMime } from "./read-panel-photo";

/**
 * READ CIRCUITS FROM THE PLANS (Panel plan, phase 4; the office only).
 *
 * ONE plan paper per call (a PDF or a photo of a sheet), aimed at the panel schedules and the
 * electrical / MPE sheets. The model lists the circuits the schedules and sheets state, each with
 * the sheet it came from and the plan's own circuit number, and names every sheet it could not count
 * in plain words ("MPE-1 Was Too Dense To Count"), so a short read is never mistaken for a whole one.
 *
 * The plan's circuit number is kept with the row ("Plans: Ckt 7") but is NOT written as a space:
 * the schedule is the designer's, the box on site is the crew's, and a person places it. Every row
 * is a suggestion (lib/panel/readers); nothing is written over a kept circuit.
 *
 * The same loading the estimator's plan take-off uses: a base64 document block under the reader's
 * 20 MB ceiling (base64 inflates ~33%; the request ceiling is 32 MB). The door (office only, which
 * paper, the cap, the ceiling, the write) is panel-actions.ts.
 */

export const PLAN_MAX_BYTES = 20 * 1024 * 1024;
export const PLAN_READS_PER_JOB_PER_DAY = 5;
export const PLAN_MAX_TOKENS = 6000;

/** How a plan paper goes to the model: a PDF as a document, a photo of a sheet as an image. */
export function planMedia(...names: (string | null | undefined)[]): { kind: "pdf"; mime: "application/pdf" } | { kind: "image"; mime: string } | null {
  for (const n of names) if (/\.pdf(\?|$)/i.test(String(n ?? ""))) return { kind: "pdf", mime: "application/pdf" };
  const img = photoMime(...names);
  return img ? { kind: "image", mime: img } : null;
}

export const PLAN_SYSTEM =
  "You read ONE set of construction plans for an electrician building the job's circuit list. Look for PANEL SCHEDULES first, then the electrical / MPE sheets (E-, MPE-, M-E sheets, power and lighting plans, their legends and notes). " +
  "Report ONLY circuits the schedules or sheets actually state. Never invent a circuit, never guess an amps figure, never count devices into circuits yourself. " +
  "If a sheet is too dense, too small or too blurry to count reliably, do NOT count it: name it in `not_counted` with the reason. " +
  'Respond with ONLY a JSON object: {"sheets_read": string[], "not_counted": [{"sheet": string, "why": string}], ' +
  '"circuits": [{"sheet": string|null, "ckt": string|null, "description": string, "room": string|null, "breaker": string|null, "amps": number|null, "poles": 1|2|3|null, "kind": "standard"|"afci"|"gfci"|"dual_function"|"spd"|null, "wire": string|null, "existing": boolean}]}. ' +
  "sheet = the sheet number it came from (E-1, MPE-2). ckt = the plan's circuit number as printed. description = what the circuit feeds, in the plan's words. breaker = the breaker as printed (\"20A\", \"2P 30A\", a part number). " +
  "existing = true only when the plans mark the circuit as existing to remain. No prose outside the JSON.";

export type PlanReading = { sheets: string[]; notCounted: string[]; rows: ReadRow[] };

/** "MPE-1" + "too dense to count" → "MPE-1 Was Too Dense To Count." */
function notCountedWords(sheet: string | null, why: string | null): string {
  const name = sheet || "One Sheet";
  const w = (why ?? "").toLowerCase();
  if (/dense|small|busy|crowd/.test(w)) return `${name} Was Too Dense To Count.`;
  if (/blur|illegib|unread|faint|resolution/.test(w)) return `${name} Couldn't Be Read Clearly.`;
  return `${name} Wasn't Counted${why ? `: ${why}` : "."}`;
}

export function parsePlanCircuits(raw: unknown): PlanReading {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sheets = (Array.isArray(o.sheets_read) ? o.sheets_read : []).map((s) => cleanText(s, 40)).filter(Boolean).slice(0, 60) as string[];
  const notCounted = (Array.isArray(o.not_counted) ? o.not_counted : [])
    .map((n) => {
      const r = (n && typeof n === "object" ? n : { sheet: n }) as Record<string, unknown>;
      return notCountedWords(cleanText(r.sheet, 40), cleanText(r.why, 160));
    })
    .slice(0, 30);
  const rows: ReadRow[] = [];
  for (const item of (Array.isArray(o.circuits) ? o.circuits : []).slice(0, 200)) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const said = cleanText(r.description, 200);
    const breakerText = cleanText(r.breaker, 60);
    if (!said && !breakerText) continue;
    const parsed = parseQuoteBreaker(breakerText);
    const poles = cleanPoles(r.poles) ?? parsed?.poles ?? 1;
    const amps = cleanAmps(r.amps) ?? parsed?.amps ?? null;
    rows.push({
      space: null,
      half: null,
      said,
      room: cleanText(r.room, 80),
      amps,
      poles,
      kind: cleanKind(r.kind),
      wire: cleanText(r.wire, 40),
      work: r.existing === true ? "existing" : "new",
      check: parsed?.check ? parsed.check.replace(/^The estimate says/, "The plans say") : null,
      extra: {
        sheet: cleanText(r.sheet, 40),
        ckt: cleanText(r.ckt, 20),
        breaker: breakerText,
        wire: cleanText(r.wire, 40),
      },
    });
  }
  return { sheets, notCounted, rows };
}

export async function readPlanWithModel(o: {
  client: Pick<Anthropic, "messages">;
  model: string;
  media: { kind: "pdf" | "image"; mime: string };
  base64: string;
  name: string;
  orgId: string;
}): Promise<{ ok: true; reading: PlanReading } | { ok: false; error: string }> {
  const block =
    o.media.kind === "pdf"
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: o.base64 } }
      : { type: "image" as const, source: { type: "base64" as const, media_type: o.media.mime as "image/jpeg", data: o.base64 } };
  const msg = await o.client.messages.create({
    model: o.model,
    max_tokens: PLAN_MAX_TOKENS,
    system: PLAN_SYSTEM,
    messages: [{ role: "user", content: [block as never, { type: "text", text: `The plans: ${o.name}. JSON only.` }] }],
  });
  void recordAiUsage({ orgId: o.orgId, model: o.model, surface: "panel-plans", usage: msg.usage as never });
  if (msg.stop_reason === "max_tokens") {
    return { ok: false, error: "These plans list more circuits than one read can hold. Upload the panel schedule sheet on its own and read that." };
  }
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  const parsed = await parseAiJson(o.client as Anthropic, text, o.orgId);
  return { ok: true, reading: parsePlanCircuits(parsed) };
}
