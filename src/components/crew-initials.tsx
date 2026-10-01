import { chipDot, crewWords, type CrewChip } from "@/lib/schedule/block-info";

/**
 * WHO'S ON IT, AS INITIALS (text to visual: "theres the job- who's on it, bam"). The one way a block
 * draws its crew, on the schedule's grid blocks, the day drill's card, the rail's card and My Day's
 * rows: initials chips in the crew's order, a few and then "+2", and a dashed "Nobody" when no one is
 * on it (a blank is a fact, never an empty space). Read-only marks, never a door: the crew is changed
 * in the tile's sheet and on the job page. Each chip carries its title (the whole name, and what that
 * day's crew row says) for hover and screen readers.
 *
 * ONE PERSON IS ONE COLOR (Wave 2, SV-chips): each chip wears the person's own color (the /timecards
 * person color, lib/schedule/block-info chipDot), the same on the tile, the card, the sheet and the
 * worked bars; the block keeps its record-type color. The day's crew row (Everyone's Day) shows:
 * someone off that day is dimmed and struck through, someone on another job that day is dimmed.
 *
 *   xs  inside a grid block (14px chips, 7px letters)
 *   sm  on a card or a row (24px chips)
 */
export function CrewInitials({ crew, size = "sm", max = 3 }: { crew: CrewChip[]; size?: "xs" | "sm"; max?: number }) {
  const chip =
    size === "xs"
      ? "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[7px] font-semibold leading-none text-white"
      : "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white";
  if (!crew.length) {
    return size === "xs" ? (
      <span className="inline-flex h-3.5 shrink-0 items-center rounded-full border border-dashed border-current px-1 text-[8px] leading-none opacity-60">
        Nobody
      </span>
    ) : (
      <span className="shrink-0 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400">Nobody</span>
    );
  }
  const shown = crew.slice(0, Math.max(1, max));
  const hidden = crew.slice(shown.length);
  const titleOf = (c: CrewChip) => c.title ?? c.name;
  return (
    <span className={`flex shrink-0 items-center ${size === "xs" ? "gap-0.5" : "-space-x-1"}`} aria-label={crewWords(crew)}>
      {shown.map((c) => (
        <span
          key={c.id}
          title={titleOf(c)}
          className={`${chip} ${chipDot(c)}${c.state === "off" ? " line-through opacity-40" : c.state === "elsewhere" ? " opacity-40" : ""}`}
        >
          {c.initials}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.map(titleOf).join(", ")}
          className={size === "xs" ? "shrink-0 text-[8px] leading-none opacity-70" : "pl-1.5 text-[11px] text-slate-500"}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
