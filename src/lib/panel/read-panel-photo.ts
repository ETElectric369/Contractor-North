import type Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { cleanAmps, cleanHalf, cleanKind, cleanPoles, cleanSpace, cleanSpaceList, cleanText, type HeaderSaid, type ReadRow } from "./readers";

/**
 * READ THE PANEL PHOTO (Panel plan, phase 4; Erik's decision 1: the crew and the office, capped at
 * three reads per job per day, a few cents a read).
 *
 * One photo of the panel (the door's directory and the breakers) goes to the model, which says what
 * it can READ: each space's words, size and type, and the panel's brand, main, spaces and any No
 * Stab spaces. What it can't read it names ("Space 9's label is torn off"), and it never guesses:
 * an amps figure it can't see is left out, not filled in. Everything it returns is a suggestion
 * (lib/panel/readers decides SAME / DIFFERS / NEW against the list); nothing it says is written
 * over a kept circuit.
 *
 * This file holds the prompt, the model call (metered, `panel-photo`) and the cleaning of the
 * answer. The door (who, which photo, the cap, the spend ceiling, the write) is panel-actions.ts.
 */

export { PHOTO_READS_PER_JOB_PER_DAY } from "./readers";
/** The model's own per-image ceiling. The app's uploads are prepared well under it. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** A panel photo is one image, a few hundred output rows at most: pennies, never dollars. */
export const PHOTO_MAX_TOKENS = 3000;

const MEDIA: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
/** The image type a photo can be read as, from its name, or null (HEIC, PDF, anything else). */
export function photoMime(...names: (string | null | undefined)[]): string | null {
  for (const n of names) {
    const ext = String(n ?? "").toLowerCase().split("?")[0].split(".").pop() ?? "";
    if (MEDIA[ext]) return MEDIA[ext];
  }
  return null;
}

export const PHOTO_SYSTEM =
  "You read ONE photo of a residential or light-commercial electrical panel for the electrician working on it: the panel directory (the circuit list on the door) and the breakers you can see. " +
  "You are a careful reader, not an estimator. Report ONLY what is legible in the photo. Never guess a label, an amps figure or a space number: leave out what you cannot read, and say what you could not read in `unreadable`. " +
  'Respond with ONLY a JSON object: {"panel": {"brand": string|null, "main_amps": number|null, "spaces": number|null, "no_stab_spaces": number[]}, ' +
  '"circuits": [{"space": number|null, "half": "A"|"B"|null, "label": string|null, "amps": number|null, "poles": 1|2|3|null, "kind": "standard"|"afci"|"gfci"|"dual_function"|"spd"|null}], "unreadable": string[]}. ' +
  "space = the number printed on the panel or directory for that position. For a 2-pole or 3-pole breaker give the LOWEST space number it covers, and poles 2 or 3. " +
  "half = A or B ONLY for one half of a tandem (twin or quad) breaker sharing a space; otherwise null. " +
  "label = the directory's words for that space exactly as written (keep abbreviations like 'Mud Rm', 'GDO #1'); null if blank or illegible. " +
  "amps = the handle rating when legible (15, 20, 30…); poles = how many handles tied together. kind = afci / gfci / dual_function (AFCI+GFCI) / spd (surge) only when the breaker's face or test button shows it. " +
  "panel.brand from the label or breakers (Siemens, Square D, Eaton, GE…); main_amps from the main breaker; spaces = how many breaker spaces the panel has; no_stab_spaces = positions where the bus has no stab (crimped or blocked). " +
  "One circuit object per directory line or breaker you can read, top to bottom. No prose outside the JSON.";

export type PanelPhotoReading = { header: HeaderSaid; rows: ReadRow[]; unreadable: string[] };

/** The model's answer, cleaned: bad sizes dropped to null, never guessed; rows with nothing
 *  readable dropped; at most 84 rows and 20 unreadable notes. */
export function parsePanelPhoto(raw: unknown): PanelPhotoReading {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = (o.panel && typeof o.panel === "object" ? o.panel : {}) as Record<string, unknown>;
  const spaces = cleanSpace(p.spaces);
  const header: HeaderSaid = {
    brand: cleanText(p.brand, 60),
    main_amps: Number.isInteger(Number(p.main_amps)) && Number(p.main_amps) >= 30 && Number(p.main_amps) <= 1200 ? Number(p.main_amps) : null,
    spaces,
    dead_spaces: cleanSpaceList(p.no_stab_spaces ?? p.dead_spaces ?? [], spaces ?? 84),
  };
  const list = Array.isArray(o.circuits) ? o.circuits : [];
  const rows: ReadRow[] = [];
  const odd: string[] = [];
  for (const item of list.slice(0, 84)) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const space = cleanSpace(r.space, spaces ?? 84);
    const said = cleanText(r.label, 120);
    const amps = cleanAmps(r.amps);
    if (space == null && !said) continue;
    // A space the panel can't have is not quietly dropped: the words come in with no space, and
    // the odd number is said.
    if (space == null && r.space != null && String(r.space).trim() !== "") {
      odd.push(`${said}: Space ${String(r.space).slice(0, 6)} Isn't On ${spaces ? `A ${spaces}-Space Panel` : "This Panel"}.`);
    }
    rows.push({
      space,
      half: space != null ? cleanHalf(r.half) : null,
      said,
      room: null,
      amps,
      poles: cleanPoles(r.poles) ?? 1,
      kind: cleanKind(r.kind),
      wire: null,
      // It is in the panel already: whatever it is, it's existing work.
      work: "existing",
      check: null,
    });
  }
  const unreadable = [
    ...((Array.isArray(o.unreadable) ? o.unreadable : [])
      .map((u) => cleanText(u, 200))
      .filter(Boolean)
      .slice(0, 20) as string[]),
    ...odd.slice(0, 10),
  ];
  return { header, rows, unreadable };
}

/**
 * The model call. `client` is getAnthropic() in the app and a stub in tests; nothing here reads the
 * database or the bucket. Metered against the org (recordAiUsage), and a reply cut off by the token
 * ceiling is said, never parsed as if whole.
 */
export async function readPanelPhotoWithModel(o: {
  client: Pick<Anthropic, "messages">;
  model: string;
  mime: string;
  base64: string;
  orgId: string;
}): Promise<{ ok: true; reading: PanelPhotoReading } | { ok: false; error: string }> {
  const msg = await o.client.messages.create({
    model: o.model,
    max_tokens: PHOTO_MAX_TOKENS,
    system: PHOTO_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: o.mime as "image/jpeg", data: o.base64 } },
          { type: "text", text: "Read this panel. JSON only." },
        ],
      },
    ],
  });
  void recordAiUsage({ orgId: o.orgId, model: o.model, surface: "panel-photo", usage: msg.usage as never });
  if (msg.stop_reason === "max_tokens") {
    return { ok: false, error: "The photo had more on it than one read can hold. Take a closer photo of half the door and read that." };
  }
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  const parsed = await parseAiJson(o.client as Anthropic, text, o.orgId);
  return { ok: true, reading: parsePanelPhoto(parsed) };
}
