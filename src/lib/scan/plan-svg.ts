import { feetInches } from "@/lib/native-measure";

/**
 * THE PLAN DRAWING (LiDAR rung 2). A scan's corners or walls, in feet, drawn TO SCALE as an SVG:
 * every side labeled in feet and inches, the corners lettered in walking order, a scale bar, and a
 * footer with the area and the perimeter. Pure — no DOM — so the Inspector rasterises it (plan-image)
 * and a test reads it. Erik's text-to-visual law: the figures live INSIDE the picture of the thing.
 *
 * ONLY WHAT WAS MEASURED. A site plan is the tapped corners; a room plan is RoomPlan's walls (and
 * the floor outline when iOS gave one). Nothing is squared up, straightened or guessed.
 */

export type PlanPoint = { x: number; y: number };

export const PLAN_WIDTH = 1400;
export const PLAN_HEIGHT = 1000;
const MARGIN = 120;
const FOOTER = 90;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** The letter a corner wears, in walking order (A, B, C … then AA, AB …). */
export function cornerLetter(i: number): string {
  const n = LETTERS.length;
  return i < n ? LETTERS[i] : LETTERS[Math.floor(i / n) - 1] + LETTERS[i % n];
}

export type SitePlanInput = {
  title: string;
  corners: PlanPoint[];
  /** Side i runs corner i → corner i+1 (the last closes back to A). */
  sides: number[];
  area: number;
  perimeter: number;
};

export type RoomPlanInput = {
  title: string;
  walls: Array<{ length: number; a: PlanPoint; b: PlanPoint }>;
  floorCorners: PlanPoint[] | null;
  floorArea: number | null;
  tallestWall: number | null;
  doors: number;
  windows: number;
};

type Fit = { scale: number; ox: number; oy: number };

/** Feet → page pixels so the whole figure sits inside the margins, same scale both ways. */
export function fitPlan(points: PlanPoint[], width = PLAN_WIDTH, height = PLAN_HEIGHT): Fit {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 0.5);
  const h = Math.max(maxY - minY, 0.5);
  const scale = Math.min((width - 2 * MARGIN) / w, (height - 2 * MARGIN - FOOTER) / h);
  const ox = (width - w * scale) / 2 - minX * scale;
  const oy = (height - FOOTER - h * scale) / 2 - minY * scale;
  return { scale, ox, oy };
}

const px = (f: Fit, p: PlanPoint) => ({ x: f.ox + p.x * f.scale, y: f.oy + p.y * f.scale });
const r1 = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "12 ft 3 in" from feet; a side under an inch reads as inches. */
export function sideLabel(ft: number): string {
  return feetInches(ft);
}

/** Twice the signed area of a polygon (the shoelace sum): its sign is the winding. */
export function winding(points: PlanPoint[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

const LABEL_FONT = 26;
/** About how wide a label is on the page (a sans digit or letter is ~0.55 em). */
const labelWidth = (label: string) => label.length * LABEL_FONT * 0.55;

/**
 * A side's label sits OUTSIDE the figure at the side's middle: pushed along the outward normal far
 * enough that none of the text crosses the edge (a wide label beside a near-vertical side needs
 * half its width of room, a label under a flat side only half its height). `outward` is the unit
 * normal that points away from the figure for this side — a polygon's winding gives it (skeptic
 * #17: a centroid guess puts the notch sides of an L-shaped deck inside it).
 */
function sideText(f: Fit, a: PlanPoint, b: PlanPoint, label: string, outward: { x: number; y: number }): string {
  const pa = px(f, a), pb = px(f, b);
  const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
  const { x: nx, y: ny } = outward;
  const off = 14 + Math.abs(nx) * (labelWidth(label) / 2) + Math.abs(ny) * (LABEL_FONT / 2);
  const tx = mx + nx * off, ty = my + ny * off;
  return `<text x="${r1(tx)}" y="${r1(ty)}" text-anchor="middle" dominant-baseline="middle" font-size="${LABEL_FONT}" font-weight="600" fill="#0f172a">${esc(label)}</text>`;
}

/** The unit normal of a → b on the page that points away from a polygon of the given winding. */
export function outwardNormal(a: PlanPoint, b: PlanPoint, wind: number): { x: number; y: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // For a positive shoelace sum the outside is on the right-hand side of each edge.
  return wind >= 0 ? { x: dy / len, y: -dx / len } : { x: -dy / len, y: dx / len };
}

/** For a lone segment (a wall): the normal that points away from a reference point. */
function awayFrom(a: PlanPoint, b: PlanPoint, from: PlanPoint): { x: number; y: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  if ((mx - from.x) * nx + (my - from.y) * ny < 0) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}

function scaleBar(f: Fit, width: number, height: number): string {
  // 10 ft, or 1 ft when the figure is small.
  const feet = f.scale * 10 < width / 3 ? 10 : 1;
  const w = feet * f.scale;
  const x = MARGIN, y = height - FOOTER + 10;
  return `<g stroke="#0f172a" stroke-width="3"><line x1="${x}" y1="${y}" x2="${r1(x + w)}" y2="${y}"/><line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y + 8}"/><line x1="${r1(x + w)}" y1="${y - 8}" x2="${r1(x + w)}" y2="${y + 8}"/></g><text x="${r1(x + w / 2)}" y="${y + 32}" text-anchor="middle" font-size="22" fill="#334155">${feet} ft</text>`;
}

function frame(title: string, body: string, footer: string, width = PLAN_WIDTH, height = PLAN_HEIGHT): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Helvetica, Arial, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${MARGIN}" y="64" font-size="34" font-weight="700" fill="#0f172a">${esc(title)}</text>`,
    body,
    `<text x="${width - MARGIN}" y="${height - FOOTER + 40}" text-anchor="end" font-size="26" fill="#0f172a">${esc(footer)}</text>`,
    `</svg>`,
  ].join("");
}

function centroidOf(points: PlanPoint[]): PlanPoint {
  const n = points.length || 1;
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
}

/** A site: the footprint polygon, every side labeled, the corners lettered. */
export function sitePlanSvg(input: SitePlanInput): string {
  const { corners, sides } = input;
  if (corners.length < 3) throw new Error("a site plan needs three corners");
  const f = fitPlan(corners);
  const c = centroidOf(corners);
  const wind = winding(corners);
  const pts = corners.map((p) => px(f, p));
  const poly = `<polygon points="${pts.map((p) => `${r1(p.x)},${r1(p.y)}`).join(" ")}" fill="#e0f2fe" stroke="#0f172a" stroke-width="4" stroke-linejoin="round"/>`;
  const labels = corners
    .map((a, i) => {
      const b = corners[(i + 1) % corners.length];
      const len = sides[i];
      return typeof len === "number" ? sideText(f, a, b, sideLabel(len), outwardNormal(a, b, wind)) : "";
    })
    .join("");
  const letters = pts
    .map((p, i) => {
      const away = { x: p.x - (f.ox + c.x * f.scale), y: p.y - (f.oy + c.y * f.scale) };
      const d = Math.hypot(away.x, away.y) || 1;
      const lx = p.x + (away.x / d) * 34, ly = p.y + (away.y / d) * 34;
      return `<circle cx="${r1(p.x)}" cy="${r1(p.y)}" r="7" fill="#0f172a"/><text x="${r1(lx)}" y="${r1(ly)}" text-anchor="middle" dominant-baseline="middle" font-size="24" font-weight="700" fill="#0369a1">${cornerLetter(i)}</text>`;
    })
    .join("");
  const footer = `Area ${r1(input.area)} sq ft · ${sideLabel(input.perimeter)} around`;
  return frame(input.title, poly + labels + letters + scaleBar(f, PLAN_WIDTH, PLAN_HEIGHT), footer);
}

/** A room: the walls as thick segments, each labeled; the floor outline shaded when iOS gave one. */
export function roomPlanSvg(input: RoomPlanInput): string {
  const { walls } = input;
  if (!walls.length) throw new Error("a room plan needs a wall");
  const all = walls.flatMap((w) => [w.a, w.b]).concat(input.floorCorners ?? []);
  const f = fitPlan(all);
  const c = centroidOf(all);
  const floor = input.floorCorners
    ? `<polygon points="${input.floorCorners.map((p) => px(f, p)).map((p) => `${r1(p.x)},${r1(p.y)}`).join(" ")}" fill="#f1f5f9" stroke="none"/>`
    : "";
  const segs = walls
    .map((w) => {
      const a = px(f, w.a), b = px(f, w.b);
      return `<line x1="${r1(a.x)}" y1="${r1(a.y)}" x2="${r1(b.x)}" y2="${r1(b.y)}" stroke="#0f172a" stroke-width="10" stroke-linecap="round"/>`;
    })
    .join("");
  const labels = walls.map((w, i) => sideText(f, w.a, w.b, `${i + 1}: ${sideLabel(w.length)}`, awayFrom(w.a, w.b, c))).join("");
  const bits: string[] = [];
  if (input.floorArea !== null) bits.push(`Floor ${r1(input.floorArea)} sq ft`);
  // The tallest wall RoomPlan saw — said as that, not as "the ceiling" (a gable, a stair wall).
  if (input.tallestWall !== null) bits.push(`Tallest wall ${sideLabel(input.tallestWall)}`);
  bits.push(`${input.doors} door${input.doors === 1 ? "" : "s"}`, `${input.windows} window${input.windows === 1 ? "" : "s"}`);
  return frame(input.title, floor + segs + labels + scaleBar(f, PLAN_WIDTH, PLAN_HEIGHT), bits.join(" · "));
}
