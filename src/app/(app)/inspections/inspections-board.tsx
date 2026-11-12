"use client";

import { useId, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, CalendarPlus, CalendarX, CircleCheck, CircleHelp, CircleX, ClipboardCheck, type LucideIcon } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { TileGrid, type GridTile } from "@/components/ui/tile-grid";
import { Card } from "@/components/ui/card";
import { TilePicture } from "@/components/action-items/kind-picture";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { openFirstTile, type InspectionTile, type InspectionsView } from "@/lib/inspections";
import type { BoardRow, BoardTile, RowMenu } from "./board-types";
import { InspectionRowMenu } from "./inspection-row-menu";

/**
 * Each tile's picture. Write Up wears the picture a write-up row wears in Needs You, and Needs a Day
 * Needs You's pick-a-day picture, so one thing to do looks the same on both screens.
 */
const TILE_ICON: Record<InspectionTile, LucideIcon> = {
  write_up: ClipboardCheck,
  coming_up: CalendarClock,
  needs_day: CalendarPlus,
  missed: CircleHelp,
  completed: CircleCheck,
  lost: CircleX,
  cancelled: CalendarX,
};

/** True when a row's ⋯ has anything to offer (the menu draws nothing otherwise, so neither does its line). */
function hasMenu(menu: RowMenu | null): boolean {
  return !!menu && (menu.move || menu.happened || menu.lost || menu.del);
}

/**
 * THE ADDRESS CARRIES THE OPEN TILE AS A HASH, `#tile=<id>`, and never in the search. The search is
 * part of the key Next files a page under: a `?tile=` written with replaceState leaves the history
 * entry holding a page keyed without it, and when a row's sheet closes (a step back in history) Next
 * misses its cache, reads the page again and shows the loading spinner. A hash is no part of that
 * key. This sets the hash, or takes it off when no tile is open, and keeps the path and the search
 * (`?view=completed`) as they are.
 */
export function tileHref(href: string, open: InspectionTile | null): string {
  const url = new URL(href);
  url.hash = open ? `tile=${open}` : "";
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The tile a hash names (`#tile=<id>`, the `#` optional), or null. Whether it is a tile at all is askedTile's. */
export function tileFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("tile");
  return value ? value : null;
}

/** Which tile is open, and in which view that was decided. */
export type TilePick = { view: InspectionsView; open: InspectionTile | null };

/**
 * THE PICK TO HOLD FOR THIS RENDER. The same pick while the view is the same: after a deed the page
 * reads again and the counts change, and the open tile stays open (with no rows left it says so).
 * When the view changed (Open | Filed), the other view's tiles are not these, so the pick starts again
 * from the page's first tile for the new view. The caller stores what this returns when it is not the
 * pick it had, so the new view's first tile is chosen once and then held, not chosen again from the
 * counts on every render.
 */
export function heldPick(pick: TilePick, view: InspectionsView, defaultOpen: InspectionTile | null): TilePick {
  return pick.view === view ? pick : { view, open: defaultOpen };
}

/** A tap on a tile: open it, or close it when it is the open one. */
export function tappedTile(open: InspectionTile | null, id: string): InspectionTile | null {
  return open === id ? null : (id as InspectionTile);
}

/**
 * THE TILE THE ADDRESS ASKS FOR, when the rule (openFirstTile) gives that very tile: a tile of this
 * view that has rows. A tile of the other view, an emptied tile or anything else in the hash asks
 * for nothing, and the open tile stays the one the page chose.
 */
export function askedTile(view: InspectionsView, counts: Readonly<Record<InspectionTile, number>>, hash: string): InspectionTile | null {
  const wanted = tileFromHash(hash);
  if (!wanted) return null;
  const tile = openFirstTile(view, counts, wanted);
  return tile === wanted ? tile : null;
}

/** Writes the open tile into the address with the history's own replaceState (no navigation, no read). */
function writeTile(next: InspectionTile | null) {
  window.history.replaceState(null, "", tileHref(window.location.href, next));
}

/** The row's own small verb: brand text on a 44px target, never a filled button. */
const VERB = "inline-flex h-11 items-center rounded-md px-2 text-sm font-semibold text-brand hover:bg-brand-light/40";

/**
 * THE INSPECTIONS BOARD: the view's tiles, one open at a time, and the open tile's rows under them.
 *
 * Everything it draws comes finished from the page (who, what, the right edge, the verb's href, which
 * moves the ⋯ offers); the board adds only which tile is open and its own two sentences.
 *
 * WHICH TILE IS OPEN is the board's state, and the address keeps a copy in its hash so Back from an
 * inspection lands on the tile it was opened from:
 *   · The first render, on the server and at hydration, opens the page's `defaultOpen` (the rule's
 *     first tile with rows), so the two renders agree.
 *   · On mount, before the first paint, the hash is read (askedTile) and the tile it names is taken
 *     when it is this view's and has rows. A layout effect, so a Back drawn on the phone paints the
 *     right tile first.
 *   · A tap opens a tile, or closes the open one, and writes the hash with replaceState: a router
 *     navigation would read the whole page again for every tap.
 *   · A tap on a row's link or its verb stamps the open tile into the address first, so Back lands on
 *     it even when a link on this page has since taken the hash off.
 *   · After a deed the page re-reads and the pick is held (heldPick); an open tile that has emptied
 *     stays open and says so. A change of view starts again from the new view's first tile, once.
 */
export function InspectionsBoard({
  view,
  tiles,
  defaultOpen,
  tz,
  capped,
}: {
  view: InspectionsView;
  tiles: readonly BoardTile[];
  /** The tile the page opens for its first paint: openFirstTile over this view's counts. */
  defaultOpen: InspectionTile | null;
  /** The company's timezone, for Move to Another Day…. */
  tz: string;
  /** How many visits the page read when it reached its cap, else null: a list cut short says so. */
  capped: number | null;
}) {
  const t = translator(useLang());
  const regionId = useId();
  const counts = Object.fromEntries(tiles.map((tile) => [tile.id, tile.count])) as Record<InspectionTile, number>;
  const [pick, setPick] = useState<TilePick>({ view, open: defaultOpen });
  const held = heldPick(pick, view, defaultOpen);
  // A new view: store its first tile now (React's adjust-state-while-rendering), so it is held after.
  if (held !== pick) setPick(held);
  const open = held.open;

  // Mount only: the hash a Back came home with. Later renders never read it again.
  useLayoutEffect(() => {
    const asked = askedTile(view, counts, window.location.hash);
    if (asked) setPick({ view, open: asked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    const next = tappedTile(open, id);
    setPick({ view, open: next });
    writeTile(next);
  };
  const stamp = () => writeTile(open);

  const grid: GridTile[] = tiles.map((tile) => ({
    id: tile.id,
    name: tile.name,
    label: tile.label,
    count: tile.count,
    lines: [tile.line],
    // Open work wears Sales' colour (Inspections is Sales, the blue of the Sales tile on My Day);
    // what is filed is plain.
    icon: <TilePicture icon={TILE_ICON[tile.id]} group={view === "open" ? "win_work" : null} />,
  }));
  const shown = tiles.find((tile) => tile.id === open) ?? null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <TileGrid tiles={grid} openId={open} onToggle={toggle} controlsId={regionId} />
        {capped !== null && <p className="px-1 text-xs text-slate-600">{fillSlots(t("ip_capped"), { n: capped })}</p>}
      </div>
      {/* The tiles' aria-controls names this wrapper, so it keeps its id with nothing open; it is a
          region, named by its tile, only while a tile is open. */}
      <div id={regionId} {...(shown ? { role: "region", "aria-label": shown.name, "data-open-tile": shown.id } : {})}>
        {shown && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">{`${shown.name} · ${shown.rows.length}`}</h2>
            {shown.rows.length === 0 ? (
              <p className="px-1 py-2 text-sm text-slate-600">{t("ip_tileEmpty")}</p>
            ) : (
              <Card>
                <ul className="divide-y divide-slate-100">
                  {shown.rows.map((row) => (
                    <InspectionRow key={row.id} row={row} tz={tz} onOpen={stamp} />
                  ))}
                </ul>
              </Card>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * ONE INSPECTION: who in bold with ONE right edge (an age or a day), what it is under it, the whole of
 * that one link to the inspection. No picture: inside one tile every row is the same thing to do. No
 * pill: what a pill said is in the phrase.
 *
 * ITS DOORS. A row with its own small verb gets a line for it, the ⋯ beside it (Needs You's row
 * grammar). A row with a ⋯ and nothing else gets no line: the ⋯ sits in the row's own bottom corner,
 * under the edge, and the phrase keeps clear of it. The row is 60px tall at least there, so the ⋯ never
 * stands on the edge above it, even with no phrase.
 *
 * A NAME MAY RUN TO A SECOND LINE ON A PHONE (Needs You's row grammar): cut at one line, what a cut
 * loses is the end, so it wraps there and is one line from sm up. The edge stays on the first line.
 */
function InspectionRow({ row, tz, onOpen }: { row: BoardRow; tz: string; onOpen: () => void }) {
  const more = hasMenu(row.menu);
  const alone = more && !row.verb;
  return (
    <li className="relative px-4" data-row={row.id}>
      <Link href={row.href} onClick={onOpen} className={`group block py-2.5 ${alone ? "min-h-[60px]" : "min-h-11"}`}>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] group-hover:text-brand sm:line-clamp-1" data-who="">
            {row.who}
          </span>
          {row.edge && (
            <span className="shrink-0 text-xs tabular-nums text-slate-600" data-edge="">
              {row.edge}
            </span>
          )}
        </span>
        {row.what && (
          <span className={`mt-0.5 line-clamp-2 block text-xs text-slate-600 sm:line-clamp-1 ${alone ? "pr-10" : ""}`} data-what="">
            {row.what}
          </span>
        )}
      </Link>
      {alone ? (
        <div className="absolute bottom-0 right-2" data-doors="corner">
          <InspectionRowMenu row={row} tz={tz} />
        </div>
      ) : (
        row.verb && (
          <div className="-mr-2 -mt-2 flex flex-wrap items-center justify-end gap-x-1 pb-1" data-doors="line">
            <Link href={row.verb.href} onClick={onOpen} className={VERB} data-verb="">
              {row.verb.label}
            </Link>
            {more && <InspectionRowMenu row={row} tz={tz} />}
          </div>
        )
      )}
    </li>
  );
}
