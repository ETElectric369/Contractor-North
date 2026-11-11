"use client";

import { SegmentedControl } from "@/components/ui/segmented";
import { Label } from "@/components/ui/input";
import { isEstimateFormat, type EstimateFormat } from "@/lib/doc-style";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { FORMAT_NAME } from "../quotes/paper-format-switch";

/**
 * LABOR AND PARTS ON ESTIMATES — HOW A TASK LINE READS, THE COMPANY'S DEFAULT (0386; a third choice
 * since cn-v1158). Erik: the customer sees the estimate "in a per-company format", and on 2026-11-10:
 * "an option to group the materials into one materials line as im finding that different people
 * require different solutions."
 *
 *   Hidden               'tasks'     each task with its price
 *   Every Part           'detailed'  each labor row (its hours at its rate) and each part beneath it
 *   One Materials Line   'grouped'   the labor the same, the parts as ONE "Materials" figure per task
 *
 * THE SAME THREE NAMES AS THE ESTIMATE'S OWN SWITCH, read from the same three keys (quotes/
 * paper-format-switch FORMAT_NAME): the owner's law is fewer words per door, and these three states
 * used to be Tasks Only, Tasks with Labor and Parts and Labor and One Materials Line here while the
 * switch called them something else. The heading was "Estimate Lines", which reads wrongly over a
 * choice called Hidden, so it says what the choice is about: the labor and the parts.
 *
 * Only a line BUILT from a task has a breakdown — the studio's sample has one, with two labor rows,
 * so the choice shows on the page below the moment it is tapped. An estimate may choose for itself
 * on its own page (quotes/paper-format-switch, whose first segment names this default); this is
 * what an estimate that says nothing prints.
 *
 * Its own small file, out of the studio, for two reasons: its words are in the catalog in both
 * languages (the studio around it is still English, and the leak test can hold a whole file to the
 * catalog but not half of one), and it can be drawn and driven by a test without the studio's page,
 * handles and autosave. A segment's id IS the stored word; isEstimateFormat (lib/doc-style, the one
 * list) is what says a tapped id is one.
 *
 * BELOW `lg` IT IS A STACK (the pill's stack="narrow"). From `lg` up the studio's bar has room for
 * the three on one line, like the bar's other pills; below it they are a list, one per row, and the
 * control takes the bar's whole width like the two boxes above it (the wrapper's max-lg:w-full).
 * From `lg` up the wrapper is the plain box it was at cn-v1157, as wide as its pill.
 *
 * WHY `lg`. Measured in a browser in the app's own font WITH THE THREE LONGER NAMES THE CONTROL HAD
 * THEN (Tasks Only, Tasks with Labor and Parts, Labor and One Materials Line), the one line was 518px
 * wide in English and 640.5px in Spanish. The bar's inner width is the window less 158px with a mouse
 * (the dock, the page padding, the bar's own) and less 58px on a touch screen under 1024px. So a
 * rule that stacked only on a phone (below `sm`) left the one line wider than its bar in windows
 * from 640px to 675px in English and to 798px in Spanish: it ran out of the bar and the page
 * scrolled sideways. At `lg` the bar has 680px with the dock and the section column both standing,
 * and more above. The call, 2026-11-10: a page that scrolls sideways is worse than a three-row list
 * in a 900px window where one line would have fit.
 *
 * THE NAMES ARE SHORTER NOW AND NOBODY HAS MEASURED THEM. The one line needs less room than those
 * numbers say, so the list may start earlier than it has to; the rule was left where it stands
 * because a list never runs out of its place, and moving it wants a browser, not a guess.
 */
export function EstimateLinesControl({
  value,
  onChange,
}: {
  /** The company's stored default (doc_style.estimate_format, through normalizeDocStyle). */
  value: EstimateFormat;
  onChange: (v: EstimateFormat) => void;
}) {
  const t = translator(useLang());
  return (
    <div className="max-lg:w-full">
      <Label>{t("qt_estimateLines")}</Label>
      <SegmentedControl
        stack="narrow"
        activeId={value}
        onSelect={(id) => {
          if (isEstimateFormat(id)) onChange(id);
        }}
        items={[
          { id: "tasks" satisfies EstimateFormat, label: t(FORMAT_NAME.tasks) },
          { id: "detailed" satisfies EstimateFormat, label: t(FORMAT_NAME.detailed) },
          { id: "grouped" satisfies EstimateFormat, label: t(FORMAT_NAME.grouped) },
        ]}
      />
    </div>
  );
}
