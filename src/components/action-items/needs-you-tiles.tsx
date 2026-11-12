"use client";

import { useLang } from "@/components/lang-provider";
import { TileGrid, type GridTile } from "@/components/ui/tile-grid";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { formatCurrency } from "@/lib/utils";
import type { Group } from "@/lib/action-items/types";
import type { NeedsYouSummary, TileSummary } from "@/lib/action-items/needs-you-rule";
import { LevelMark } from "./level-mark";

/** Each tile's name, by its group. */
export const TILE_NAME_KEY: Record<Group, string> = {
  get_paid: "ny_btn_tileGetPaid",
  win_work: "ny_btn_tileWinWork",
  run_jobs: "ny_btn_tileRunJobs",
  keep_books: "ny_btn_tileKeepBooks",
};

/** What a tile's money means, by its group. Run the Jobs adds up no figure the app can stand behind. */
const MONEY_KEY: Record<Group, string | null> = {
  get_paid: "ny_tileToCollect",
  win_work: "ny_tileInEstimates",
  run_jobs: null,
  keep_books: "ny_tileToFile",
};

/**
 * THE HEADER'S COUNTS: an octagon and how many to act on today, a triangle and how many soon, then
 * the rest. Each is drawn only above zero. With no mark at all the last one says "N open" (there is
 * nothing to be "more" than). The number is drawn once for the eye; a screen reader hears it said
 * whole ("3 to act on today"), so it never hears a bare digit.
 */
export function NeedsYouCounts({ summary }: { summary: Pick<NeedsYouSummary, "now" | "soon" | "more"> }) {
  const t = translator(useLang());
  const { now, soon, more } = summary;
  if (!now && !soon && !more) return null;
  const plain = now || soon ? fillSlots(t("ny_countMore"), { n: more }) : fillSlots(t(more === 1 ? "ny_countOpenOne" : "ny_countOpen"), { n: more });
  return (
    <div className="flex shrink-0 items-center gap-3 text-sm font-semibold text-slate-900" data-counts="">
      {now > 0 && (
        <span className="inline-flex items-center gap-1" data-count="now">
          <LevelMark level="now" decorative />
          <span aria-hidden="true" className="tabular-nums">
            {now}
          </span>
          <span className="sr-only">{fillSlots(t("ny_countNow"), { n: now })}</span>
        </span>
      )}
      {soon > 0 && (
        <span className="inline-flex items-center gap-1" data-count="soon">
          <LevelMark level="soon" decorative />
          <span aria-hidden="true" className="tabular-nums">
            {soon}
          </span>
          <span className="sr-only">{fillSlots(t("ny_countSoon"), { n: soon })}</span>
        </span>
      )}
      {more > 0 && (
        <span className="font-medium text-slate-600" data-count="more">
          {plain}
        </span>
      )}
    </div>
  );
}

/**
 * THE FOUR TILES (staff only): Get Paid, Win Work, Run the Jobs, Keep the Books, in that order. Each
 * says its name, how many are open in it (the strip's NOW rows are not counted twice), the money it
 * holds (staff only, "+" when a pile's read was cut short), a triangle with its SOON count, and how
 * many of its reads failed, so a closed tile never hides a failed read. Built on the one generic
 * TileGrid; the summary is lib/action-items/needs-you-rule summarize(), over the live rows.
 */
export function NeedsYouTiles({
  tiles,
  openId,
  onToggle,
  controlsId,
  isStaff,
}: {
  tiles: readonly TileSummary[];
  openId: Group | null;
  onToggle: (g: Group) => void;
  controlsId: string;
  isStaff: boolean;
}) {
  const lang = useLang();
  const t = translator(lang);
  const grid: GridTile[] = tiles.map((tile) => {
    const name = t(TILE_NAME_KEY[tile.group]);
    const moneyKey = MONEY_KEY[tile.group];
    const money =
      isStaff && moneyKey && tile.money !== null && tile.money > 0
        ? fillSlots(t(moneyKey), { money: `${formatCurrency(tile.money, lang)}${tile.moneyCapped ? "+" : ""}` })
        : null;
    const unread = tile.unread > 0 ? fillSlots(t("ny_tileUnread"), { n: tile.unread }) : null;
    const soon = tile.soon > 0 ? fillSlots(t("ny_countSoon"), { n: tile.soon }) : null;
    const head = tile.count > 0 ? fillSlots(t(tile.count === 1 ? "ny_tileOpenOne" : "ny_tileOpen"), { name, n: tile.count }) : fillSlots(t("ny_tileNothing"), { name });
    return {
      id: tile.group,
      name,
      label: [head, soon, money, unread].filter(Boolean).join(", "),
      count: tile.count,
      lines: [money, unread],
      mark:
        tile.soon > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums text-slate-900" data-tile-soon={tile.soon}>
            <LevelMark level="soon" className="h-3.5 w-3.5" />
            {tile.soon}
          </span>
        ) : null,
    };
  });
  return <TileGrid tiles={grid} openId={openId} onToggle={(id) => onToggle(id as Group)} controlsId={controlsId} />;
}
