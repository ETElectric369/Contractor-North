import type Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { MAX_SPACES } from "./input";
import { labelKey, quadCentreHalf, quadOuterSlots } from "./model";
import { cleanAmps, cleanHalf, cleanKind, cleanPoles, cleanSpace, cleanSpaceList, cleanText, type HeaderSaid, type ReadRow } from "./readers";

/**
 * READ A PHOTO (Panel plan, phase 4; honed in the panel-first wave. Erik's decision 1: the crew and
 * the office; the crew capped at three reads per job per day, a few cents a read).
 *
 * One photo of the panel door goes to the model, which reads it THE WAY THE LABEL STRIPS ARE BUILT:
 * space by space by the panel's own numbers, each space's handles top to bottom, one line per
 * handle. A tandem is two lines (half A, then B); a 2-pole is the same words on both of its lines; a
 * quad is its two outer singles and a centre 2-pole whose first handle is the B half of the first
 * space where space 1 is at the top, the A half where it is at the bottom (model quadCentreHalf; the
 * prompt says both). Each line is space, half, poles, amps, label. It never invents a space the
 * photo doesn't show, never guesses words or amps, and names what it couldn't read. Of the panel
 * itself it reads the brand, the main, the spaces and the No Stab spaces (no_stab_spaces), which
 * the card offers in one "The photo says …" line with Use It.
 *
 * The parser folds a 2-pole's (or 3-pole's) lines into ONE circuit at its first space, keeping that
 * line's half (a quad's centre: space s, half B top down, half A bottom up), so what lands is one
 * row per breaker, in its space (lib/panel/readers landRead). A line with no usable space can't land
 * anywhere: it is named, never dropped quietly.
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

/** A slot of a quad on spaces s and s+2, in the prompt's words ("space s+2 half A"). */
const quadSlotWords = (x: { space: number; half: "A" | "B" | null }) => `space ${x.space === 0 ? "s" : `s+${x.space}`} half ${x.half}`;

/**
 * THE QUAD, BOTH WAYS A DOOR IS NUMBERED, in one sentence, from the model's one rule
 * (quadCentreHalf / quadOuterSlots): the photo can't know which way the numbers run until it reads
 * them, so it is told both.
 */
function quadSentence(): string {
  const way = (n: "top_down" | "bottom_up") => {
    const centre = quadCentreHalf(n);
    const [top, bottom] = quadOuterSlots(0, n);
    return `the centre is space s half ${centre} and space s+2 half ${centre === "A" ? "B" : "A"}, the outer singles ${quadSlotWords(top)} (the top handle) and ${quadSlotWords(bottom)} (the bottom one)`;
  };
  return (
    "A quad (four handles across two spaces s and s+2): the two outer handles are singles, poles 1, and the two centre handles are ONE 2-pole, the same label on both, poles 2 — " +
    `where space 1 is at the top, ${way("top_down")}; where space 1 is at the bottom (s+2 hangs above s), ${way("bottom_up")}. `
  );
}

export const PHOTO_SYSTEM =
  "You read ONE photo of a residential or light-commercial electrical panel for the electrician working on it: the directory on the door (the circuit list) and the breakers you can see. " +
  "You are a careful reader, not an estimator. Report ONLY what is legible in the photo. Never guess a label, an amps figure or a space number, and never invent a space the photo does not show: leave out what you cannot read, and say what you could not read in `unreadable`. " +
  'Respond with ONLY a JSON object: {"panel": {"brand": string|null, "main_amps": number|null, "spaces": number|null, "no_stab_spaces": number[]}, ' +
  '"lines": [{"space": number, "half": "A"|"B"|null, "poles": 1|2|3, "amps": number|null, "label": string|null, "kind": "standard"|"afci"|"gfci"|"dual_function"|"spd"|null}], "unreadable": string[]}. ' +
  "ONE LINE PER HANDLE. Go space by space by the numbers printed on the panel or the directory (odd down the left, even down the right), and within a space give its handles top to bottom. " +
  "A full-width single breaker: one line, half null, poles 1. " +
  "A tandem (twin) in one space: two lines, half A (the top handle) then half B, poles 1 each. " +
  "A 2-pole covers space s and s+2 on the same side: one line on EACH of its two spaces, the same label on both, poles 2 (a 3-pole: s, s+2 and s+4, poles 3). " +
  quadSentence() +
  "Leave out a space with nothing in it. label = the directory's words for that handle exactly as written (keep abbreviations like 'Mud Rm', 'GDO #1'); null when blank or illegible. " +
  "amps = the handle rating when legible (15, 20, 30…). kind = afci / gfci / dual_function (AFCI+GFCI) / spd (surge) only when the breaker's face or test button shows it. " +
  "panel.brand from the label or the breakers (Siemens, Square D, Eaton, GE…); main_amps from the main breaker; spaces = how many breaker spaces the panel has; no_stab_spaces = the spaces where the bus has no stab (crimped or blocked off), only when you can see it, else []. No prose outside the JSON.";

export type PanelPhotoReading = { header: HeaderSaid; rows: ReadRow[]; unreadable: string[] };

type Line = { at: number; space: number; half: ReadRow["half"]; said: string | null; amps: number | null; poles: number; kind: ReadRow["kind"] };

/** A space's handles top to bottom: half A, a full-width handle, then half B. */
const HALF_ORDER = { A: 0, full: 1, B: 2 } as const;

/**
 * The model's answer, cleaned: one ReadRow per BREAKER, in space order. Bad sizes drop to null,
 * never guessed. A 2-pole's (or 3-pole's) lines fold into one row at its first space, keeping that
 * line's half (a quad's centre: space s, half B top down or half A bottom up — whichever the photo
 * shows on the first space); a line whose partner is missing stands alone. A
 * line with neither words nor a size says nothing and is left out; one with no space, or a space
 * the panel can't have, is named in `unreadable`. At most 200 lines and 20 unreadable notes.
 */
export function parsePanelPhoto(raw: unknown): PanelPhotoReading {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = (o.panel && typeof o.panel === "object" ? o.panel : {}) as Record<string, unknown>;
  const spaces = cleanSpace(p.spaces);
  const main = Number(p.main_amps);
  const header: HeaderSaid = {
    brand: cleanText(p.brand, 60),
    main_amps: p.main_amps != null && Number.isInteger(main) && main >= 30 && main <= 1200 ? main : null,
    spaces,
    // No Stab: only spaces the panel can have; anything else is dropped, never guessed into one.
    dead_spaces: cleanSpaceList(p.no_stab_spaces ?? p.dead_spaces ?? [], spaces ?? MAX_SPACES),
  };
  const list = Array.isArray(o.lines) ? o.lines : Array.isArray(o.circuits) ? o.circuits : [];
  const odd: string[] = [];
  const lines: Line[] = [];
  for (const [at, item] of list.slice(0, 200).entries()) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const said = cleanText(r.label, 120);
    const amps = cleanAmps(r.amps);
    if (!said && amps == null) continue;
    const space = cleanSpace(r.space, spaces ?? MAX_SPACES);
    const rawSpace = r.space == null ? "" : String(r.space).trim().slice(0, 6);
    if (space == null) {
      // It can't land anywhere: said, never dropped quietly.
      const what = said ? `"${said}"` : `A ${amps}A breaker`;
      odd.push(rawSpace ? `${what} is on space ${rawSpace}, which isn't on ${spaces ? `a ${spaces}-space panel` : "this panel"}.` : `${what} had no space number the photo showed.`);
      continue;
    }
    lines.push({ at, space, half: cleanHalf(r.half), said, amps, poles: cleanPoles(r.poles) ?? 1, kind: cleanKind(r.kind) });
  }
  const order = (l: Line) => l.space * 3 + HALF_ORDER[l.half ?? "full"];
  lines.sort((a, b) => order(a) - order(b) || a.at - b.at);

  const used = new Set<Line>();
  const rows: ReadRow[] = [];
  for (const l of lines) {
    if (used.has(l)) continue;
    used.add(l);
    let { said, amps, kind } = l;
    // THE OTHER HANDLES OF A 2- OR 3-POLE: the same pole count on s+2 (and s+4), the same side, with
    // the same words (or none).
    for (let k = 1; k < l.poles; k++) {
      const want = l.space + 2 * k;
      const mate = lines.find((m) => !used.has(m) && m.space === want && m.poles === l.poles && (!m.said || !said || labelKey(m.said) === labelKey(said)));
      if (!mate) break;
      used.add(mate);
      said = said ?? mate.said;
      amps = amps ?? mate.amps;
      kind = kind ?? mate.kind;
    }
    rows.push({
      space: l.space,
      half: l.half,
      said,
      room: null,
      amps,
      poles: l.poles,
      kind,
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
