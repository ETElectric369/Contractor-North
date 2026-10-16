import type { RoomScan, SiteScan } from "@/lib/native-scan";
import { cornerLetter, roomPlanSvg, sideLabel, sitePlanSvg } from "./plan-svg";

/**
 * WHAT A SCAN LANDS ON THE SHEET (LiDAR rung 2): the measurement rows, the plan drawing and the
 * caption the plan wears. Pure, so the Inspector only places it and a test reads it.
 *
 * ROWS ARE WHAT WAS MEASURED, NAMED NEUTRALLY (the no-speculation law): a site is its area, its
 * perimeter and every side between two lettered corners; a room is every wall, the tallest wall
 * (said as that, never "the ceiling": a gable), the floor area where iOS gave one, and the doors
 * and windows RoomPlan counted. He renames any row in
 * its label box; a kit sizes itself from the rows it reads (sq ft of decking, lf of railing).
 */
export type LandingRow = { label: string; value: number; unit: string };

export type ScanLanding = {
  rows: LandingRow[];
  svg: string;
  /** The plan picture's caption: the headline figures. */
  caption: string;
  /** What the pictures are "about" (photo_meta.about): the door that made them. */
  about: string;
  /** The plan file's base name (no extension). */
  name: string;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

function dateWords(when: Date): string {
  return when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function scanLanding(r: SiteScan | RoomScan, when = new Date()): ScanLanding {
  const date = dateWords(when);
  const stamp = when.getTime();
  if (r.kind === "site") {
    const n = r.sides.length;
    const rows: LandingRow[] = [
      { label: "Site area", value: r.area, unit: "sq ft" },
      { label: "Site perimeter", value: r.perimeter, unit: "ft" },
      ...r.sides.map((s, i) => ({ label: `Side ${cornerLetter(i)}–${cornerLetter((i + 1) % n)}`, value: s, unit: "ft" })),
    ];
    const title = `Site plan — ${date}`;
    return {
      rows,
      svg: sitePlanSvg({ title, corners: r.corners, sides: r.sides, area: r.area, perimeter: r.perimeter }),
      caption: `Site plan — ${r1(r.area)} sq ft, ${sideLabel(r.perimeter)} around`,
      about: "Scan The Site",
      name: `site-plan-${stamp}`,
    };
  }
  const rows: LandingRow[] = r.walls.map((w, i) => ({ label: `Wall ${i + 1}`, value: w.length, unit: "ft" }));
  if (r.tallestWall !== null) rows.push({ label: "Tallest wall", value: r.tallestWall, unit: "ft" });
  if (r.floorArea !== null) rows.push({ label: "Floor area", value: r.floorArea, unit: "sq ft" });
  if (r.doors > 0) rows.push({ label: "Doors", value: r.doors, unit: "each" });
  if (r.windows > 0) rows.push({ label: "Windows", value: r.windows, unit: "each" });
  const title = `Room plan — ${date}`;
  const bits = [`${r.walls.length} wall${r.walls.length === 1 ? "" : "s"}`];
  if (r.floorArea !== null) bits.push(`${r1(r.floorArea)} sq ft`);
  if (r.tallestWall !== null) bits.push(`${sideLabel(r.tallestWall)} tallest wall`);
  return {
    rows,
    svg: roomPlanSvg({ title, walls: r.walls, floorCorners: r.floorCorners, floorArea: r.floorArea, tallestWall: r.tallestWall, doors: r.doors, windows: r.windows }),
    caption: `Room plan — ${bits.join(", ")}`,
    about: "Scan The Room",
    name: `room-plan-${stamp}`,
  };
}
