"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Box, Ruler, Square, Trash2, Undo2 } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { measurePluginPresent } from "@/lib/native-measure";
import { scanDoors, scanPluginPresent } from "@/lib/native-scan";
import type { MeasureKind } from "@/lib/quick-measure";

/**
 * THE LIDAR GROUP IN THE + (cn-v1160). The owner, 2026-11-10: "a quick measure button on the top bar,
 * quick access to the lidar measure tool with dropdown for the 3 options", and, shown that a seventh
 * 44px button does not fit a phone's bar, "in the + menu agreed". So the three options are a group at
 * the top of the + menu, right under Snap or Note: the Inspector's own title and its own three verbs
 * (vi_lidar, vi_btn_measure, vi_btn_measureArea, vi_btn_scan3d), the same two taps a top-bar button
 * with a dropdown would have been.
 *
 * DRAWN ONLY WHERE THE PLUGIN IS ON THE BRIDGE, and that is read AFTER mount (useLidarDoors): the
 * server's render and the phone's first paint agree (no group), and a browser never grows one, so
 * its + menu is byte for byte what it was. "Available is not visible" (lib/native-measure): a row
 * that could only fail is not offered.
 *
 * A 3D MODEL THAT IS WAITING TAKES THE 3D SCAN ROW'S PLACE. The + holds one model at a time
 * (lib/quick-measure), so while one waits there is nothing to scan into: the row becomes "3D Model ·
 * Not Saved", which opens the sheet on it, and under it, last in the group, the way to let go of it.
 * Letting go ASKS FIRST, IN THE MENU: the house's two taps (inspections/missed-doors), never the
 * browser's own dialog, whose buttons are the browser's words in the browser's language. The first
 * tap puts the question where the row was and moves the deed down a line, so a second tap on the same
 * spot lands on the question and does nothing; the deed is red, and Keep It is under it.
 *
 * The words are the catalogs' (this file is one the leak scan reads): the Inspector's for the verbs
 * it already says, the shell's (sh_btn_measure…) for the two that are the +'s own.
 */

/** What this phone's shell can do. `measure`: Measure and Measure Area (any iPhone the Measure plugin
 *  runs on; without the sensor the figure is close and says so). `scan`: 3D Scan, the Scan plugin's
 *  own answer for this phone (the sensor, iOS 17). */
export type LidarDoors = { measure: boolean; scan: boolean };
export const NO_LIDAR_DOORS: LidarDoors = { measure: false, scan: false };

/**
 * Ask the bridges, and `tell` what they say: at once for Measure (a key on the bridge is the whole
 * answer), and again when the Scan plugin has answered for this phone. Nothing is told when nothing
 * is there, so a browser's doors stay shut without a render. On its own, outside the hook, so the
 * same code a test drives is the code the + runs.
 */
export async function readLidarDoors(tell: (doors: LidarDoors) => void): Promise<void> {
  const measure = measurePluginPresent();
  if (measure) tell({ measure, scan: false });
  if (!scanPluginPresent()) return;
  const { model } = await scanDoors();
  if (model) tell({ measure, scan: true });
}

/**
 * The doors, read ONCE AFTER MOUNT. Until then, and on the server, and in a browser, and when `on`
 * is false (a tech's +, which is Snap or Note itself: the bridge is not even asked), there are none.
 */
export function useLidarDoors(on = true): LidarDoors {
  const [doors, setDoors] = useState<LidarDoors>(NO_LIDAR_DOORS);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void readLidarDoors((d) => {
      if (live) setDoors(d);
    });
    return () => {
      live = false;
    };
  }, [on]);
  return on ? doors : NO_LIDAR_DOORS;
}

/** The + menu's own row (global-quick-add's ROW, word for word: quick-measure-rows.test holds the two
 *  together), and a row that waits reads as waiting. */
const ROW =
  "relative z-10 flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15 disabled:opacity-50";
/** The one to be careful with: the red row a menu's destructive verb wears (section-actions-menu). */
const DANGER_ROW =
  "relative z-10 flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50/60 disabled:opacity-50";
/** A group's small title and the line around it, as the account menu draws its Help group. */
const TITLE = "relative z-10 px-4 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400";
const DIVIDER = "relative z-10 my-1 border-t border-white/50";
/** The question the first tap on Discard asks: a sentence, never a row that looks pressable. */
const ASK = "relative z-10 px-4 py-2 text-sm text-slate-700";
const INK = "h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]";

type RowsProps = {
  doors: LidarDoors;
  /** Every row waits: the measuring or scanning screen is up (the plugin shows one screen at a time),
   *  or a discard is on its way out, which the + remembers across this menu closing and opening. */
  busy?: boolean;
  /** A 3D model is waiting in the + and is this person's to see: 3D Scan gives way to its two rows. */
  held?: boolean;
  /** A model is in the + that nobody on this phone has been named for yet (the app was left and the
   *  context has not answered): it cannot be shown and it cannot be scanned over, so 3D Scan waits
   *  until it is known whose it is. */
  scanWaits?: boolean;
  onPick: (kind: MeasureKind) => void;
  /** "3D Model · Not Saved": open the sheet on the model that is waiting. */
  onReopen: () => void;
};

type ViewProps = RowsProps & {
  /** The first tap on Discard happened: the question is on screen, with the deed and Keep It. */
  asking?: boolean;
  /** The second tap happened and the model is on its way out. */
  discarding?: boolean;
  onAsk: () => void;
  onDiscard: () => void;
  onKeep: () => void;
};

/**
 * THE GROUP, FROM WHAT IT IS HANDED AND NOTHING ELSE: no state, no context, the reader's translator
 * passed in. On its own so a test can hold the rows themselves and tap them (there is no screen to
 * tap in the suite), and can read the asking face, which only a tap opens. Nothing at all when the
 * phone has no door and nothing is held.
 */
export function lidarGroup(
  t: (key: string) => string,
  { doors, busy = false, held = false, scanWaits = false, asking = false, discarding = false, onPick, onReopen, onAsk, onDiscard, onKeep }: ViewProps,
): ReactElement | null {
  if (!doors.measure && !doors.scan && !held) return null;
  const off = busy || discarding;
  return (
    <>
      <div className={DIVIDER} />
      <div className={TITLE}>{t("vi_lidar")}</div>
      {doors.measure && (
        <>
          <button type="button" disabled={off} onClick={() => onPick("length")} className={ROW}>
            <Ruler className={INK} /> {t("vi_btn_measure")}
          </button>
          <button type="button" disabled={off} onClick={() => onPick("area")} className={ROW}>
            <Square className={INK} /> {t("vi_btn_measureArea")}
          </button>
        </>
      )}
      {held ? (
        <>
          <button type="button" disabled={off} onClick={onReopen} className={ROW}>
            <Box className={INK} /> {t("sh_btn_measureHeldModel")}
          </button>
          {asking && (
            <p className={ASK} role="status">
              {t("vi_discardKeptConfirm")}
            </p>
          )}
          <button type="button" disabled={off} onClick={asking ? onDiscard : onAsk} className={DANGER_ROW}>
            <Trash2 className="h-4 w-4 shrink-0" /> {t("vi_btn_discardKept3dModel")}
          </button>
          {asking && (
            <button type="button" disabled={off} onClick={onKeep} className={ROW}>
              <Undo2 className={INK} /> {t("sh_btn_measureKeepModel")}
            </button>
          )}
        </>
      ) : (
        doors.scan && (
          <button type="button" disabled={off || scanWaits} onClick={() => onPick("scan")} className={ROW}>
            <Box className={INK} /> {t("vi_btn_scan3d")}
          </button>
        )
      )}
      <div className={DIVIDER} />
    </>
  );
}

/** The group in the reader's language (the + menu's own provider; English outside one). */
export function LidarRowsView(props: ViewProps) {
  return lidarGroup(translator(useLang()), props);
}

/**
 * THE SECOND TAP: let go of the held model, ONCE. The rows wait while it is on its way out (a file
 * already up on a job is taken back down first, which is a trip over the network), and they come back
 * whatever happened, a throw included: what the group draws next is what the store holds, so a model
 * that did not go is still on its row, and a menu left with every row dead would be the one fault
 * with no way out.
 */
export async function discardOnce(o: { going: boolean; discard: () => void | Promise<void>; setGoing: (going: boolean) => void; done: () => void }): Promise<void> {
  if (o.going) return;
  o.setGoing(true);
  try {
    await o.discard();
  } catch {
    // The rows say what is true either way (see above).
  } finally {
    o.setGoing(false);
    o.done();
  }
}

/**
 * The group in the + menu. It owns the two taps of Discard and nothing else: the doors, the store and
 * what a tap does are the +'s (global-quick-add), which closes its menu before any screen opens. The
 * menu unmounts this when it closes, so a question left unanswered is gone with it and the next
 * opening starts from the resting rows.
 */
export function QuickMeasureRows({
  onDiscard,
  held = false,
  ...rows
}: RowsProps & {
  /** Let go of the held model (lib/quick-measure-save discardModel). Called on the SECOND tap only. */
  onDiscard: () => void | Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  return (
    <LidarRowsView
      {...rows}
      held={held}
      // A model that has gone (saved, discarded, somebody else's) takes its question with it.
      asking={asking && held}
      discarding={discarding}
      onAsk={() => setAsking(true)}
      onKeep={() => setAsking(false)}
      onDiscard={() => void discardOnce({ going: discarding, discard: onDiscard, setGoing: setDiscarding, done: () => setAsking(false) })}
    />
  );
}
