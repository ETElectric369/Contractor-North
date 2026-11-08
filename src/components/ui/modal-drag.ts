/**
 * A SHEET YOU CAN MOVE OUT OF THE WAY (Erik, 2026-11-07: "could we make it so all pop-up boxes can be moved
 * around on screen by dragging them so i can see relevant information in the background? that would be
 * amazing everywhere actually"). Every pop-up in the app is the one Modal (components/ui/modal), so the
 * drag is written once, here, as rules with no DOM in them; the component wires the pointer to them.
 *
 *   clampOffset    where the panel may go: anywhere inside the viewport with a margin on every side, so a
 *                  sheet dragged hard left stops at the edge instead of leaving the screen. A panel wider
 *                  or taller than the room covers the room and slides only as far as its far edge allows.
 *   pastThreshold  a tap is not a drag: the pointer has to travel (3px) before the sheet moves.
 *   isDragTarget   the title bar moves the sheet; a control inside it (the X) keeps its own job.
 */
export type Offset = { x: number; y: number };

/** The panel's box as getBoundingClientRect reports it, in the viewport's own coordinates. */
export type PanelRect = { left: number; top: number; width: number; height: number };
export type Viewport = { width: number; height: number };

/**
 * The offset the panel may have. `panel` is the panel's rect as it is measured NOW, while it already sits at
 * offset `have`; its place at offset 0 is worked out from that first, then `want` is clamped so the panel at
 * the new offset keeps `margin` to every side of `viewport`. When the panel is wider (or taller) than the
 * room between the margins, its left (top) edge may sit anywhere between `viewport − margin − size` and
 * `margin`: it covers the viewport and never drifts out of it.
 */
export function clampOffset(want: Offset, panel: PanelRect, have: Offset, viewport: Viewport, margin = 8): Offset {
  return {
    x: clampAxis(want.x, panel.left - have.x, panel.width, viewport.width, margin),
    y: clampAxis(want.y, panel.top - have.y, panel.height, viewport.height, margin),
  };
}

/** One axis: `at0` is the edge the panel has at offset 0; the edge at the new offset stays between the two limits. */
function clampAxis(want: number, at0: number, size: number, room: number, margin: number): number {
  const nearLimit = margin;
  const farLimit = room - margin - size;
  // A panel that fits: [margin, room − margin − size]. One that does not: the same two numbers, the other way round.
  const lo = Math.min(nearLimit, farLimit);
  const hi = Math.max(nearLimit, farLimit);
  const edge = Math.min(hi, Math.max(lo, at0 + want));
  return edge - at0;
}

/** A tap is not a drag: true once the pointer has travelled more than `px` from where it went down. */
export function pastThreshold(start: Offset, now: Offset, px = 3): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) > px;
}

/** The elements whose own job a pointer-down is: the X, a link, a field. */
const CONTROL_TAGS: ReadonlySet<string> = new Set(["button", "a", "input", "select", "textarea"]);

/** What this reads of an element: enough for a browser's Element and for a test's plain-object stand-in. */
type ElementLike = { tagName?: string; parentElement: ElementLike | null; getAttribute?: (name: string) => string | null };

/**
 * True when the pointer went down on the handle itself or on plain text inside it (the title); false when it
 * went down inside a button, a link, an input, a select, a textarea or anything with role="button" — so the X
 * still closes and nothing inside the title bar stops working — and false for anything outside the handle.
 */
export function isDragTarget(target: EventTarget | null, handle: Element): boolean {
  let node = target && typeof target === "object" && "parentElement" in target ? (target as ElementLike) : null;
  while (node) {
    if (node === (handle as ElementLike)) return true;
    if (isControl(node)) return false;
    node = node.parentElement;
  }
  return false;
}

function isControl(node: ElementLike): boolean {
  if (CONTROL_TAGS.has((node.tagName ?? "").toLowerCase())) return true;
  return typeof node.getAttribute === "function" && node.getAttribute("role") === "button";
}
