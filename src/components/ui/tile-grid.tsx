"use client";

import type { ReactNode } from "react";

/** One tile. Data only: the grid holds no state and knows no screen's words. */
export type GridTile = {
  /** Its id: what `openId` and `onToggle` speak. */
  id: string;
  /** Its name, drawn first (Title Case: a tile is a button). */
  name: string;
  /** The accessible label, said whole ("Get Paid: 5 open, 2 due"): the caller writes it in the reader's language. */
  label: string;
  /** The big number. Above zero: drawn. Zero: the tile is drawn dimmed and disabled, with no number.
   *  Absent: no number, and the tile stays live. */
  count?: number | null;
  /** Quiet lines under the number (money, a failed read). Empty strings are skipped. */
  lines?: readonly (string | null | undefined)[];
  /** A small node beside the number (a mark and its count). */
  mark?: ReactNode;
  /** A picture drawn left of the name, on the name's line (Needs You's tile pictures, cn-v1162). The
   *  caller draws it whole, colour and all: the grid holds no colour of its own. */
  icon?: ReactNode;
};

export type TileGridProps = {
  tiles: readonly GridTile[];
  /** The tile that is open, or null: one at a time. */
  openId: string | null;
  /** A tap: the caller opens that tile, or closes it when it is already the open one. */
  onToggle: (id: string) => void;
  /** The id of the region the tiles open (aria-controls). */
  controlsId: string;
  /** The group's accessible name, when the screen has one. */
  label?: string;
  className?: string;
};

/**
 * A GRID OF TILES THAT OPEN ONE AT A TIME (the Needs You redraw, cn-v1161; the Inspections page is next).
 * Presentational: the caller hands in the tiles, which one is open, and what a tap does.
 *
 * Two across on a phone, four from `sm` up. Every tile is a real <button> (Tab, Enter and Space work
 * with nothing added) at least 72px tall, with aria-pressed and aria-controls, so a screen reader hears
 * that it opens a region and whether it already has. A tile with nothing in it is still drawn, dimmed
 * and disabled with no number, so the grid never jumps as its counts move; the tile that is open stays
 * pressable even at zero, so it can always be closed. The open tile's outline is slate-900, never the
 * brand colour (a company's brand may be red or amber, and those mean urgency here), and the focus
 * ring is its own visible ring.
 *
 * A tile may carry a picture (`icon`, cn-v1162): it sits left of the name and the two wrap, so on a very
 * narrow phone a long name drops under its picture instead of being cut. The grid still has no colour
 * and no words of its own: the picture comes whole from the caller, and a dimmed tile dims it too.
 */
export function TileGrid({ tiles, openId, onToggle, controlsId, label, className = "" }: TileGridProps) {
  return (
    <div role="group" aria-label={label} className={`grid grid-cols-2 gap-2 sm:grid-cols-4 ${className}`}>
      {tiles.map((tile) => {
        const open = tile.id === openId;
        const zero = tile.count === 0;
        const disabled = zero && !open;
        const lines = (tile.lines ?? []).filter((l): l is string => !!l);
        return (
          <button
            key={tile.id}
            type="button"
            data-tile={tile.id}
            aria-pressed={open}
            aria-controls={controlsId}
            aria-label={tile.label}
            disabled={disabled}
            onClick={() => onToggle(tile.id)}
            className={`flex min-h-[72px] flex-col items-start justify-start gap-0.5 rounded-xl border bg-white p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 ${
              open ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:bg-slate-50"
            } ${disabled ? "cursor-default opacity-50 hover:bg-white" : ""}`}
          >
            {tile.icon ? (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {tile.icon}
                <span className="text-sm font-semibold leading-tight text-slate-900">{tile.name}</span>
              </span>
            ) : (
              <span className="text-sm font-semibold leading-tight text-slate-900">{tile.name}</span>
            )}
            {(tile.count || tile.mark) && (
              <span className="flex items-center gap-1.5">
                {!!tile.count && <span className="text-xl font-semibold tabular-nums leading-tight text-slate-900">{tile.count}</span>}
                {tile.mark}
              </span>
            )}
            {lines.map((l, i) => (
              <span key={i} className="text-xs leading-snug text-slate-600">
                {l}
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}
