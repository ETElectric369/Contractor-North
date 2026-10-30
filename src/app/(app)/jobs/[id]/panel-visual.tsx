"use client";

import { AlertTriangle, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { circuitName, slotsOf, sourceWords, spaceMap } from "@/lib/panel/model";
import { stripLines, stripWords, type StripLine } from "@/lib/panel/strip";
import { circuitsOfPanel, heldBy } from "@/lib/panel/held";
import type { CircuitSource, JobCircuit, JobPanel, SpaceHalf } from "@/lib/types";

/** THE DOOR'S SCALE. A whole space is the schedule board's cell, a 44px target (the 44px law)… */
export const SPACE_PX = 44;
/** …and a tandem's two handles share it: each half line DRAWS half a space. Its TAP area still
 *  reaches a whole space, outward (the top half up, the bottom half down) and underneath every
 *  other line, so it never takes a tap meant for a line that is drawn there. */
export const HALF_LINE_PX = SPACE_PX / 2;
/** The two heights as classes (Tailwind reads them as written): h-11 is 44px. */
const SPACE_H = "h-11";
const HALF_LINE_H = "h-[22px]";

/**
 * THE PANEL AS IT LOOKS (the panel-first wave, P1; Erik 2026-10-30: "match the way a panel looks and
 * is labeled"). Two columns of breakers facing each other across the bus, odd spaces down the left
 * and even down the right, top of the box first (flipped when the numbers run bottom up), drawn to
 * one scale: a whole space is SPACE_PX (44px, the schedule board's cell), a tandem's two handles
 * split it into two HALF_LINE_PX (22px) lines, A over B. Every line is one line of the label strip
 * (lib/panel/strip stripLines), so the tab and the printed strips can never disagree about what
 * sits where:
 *
 *   single   one line, the circuit's words and amps ("Dryer · 30").
 *   tandem   two half lines in one space, A over B; a half nobody uses is an open half line.
 *   2-pole   a whole line on each of its two spaces, the SAME words on both ("Mini Split · 30").
 *            A quad's centre 2-pole is two HALF lines straddling the space line, its words on both,
 *            the outer singles above and below it: space 1 at the top, 1B and 3A between 1A and 3B;
 *            space 1 at the bottom (3 hangs above 1), 3B and 1A between 3A and 1B (slotsOf, and
 *            the half it is kept at is model quadCentreHalf).
 *   open     a blank line: tap it to fill it (the line sheet).
 *   No Stab  hatched, and nothing can go there.
 *   none     beside the last space of a panel with an odd count: not on this panel, never a line.
 *
 * TAP FIRST, LIKE THE SCHEDULE BOARD, NEVER DRAG: an open line opens the line sheet; a filled line
 * opens the circuit's own sheet; Move in that sheet, then a tap on the line it goes to, moves it.
 *
 * SUGGESTIONS (a read of the photo or the plans, or the estimate) are drawn but never count: one on
 * an open line is dimmed with its own Keep; one on a line a kept circuit already holds is the read
 * naming that breaker differently, so it sits UNDER the kept line ("Photo says: Wine Cooler") with
 * Use It and Skip. The model's warnings are said in one plain line under the door, never silent.
 * Nothing here carries a price: the crew sees this tab.
 */

/** A read's words under a kept line: a suggestion on a held space, or a label check about it. */
export type VisualNote = {
  suggestion: JobCircuit;
  /** The kept circuit the note is drawn under: Use It names it, and what its line showed. */
  target: JobCircuit;
  /** words: Use It writes its words onto the kept circuit (useSuggestedWords); check: a label
   *  check, Use It is Use What It Says (applyLabelCheck). */
  kind: "words" | "check";
  /** "Photo says", "Plans say"… */
  says: string;
  words: string;
};

export type VisualLine = StripLine & {
  /** The half this line IS in the app's terms (what a fill or a move writes), read off the circuit
   *  on it (slotsOf) and, on an open half, the half its neighbour isn't. It is the strip's `half`
   *  (where the box hangs) whenever the strip and the model agree, as they do now that slotsOf puts
   *  a 2-pole kept in a half on that half and the other half of the next space (a quad's centre);
   *  it is read, never assumed, so the two can't drift apart. */
  slotHalf: SpaceHalf | null;
  /** The kept circuit on this line. */
  circuit: JobCircuit | null;
  /** A suggestion drawn dimmed on an otherwise open line. */
  suggested: JobCircuit | null;
  /** Reads that name this line's breaker differently. */
  notes: VisualNote[];
};
export type VisualCell = { space: number; lines: VisualLine[] };
export type VisualRow = { left: VisualCell; right: VisualCell };
export type PanelVisualModel = {
  rows: VisualRow[];
  /** spaceMap's warnings about the KEPT circuits, as a person reads them. */
  warnings: string[];
  /** Suggestions drawn dimmed on an open line (their Keep is on the line). */
  dimmed: JobCircuit[];
  /** Suggestions drawn as a note under a kept line (Use It / Skip). */
  noted: JobCircuit[];
};

/** How a read's note starts, by where it came from. */
export function saysWords(source: CircuitSource): string {
  switch (source) {
    case "photo":
      return "Photo says";
    case "plan":
      return "Plans say";
    case "estimate":
      return "Estimate says";
    case "nort":
      return "Nort says";
    case "inspector":
      return "Inspection says";
    default:
      return "Suggested";
  }
}

const tidy = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

/** What a label check would change, in a few words: its door words, else what it feeds, else the size
 *  or the space, else its own sentence. */
function checkWords(check: JobCircuit): string {
  const u = check.source_row?.use ?? {};
  const words = tidy(u.panel_label) || tidy(u.description);
  if (words) return words;
  if (u.amps != null) return `${u.amps}A`;
  if (u.space != null) return `Space ${u.space}${u.half ?? ""}`;
  return tidy(check.source_row?.check);
}

/** The line a circuit or slot sits on, as a key: "9|" a whole line, "3|B" a half. */
const lineKey = (space: number, half: SpaceHalf | null) => `${space}|${half ?? ""}`;

/** The live circuits this panel draws: its own, and the loose ones that belong to it (lib/panel/held
 *  belongsToPanel: the job has one live panel, or none yet and this is Panel 1 waiting), read as
 *  this panel's, the way the server will place them. */
function onThisPanel(panel: Pick<JobPanel, "id">, circuits: JobCircuit[], livePanels: number | null | undefined): JobCircuit[] {
  return circuitsOfPanel(
    panel,
    circuits.filter((c) => !c.removed_at),
    livePanels,
  );
}

/** How many live panels the job has (the tab's own count): what decides a loose circuit's panel.
 *  Unsaid, a loose circuit is nobody's. */
export type DoorOpts = { livePanels?: number | null };

/**
 * The door as data: rows of left and right spaces, each a list of lines (one, or two on a tandem
 * space), with the suggestions placed (dimmed on an open line, a note under a held one) and the
 * kept circuits' warnings. Pure: the tab renders it, the tests read it.
 */
export function panelVisualModel(panel: JobPanel, circuits: JobCircuit[], opts: DoorOpts = {}): PanelVisualModel {
  const live = onThisPanel(panel, circuits, opts.livePanels);
  const kept = live.filter((c) => c.state === "kept");
  const keptById = new Map(kept.map((c) => [c.id, c]));
  const onDoor = kept.filter((c) => c.space != null && c.work !== "removed");
  const dead = new Set(panel.dead_spaces ?? []);
  const fitted: JobCircuit[] = [];
  const notes = new Map<string, VisualNote[]>();
  const note = (key: string, n: VisualNote) => notes.set(key, [...(notes.get(key) ?? []), n]);

  const suggestions = live.filter((c) => c.state === "suggested").sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const s of suggestions) {
    const about = s.source_row?.flag_for;
    if (about) {
      // A label check: under the first line of the kept circuit it is about, when that is drawn.
      const target = keptById.get(about);
      const first = target && target.work !== "removed" ? slotsOf(target)[0] : undefined;
      const words = checkWords(s);
      if (target && first && words) note(lineKey(first.space, first.half), { suggestion: s, target, kind: "check", says: saysWords(s.source), words });
      continue;
    }
    if (s.space == null || s.work === "removed") continue;
    // A suggestion off the end of the panel or on No Stab can't be drawn: the list keeps it, and Keep
    // there gets the database's answer in words.
    if (slotsOf(s).some((x) => (panel.spaces != null && x.space > panel.spaces) || dead.has(x.space))) continue;
    const held = heldBy(s, onDoor);
    if (held) {
      // One kept breaker there: the read names it differently. Two (a collision) is a person's to sort
      // out first, so the suggestion stays on the list.
      const words = stripWords(s);
      if (held.holders.length === 1 && words) note(lineKey(held.space, held.lineHalf), { suggestion: s, target: held.holders[0], kind: "words", says: saysWords(s.source), words });
      continue;
    }
    // Two suggestions on one open line: neither is drawn over the other; the list keeps the second.
    if (heldBy(s, fitted)) continue;
    fitted.push(s);
  }

  const fittedById = new Map(fitted.map((s) => [s.id, s]));
  const drawn = [...kept, ...fitted.map((s) => ({ ...s, state: "kept" as const }))];
  const strips = stripLines(panel, drawn);
  const used = new Set<string>();
  // The half a filled line IS, read off the circuit on it (its slot on that space), so whatever
  // order the strip hangs a space's two boxes in, a fill, a move or a note lands on the right half.
  const halfOn = (l: StripLine): SpaceHalf | null => {
    if (!l.half) return null;
    const c = l.circuitId ? (keptById.get(l.circuitId) ?? fittedById.get(l.circuitId)) : undefined;
    return (c && slotsOf(c).find((x) => x.space === l.space)?.half) ?? l.half;
  };
  const toLine = (l: StripLine, slotHalf: SpaceHalf | null): VisualLine => {
    const circuit = l.circuitId ? (keptById.get(l.circuitId) ?? null) : null;
    const suggested = l.circuitId ? (fittedById.get(l.circuitId) ?? null) : null;
    const key = lineKey(l.space, slotHalf);
    const ns = circuit ? (notes.get(key) ?? []) : [];
    if (ns.length) used.add(key);
    return { ...l, slotHalf, circuit, suggested, notes: ns };
  };
  const cells = (lines: StripLine[]): VisualCell[] => {
    const groups: StripLine[][] = [];
    for (const l of lines) {
      const last = groups[groups.length - 1];
      if (last && last[0].space === l.space) last.push(l);
      else groups.push([l]);
    }
    return groups.map((g) => {
      const halves = g.map(halfOn);
      // An open half line is the half its filled neighbour isn't.
      const filled = g.findIndex((l) => l.half && l.circuitId);
      return {
        space: g[0].space,
        lines: g.map((l, i) => {
          const h = !l.half || l.circuitId || filled < 0 ? halves[i] : halves[filled] === "A" ? "B" : "A";
          return toLine(l, h);
        }),
      };
    });
  };
  const left = cells(strips.left);
  const right = cells(strips.right);
  const rows = left.map((cell, i) => ({ left: cell, right: right[i] ?? { space: cell.space + 1, lines: [] } }));
  // A note whose line isn't drawn (its breaker shares the space in a way the strip draws as one line)
  // is not on the door: it stays on the list, never lost.
  const noted = [...notes.entries()].filter(([k]) => used.has(k)).flatMap(([, ns]) => ns.map((n) => n.suggestion));
  return { rows, warnings: stripLines(panel, kept).warnings, dimmed: fitted, noted };
}

/** What a tap on a line while moving would do: the circuit's new space and half, or the words that
 *  say why it can't go there (the target is taken, has No Stab, or runs it past the end; a 3-pole
 *  on a half line). A whole open line keeps the circuit's form (a tandem's A stays an A); an open
 *  half line makes it that half. */
export function movePlan(
  panel: JobPanel,
  circuits: JobCircuit[],
  moving: JobCircuit,
  target: { space: number; half: SpaceHalf | null },
  opts: DoorOpts = {},
): { ok: true; space: number; half: SpaceHalf | null } | { ok: false; words: string } {
  const name = circuitName(moving);
  // A 3-pole is three whole handles: it never hangs in a half (the line sheet's rule too).
  if (Number(moving.poles) >= 3 && target.half) return { ok: false, words: "A 3-pole needs three full spaces. Tap a whole open line." };
  const half = Number(moving.poles) >= 3 ? null : (target.half ?? moving.half ?? null);
  if (moving.space === target.space && (moving.half ?? null) === half && moving.panel_id === panel.id) {
    return { ok: false, words: `${name} is on space ${target.space}${half ?? ""} now. Tap the line it goes to.` };
  }
  const others = onThisPanel(panel, circuits, opts.livePanels).filter((c) => c.state === "kept" && c.id !== moving.id && c.work !== "removed");
  const there = { ...moving, panel_id: panel.id, state: "kept" as const, removed_at: null, space: target.space, half };
  const hard = spaceMap(panel, [...others, there]).warnings.filter((w) => w.circuitIds.includes(moving.id) && w.kind !== "tandem_not_allowed");
  const w = hard[0];
  if (!w) return { ok: true, space: target.space, half };
  if (w.kind === "collision") {
    const names = w.circuitIds.filter((id) => id !== moving.id).map((id) => circuitName(others.find((c) => c.id === id) ?? moving));
    return { ok: false, words: `Space ${w.space} has ${names.join(" and ")} on it. Tap an open line.` };
  }
  if (w.kind === "no_stab") return { ok: false, words: `Space ${w.space} has No Stab. Tap an open line.` };
  return { ok: false, words: `${name} would run past the end of this ${panel.spaces}-space panel. Tap an open line.` };
}

/** The words on a filled line: the door's words (else its name) and the amps. */
export function lineText(l: Pick<VisualLine, "text" | "amps" | "circuit" | "suggested">): string {
  const c = l.circuit ?? l.suggested;
  const words = l.text || (c ? circuitName(c) : "");
  return l.amps ? `${words} · ${l.amps}` : words;
}

const HATCH = "repeating-linear-gradient(135deg, rgb(226 232 240) 0 4px, rgb(248 250 252) 4px 8px)";
const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";

export function PanelVisual({
  panel,
  circuits,
  livePanels = null,
  busy = null,
  moving = null,
  onOpen,
  onFill,
  onKeep,
  onUse,
  onSkip,
  onMoveTo,
  onCancelMove,
}: {
  /** The panel drawn (a stand-in Panel 1 when the job has none yet: a fill makes the real one). */
  panel: JobPanel;
  /** Every circuit on the job: the visual picks this panel's. */
  circuits: JobCircuit[];
  /** How many live panels the job has: on its only one (or Panel 1 waiting), circuits on no panel
   *  yet are drawn too (lib/panel/held belongsToPanel). */
  livePanels?: number | null;
  /** A write is out: Keep, Use It, Skip and a move tap wait for it. */
  busy?: string | null;
  /** The circuit being moved (Move in its sheet): the next tap on a line is where it goes. */
  moving?: JobCircuit | null;
  /** A filled line (kept, or a dimmed suggestion's words): its sheet. */
  onOpen: (circuitId: string) => void;
  /** An open line: the line sheet. */
  onFill: (space: number, half: SpaceHalf | null) => void;
  onKeep: (s: JobCircuit) => void;
  onUse: (n: VisualNote) => void;
  onSkip: (s: JobCircuit) => void;
  onMoveTo: (space: number, half: SpaceHalf | null) => void;
  onCancelMove: () => void;
}) {
  const model = panelVisualModel(panel, circuits, { livePanels });
  const about = [
    panel.brand || "Brand Not Set",
    panel.spaces ? `${panel.spaces} Spaces` : "Spaces Not Set",
    panel.numbering === "bottom_up" ? "Space 1 At The Bottom" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const waiting = busy !== null;

  /**
   * A half line's TAP REACH: an invisible area a whole space tall (SPACE_PX) that starts at the line
   * and runs outward — the top half (A) up, the bottom half (B) down — UNDER every drawn line and
   * note (they sit a layer above it), so a tap off the 22px line still reaches it and can never take
   * a tap meant for a line drawn there. Not a second control: the line itself is the one a screen
   * reader hears.
   */
  const reach = (l: VisualLine, act: (() => void) | null) =>
    l.half && act ? (
      <span
        aria-hidden
        data-reach={l.half}
        onClick={act}
        className="absolute inset-x-0 z-0"
        style={{ height: SPACE_PX, top: l.half === "A" ? -HALF_LINE_PX : 0 }}
      />
    ) : null;

  const line = (l: VisualLine, side: "left" | "right") => {
    const half = !!l.half;
    const h = half ? HALF_LINE_H : SPACE_H;
    // In the app's terms (the half a fill or a move writes), which the sheets and the list say too.
    const where = `Space ${l.space}${l.slotHalf ?? ""}`;
    const tap = (fallback: () => void) => () => (moving ? onMoveTo(l.space, l.slotHalf) : fallback());
    const off = !!moving && waiting;
    if (l.kind === "none") {
      // Beside an odd panel's last space: not on this panel. Nothing to fill, nothing to tap.
      return (
        <div data-line="none" className={cn(SPACE_H, "flex items-center justify-center rounded text-[10px] text-slate-400")}>
          Not on this panel
        </div>
      );
    }
    if (l.kind === "dead") {
      return moving ? (
        <button
          type="button"
          onClick={() => onMoveTo(l.space, l.slotHalf)}
          disabled={waiting}
          data-line="dead"
          className={cn(SPACE_H, "relative z-[1] flex w-full items-center justify-center rounded border border-slate-300 text-[10px] font-semibold uppercase tracking-wide text-slate-500")}
          style={{ backgroundImage: HATCH }}
        >
          No Stab
        </button>
      ) : (
        <div
          data-line="dead"
          className={cn(SPACE_H, "flex items-center justify-center rounded border border-slate-300 text-[10px] font-semibold uppercase tracking-wide text-slate-500")}
          style={{ backgroundImage: HATCH }}
        >
          No Stab
        </div>
      );
    }
    if (l.suggested) {
      const s = l.suggested;
      const from = sourceWords(s);
      const open = tap(() => onOpen(s.id));
      return (
        <>
          {reach(l, off ? null : open)}
          {/* The dashed edge is an outline, not a border, so the line is exactly its buttons' height. */}
          <div data-line="suggested" className="relative z-[1] flex min-w-0 items-stretch rounded bg-slate-50 opacity-80 outline-dashed outline-1 -outline-offset-1 outline-slate-300">
            <button
              type="button"
              onClick={open}
              disabled={off}
              {...(half ? { "data-half-line": "" } : {})}
              className={cn("min-w-0 flex-1 truncate px-1.5 text-slate-500", h, half ? "text-[11px] leading-none" : "text-xs", side === "right" ? "text-right" : "text-left")}
            >
              <span className="sr-only">
                {where}, Suggested{from ? ` ${from}` : ""}:{" "}
              </span>
              {lineText(l)}
            </button>
            {!moving && (
              <button
                type="button"
                onClick={() => onKeep(s)}
                disabled={waiting}
                {...(half ? { "data-half-line": "" } : {})}
                className={cn(h, "shrink-0 rounded px-2 text-[11px] font-semibold text-[rgb(var(--glass-ink))] hover:bg-white disabled:opacity-50")}
              >
                Keep
              </button>
            )}
          </div>
        </>
      );
    }
    if (l.circuit) {
      const c = l.circuit;
      const multi = l.kind === "pole2" || l.kind === "pole3";
      const isMoving = moving?.id === c.id;
      const open = tap(() => onOpen(c.id));
      return (
        <>
          {reach(l, off ? null : open)}
          <button
            type="button"
            onClick={open}
            disabled={off}
            aria-label={`${where}: ${lineText(l)}`}
            data-line={l.kind}
            {...(half ? { "data-half-line": "" } : {})}
            className={cn(
              h,
              "relative z-[1] flex w-full min-w-0 items-center rounded border border-slate-300 bg-white px-1.5 hover:border-[rgb(var(--glass-ink))]",
              side === "right" ? "justify-end text-right" : "text-left",
              // A 2- or 3-pole's lines carry a tie on the bus side, so its two (or three) read as one breaker.
              multi && (side === "left" ? "border-r-[3px] border-r-[rgb(var(--glass-ink))]" : "border-l-[3px] border-l-[rgb(var(--glass-ink))]"),
              isMoving && "ring-2 ring-amber-400",
            )}
          >
            <span className={cn("truncate font-medium text-slate-900", half ? "text-[11px] leading-none" : "text-xs")}>{lineText(l)}</span>
          </button>
        </>
      );
    }
    const fill = tap(() => onFill(l.space, l.slotHalf));
    return (
      <>
        {reach(l, off ? null : fill)}
        <button
          type="button"
          onClick={fill}
          disabled={off}
          aria-label={`${where} is open. Tap to fill it.`}
          data-line="empty"
          {...(half ? { "data-half-line": "" } : {})}
          className={cn(
            h,
            "relative z-[1] flex w-full items-center justify-center rounded border border-dashed border-slate-300 text-slate-300 hover:border-[rgb(var(--glass-ink))] hover:text-[rgb(var(--glass-ink))]",
            moving && "border-amber-300 bg-amber-50/50",
          )}
        >
          <Plus className={half ? "h-3 w-3" : "h-4 w-4"} />
        </button>
      </>
    );
  };

  const notesOf = (l: VisualLine) =>
    l.notes.map((n) => (
      <div key={`note:${n.suggestion.id}`} data-note={n.kind} className="relative z-[1] rounded border border-amber-300 bg-amber-50 p-1 text-[11px] text-amber-900">
        <p className="break-words px-0.5">
          {n.says}: {n.words}
        </p>
        <div className="mt-1 grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onUse(n)}
            disabled={waiting}
            className="min-h-[44px] rounded bg-[rgb(var(--glass-ink))] px-1 text-xs font-semibold text-white disabled:opacity-50"
          >
            Use It
          </button>
          <button
            type="button"
            onClick={() => onSkip(n.suggestion)}
            disabled={waiting}
            className="min-h-[44px] rounded border border-amber-300 bg-white px-1 text-xs font-semibold text-amber-900 disabled:opacity-50"
          >
            Skip
          </button>
        </div>
      </div>
    ));

  const cell = (c: VisualCell, side: "left" | "right") => {
    // The cell beside an odd panel's last space carries no number: it isn't a space of this panel.
    const none = c.lines.length > 0 && c.lines.every((l) => l.kind === "none");
    return (
      <div className={cn("flex min-w-0 items-start gap-1 py-0.5", side === "right" && "flex-row-reverse")}>
        {none ? (
          <span className={cn(SPACE_H, "w-5 shrink-0")} aria-hidden />
        ) : (
          <span className={cn(SPACE_H, "flex w-5 shrink-0 items-center justify-center font-mono text-[11px] text-slate-500")} data-space={c.space}>
            {c.space}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {c.lines.map((l) => (
            <div key={`${l.space}${l.half ?? ""}`} className="relative flex min-w-0 flex-col gap-0.5">
              {line(l, side)}
              {notesOf(l)}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <section className={card} aria-label={`${panel.name}: The Door`}>
      {/* The main breaker at the top, the way the box has it, and what the box is. */}
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="rounded-md border border-slate-400 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800">
          {panel.main_amps ? `${panel.main_amps}A Main` : "Main Not Set"}
        </span>
        <span className="text-[11px] text-slate-500">{about}</span>
      </div>
      {panel.spaces == null && <p className="mt-2 text-center text-xs text-slate-500">Set the spaces on Edit Panel to see the whole door.</p>}

      {moving && (
        // Above the door's tap reach (a half line's reaches up a little way past the first row).
        <div role="status" className="relative z-[1] mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 text-sm text-amber-900">
          <span className="min-w-0 flex-1 py-2">Moving {circuitName(moving)}. Tap the line it goes to.</span>
          <button type="button" onClick={onCancelMove} className="min-h-[44px] shrink-0 rounded-lg px-3 text-sm font-semibold hover:bg-white">
            Cancel
          </button>
        </div>
      )}

      {/* Left column, the bus, right column: one row per pair of spaces, so a tandem's two lines on
          one side line up with the whole line beside it. */}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_6px_minmax(0,1fr)] gap-x-1" data-door="">
        {model.rows.map((r) => (
          <div key={`${r.left.space}-${r.right.space}`} className="contents">
            {cell(r.left, "left")}
            <div className="bg-slate-300" aria-hidden />
            {cell(r.right, "right")}
          </div>
        ))}
      </div>

      {model.warnings.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {model.warnings.join(" ")}
        </p>
      )}
    </section>
  );
}
