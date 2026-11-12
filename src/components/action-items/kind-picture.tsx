import {
  BookOpen,
  CalendarPlus,
  CircleDollarSign,
  CirclePause,
  ClipboardCheck,
  Clock,
  FilePenLine,
  FolderInput,
  HandCoins,
  Hourglass,
  Inbox,
  Package,
  Percent,
  Phone,
  Receipt,
  ReceiptText,
  Scale,
  Send,
  ShoppingCart,
  Stamp,
  TrendingUp,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { KIND_PICTURE, type PictureId } from "@/lib/action-items/kind-picture";
import type { ActionKind, Group, Level } from "@/lib/action-items/types";

/**
 * THE PICTURES OF NEEDS YOU (cn-v1162, the owner's design, 2026-11-11: "the big tiles get a picture
 * with color and the smaller tiles that drop down get a picture with no color until they get an alert
 * then they get a colored in picture next to the alert"; shown a mock, "lets go with that").
 *
 * Every picture is decorative (aria-hidden): the row's words, its button and the tile's name already
 * say it, so no catalog word is needed. Colour is never the only signal: every picture is a different
 * shape, and every tile keeps its name.
 *
 * NO RED, NO AMBER HERE. Red and amber mean urgency and live only in level-mark.tsx (a test scans the
 * folder). A marked row's picture takes its TILE's colour, so in the Act Today strip the picture says
 * which tile a row belongs to while the mark beside it says how soon.
 */

/** Each kind of action's icon (the ids: lib/action-items/kind-picture). `FilePenLine`, never its
 *  deprecated alias `FileSignature`. */
export const PICTURE_ICON: Record<PictureId, LucideIcon> = {
  pick_day: CalendarPlus,
  call: Phone,
  waiting: Hourglass,
  visit: ClipboardCheck,
  send: Send,
  sign: FilePenLine,
  collect: HandCoins,
  bill: ReceiptText,
  deadline: Scale,
  buy: ShoppingCart,
  hold: CirclePause,
  hours: Clock,
  permit: Stamp,
  cost: Receipt,
  stock: Package,
  sort: FolderInput,
  papers: Inbox,
  discount: Percent,
};

/** Each tile's icon: Get Paid, Sales, Operations, Bookkeeping. */
export const GROUP_ICON: Record<Group, LucideIcon> = {
  get_paid: CircleDollarSign,
  win_work: TrendingUp,
  run_jobs: Wrench,
  keep_books: BookOpen,
};

/**
 * THE ONE PLACE A TILE'S COLOUR LIVES: a pale chip and a darker ink, both literal strings so Tailwind
 * sees them. Red, amber, orange, yellow, pink and the brand colour are never a tile's (the brand may be
 * red or amber, and those mean urgency here); kind-picture.test.ts pins it.
 */
export const GROUP_TINT: Record<Group, { ink: string; chip: string }> = {
  get_paid: { ink: "text-lime-800", chip: "bg-lime-100" },
  win_work: { ink: "text-sky-700", chip: "bg-sky-100" },
  run_jobs: { ink: "text-violet-700", chip: "bg-violet-100" },
  keep_books: { ink: "text-teal-700", chip: "bg-teal-100" },
};

/** The plain picture: grey with no chip. slate-500, never 400 (2.6:1 on white is too faint: a pin). */
export const PLAIN_PICTURE = "text-slate-500";

/**
 * THE ONE RULE FOR A ROW PICTURE'S COLOUR, so the owner can flip it in one place: a row that carries a
 * mark (now or soon) and is not done is "coloured in" with its tile's chip and ink; anything else is
 * plain. Null: plain.
 */
export function pictureTint(group: Group, level: Level | null | undefined, done = false): { ink: string; chip: string } | null {
  return (level === "now" || level === "soon") && !done ? GROUP_TINT[group] : null;
}

/** The fixed slot every row's picture sits in: 24px round, so the words of every row start at one x. */
const SLOT = "flex h-6 w-6 shrink-0 items-center justify-center rounded-full";

/**
 * A ROW'S PICTURE, in its own column right after the mark. `kind={null}` draws the EMPTY slot (a
 * Couldn't Check line asks for no action, so it has no picture, the way it has no mark).
 */
export function KindPicture({ kind, group, level, done = false }: { kind: ActionKind | null; group: Group; level: Level | null | undefined; done?: boolean }) {
  if (kind === null) return <span aria-hidden="true" data-picture-slot="" className={SLOT} />;
  const picture = KIND_PICTURE[kind];
  const Icon = PICTURE_ICON[picture];
  const tint = pictureTint(group, level, done);
  return (
    <span aria-hidden="true" data-picture-slot="" data-picture={picture} data-tint={tint ? group : undefined} className={`${SLOT} ${tint ? `${tint.chip} ${tint.ink}` : PLAIN_PICTURE}`}>
      <Icon aria-hidden="true" className="h-4 w-4" />
    </span>
  );
}

/**
 * ANY TILE'S PICTURE, left of its name: 28px round with an 18px icon, hidden from a screen reader (the
 * tile's name says it). `group` lends it that tile colour's chip and ink (the Inspections page's open
 * tiles wear Sales'); null draws it plain, grey on a pale grey chip. `data-group-picture` is carried
 * through for Needs You's own tiles, whose tests find a tile's picture by it.
 */
export function TilePicture({ icon: Icon, group, "data-group-picture": groupPicture }: { icon: LucideIcon; group: Group | null; "data-group-picture"?: Group }) {
  const look = group ? `${GROUP_TINT[group].chip} ${GROUP_TINT[group].ink}` : `bg-slate-100 ${PLAIN_PICTURE}`;
  return (
    <span aria-hidden="true" data-group-picture={groupPicture} data-tint={group ?? undefined} className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${look}`}>
      <Icon aria-hidden="true" className="h-[18px] w-[18px]" />
    </span>
  );
}

/** A NEEDS YOU TILE'S PICTURE: its group's icon, always in the tile's colour. */
export function GroupPicture({ group }: { group: Group }) {
  return <TilePicture icon={GROUP_ICON[group]} group={group} data-group-picture={group} />;
}
