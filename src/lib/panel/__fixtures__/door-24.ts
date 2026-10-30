/**
 * A 24-SPACE SIEMENS DOOR, AS THE PHOTO READER SHOULD SEE IT (the panel-first wave, P2).
 *
 * It mirrors a real door's layout with stand-in words: 34 circuits on 24 spaces. Three QUADS, whose
 * centre 2-poles are Floor Heat (1B + 3A), Dryer (13B + 15A) and TVSS (2B + 4A); two full-width
 * 2-POLES, Mini Split (9 + 11) and EV Charger (6 + 8); one full-width SINGLE, Laundry (19); every
 * other space a TANDEM, half A over half B. "Garage" is on the door twice (the first quad's two
 * outer singles, 1A and 3B): two circuits, never one. Spaces 20 and 24 are empty.
 *
 * DOOR_24_REPLY is the model's answer the way PHOTO_SYSTEM asks for it: ONE LINE PER HANDLE, the
 * left column top to bottom and then the right (the order a person reads a door), a 2-pole's words
 * on both of its lines. DOOR_24 is what that answer is once parsed: one row per breaker, in space
 * order, a 2-pole at its first space (a quad's centre at half B).
 */
import type { SpaceHalf } from "@/lib/types";

type ReplyLine = { space: number; half: SpaceHalf | null; poles: 1 | 2; amps: number | null; label: string | null; kind?: string | null };

const t = (space: number, a: string | null, b: string | null, amps = 20): ReplyLine[] => [
  { space, half: "A", poles: 1, amps, label: a },
  { space, half: "B", poles: 1, amps, label: b },
];
/** A quad on spaces s and s+2: outer singles at sA and (s+2)B, the centre 2-pole at sB and (s+2)A. */
const quad = (s: number, top: string, centre: string, bottom: string, centreAmps: number, centreKind: string | null = null): ReplyLine[] => [
  { space: s, half: "A", poles: 1, amps: 20, label: top },
  { space: s, half: "B", poles: 2, amps: centreAmps, label: centre, kind: centreKind },
  { space: s + 2, half: "A", poles: 2, amps: centreAmps, label: centre, kind: centreKind },
  { space: s + 2, half: "B", poles: 1, amps: 20, label: bottom },
];
const pole2 = (s: number, label: string, amps: number): ReplyLine[] => [
  { space: s, half: null, poles: 2, amps, label },
  { space: s + 2, half: null, poles: 2, amps, label },
];

const LEFT: ReplyLine[] = [
  ...quad(1, "Garage", "Floor Heat", "Garage", 20),
  ...t(5, "Storage Rm", "Holiday"),
  ...t(7, "Workbench", "Mudroom"),
  ...pole2(9, "Mini Split", 20),
  ...quad(13, "Entry Kitchen Living", "Dryer", "Bath Lights", 30),
  ...t(17, "Bar", "Mini Fridge"),
  { space: 19, half: null, poles: 1, amps: 20, label: "Laundry" },
  ...t(21, "Kitchen GFCI Rt", "Bed West Wall"),
  ...t(23, "Bath GFI", "Living N"),
];
const RIGHT: ReplyLine[] = [
  ...quad(2, "GDO 1", "TVSS", "GDO 2", 20, "spd"),
  ...pole2(6, "EV Charger", 50),
  ...t(10, "Garage Lights", "Mudroom Lights", 15),
  ...t(12, "Storage Lights", "Smoke/CO2", 15),
  ...t(14, "TV/Ent", "Wine Cooler"),
  ...t(16, "Office 1", "Office 2"),
  ...t(18, "Stair", "Disposal"),
  ...t(22, "Kit GFCI Left", "Living"),
];

export const DOOR_24_REPLY = {
  panel: { brand: "Siemens", main_amps: 200, spaces: 24 },
  lines: [...LEFT, ...RIGHT],
  unreadable: [] as string[],
};

/** What the reply parses to: [space, half, poles, words] per breaker, in space order. */
export const DOOR_24: [number, SpaceHalf | null, number, string | null][] = [
  [1, "A", 1, "Garage"],
  [1, "B", 2, "Floor Heat"],
  [2, "A", 1, "GDO 1"],
  [2, "B", 2, "TVSS"],
  [3, "B", 1, "Garage"],
  [4, "B", 1, "GDO 2"],
  [5, "A", 1, "Storage Rm"],
  [5, "B", 1, "Holiday"],
  [6, null, 2, "EV Charger"],
  [7, "A", 1, "Workbench"],
  [7, "B", 1, "Mudroom"],
  [9, null, 2, "Mini Split"],
  [10, "A", 1, "Garage Lights"],
  [10, "B", 1, "Mudroom Lights"],
  [12, "A", 1, "Storage Lights"],
  [12, "B", 1, "Smoke/CO2"],
  [13, "A", 1, "Entry Kitchen Living"],
  [13, "B", 2, "Dryer"],
  [14, "A", 1, "TV/Ent"],
  [14, "B", 1, "Wine Cooler"],
  [15, "B", 1, "Bath Lights"],
  [16, "A", 1, "Office 1"],
  [16, "B", 1, "Office 2"],
  [17, "A", 1, "Bar"],
  [17, "B", 1, "Mini Fridge"],
  [18, "A", 1, "Stair"],
  [18, "B", 1, "Disposal"],
  [19, null, 1, "Laundry"],
  [21, "A", 1, "Kitchen GFCI Rt"],
  [21, "B", 1, "Bed West Wall"],
  [22, "A", 1, "Kit GFCI Left"],
  [22, "B", 1, "Living"],
  [23, "A", 1, "Bath GFI"],
  [23, "B", 1, "Living N"],
];
