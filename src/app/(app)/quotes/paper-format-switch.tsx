"use client";

import { SegmentedControl } from "@/components/ui/segmented";
import { Label } from "@/components/ui/input";
import { isEstimateFormat, type EstimateFormat } from "@/lib/doc-style";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

/**
 * LABOR AND PARTS ON THE PAPER (cn-v1131). Erik: "time and material line items for each task
 * optionally visible on the estimate itself". The company's Doc Studio choice is the default; one
 * estimate may say otherwise for itself (quotes.estimate_format, 0395: null = the company's).
 *
 * FOUR SEGMENTS, ONE CONTROL (cn-v1158). Erik, 2026-11-10: "its either all the materials listed out
 * or none and i think we should have an option to list out all the materials shown as it is now and
 * an option to group the materials into one materials line as im finding that different people
 * require different solutions." So the paper has three ways to read and the estimate a fourth
 * answer, "the company's":
 *
 *   Company Default · …   null        follows Doc Studio; the words after the dot say what that is today
 *   Every Part            'detailed'  each labor row and each part under its task (what Show printed)
 *   One Materials Line    'grouped'   the labor the same, the parts as ONE "Materials" figure per task
 *   Hidden                'tasks'     the task and its price alone
 *
 * ONE NAME FOR EACH FORMAT, EVERYWHERE (the owner's law: fewer words per door). The three states used
 * to wear three sets of names: List Every Part / One Materials Line / Hide here, Every Part / One Line
 * / Hidden after the dot of the first segment, and three more in Document Studio. FORMAT_NAME below
 * is the one table of them: this switch's three segments read it, Document Studio's control reads it
 * (doc-studio/estimate-lines-control), and the words after the dot of each Company Default segment are
 * the same name (paper-format-switch.test.tsx holds the catalog to that).
 *
 * ONE control and never two switches (show the labor / group the parts): two switches would offer a
 * paper that hides the labor and still prints a materials figure, bullets that cannot add up to the
 * line they sit under. Four do not fit one line of this card on any device (it is a phone's width
 * on a phone and the sidebar's on a desktop, a third of the page), so the four are a STACK at every
 * width: a list, one per row, the same shape in English and in Spanish.
 *
 * A segment's id IS the word it stores, so there is no table here to drift from the paper's own list
 * (lib/doc-style ESTIMATE_FORMATS); the one check, isEstimateFormat, is what turns a tapped id back
 * into a word. PRESENTATIONAL ONLY — the builder (quotes/new) and the saved page each own the value
 * and the save; this draws the control and reports the pick. The words are the same on both doors,
 * so the paper reads the same whichever one he set it from.
 */

/** The first segment's id: no word of the estimate's own is stored (null), and it follows the company. */
export const COMPANY_DEFAULT = "default";

/** THE NAME OF EACH FORMAT, by the word that is stored: the catalog key every control reads for it
 *  (this switch, and Document Studio's control for the company's default). A Record over
 *  EstimateFormat on purpose: a fourth word added to lib/doc-style fails the type check HERE until
 *  it has a name of its own, instead of quietly reading as one of the other three. */
export const FORMAT_NAME: Record<EstimateFormat, string> = {
  detailed: "qt_btn_everyPart",
  grouped: "qt_btn_oneMaterialsLine",
  tasks: "qt_btn_hidden",
};

/** What the first segment says the company's default is, by the word Doc Studio stored: "Company
 *  Default", a dot, and that format's own name. A Record for the same reason as the names'. */
const DEFAULT_LABEL: Record<EstimateFormat, string> = {
  detailed: "qt_btn_companyDefaultEveryPart",
  grouped: "qt_btn_companyDefaultOneLine",
  tasks: "qt_btn_companyDefaultHidden",
};

/** The segment an estimate's stored word lights: its own word, or the company's when it holds none. */
export const segmentFor = (value: EstimateFormat | null): string => value ?? COMPANY_DEFAULT;

/** The word a tapped segment stores: null for the company's, the segment's own word otherwise;
 *  undefined for an id that is no segment of this control, which writes nothing. */
export function storedFor(id: string): EstimateFormat | null | undefined {
  if (id === COMPANY_DEFAULT) return null;
  return isEstimateFormat(id) ? id : undefined;
}

export function PaperFormatSwitch({
  value,
  companyDefault,
  onChange,
  disabled,
}: {
  /** The estimate's own choice; null = the company default. */
  value: EstimateFormat | null;
  /** What the company default currently means (Document Studio's Labor and Parts on Estimates). */
  companyDefault: EstimateFormat;
  onChange: (v: EstimateFormat | null) => void;
  /** While a save is in flight: the pill stays where it is and a tap does nothing. */
  disabled?: boolean;
}) {
  const t = translator(useLang());
  return (
    <div>
      <Label>{t("qt_laborPartsOnPaper")}</Label>
      <div className={disabled ? "pointer-events-none opacity-60" : undefined} aria-disabled={disabled || undefined}>
        <SegmentedControl
          stack="always"
          activeId={segmentFor(value)}
          onSelect={(id) => {
            if (disabled) return;
            const next = storedFor(id);
            if (next !== undefined) onChange(next);
          }}
          items={[
            { id: COMPANY_DEFAULT, label: t(DEFAULT_LABEL[companyDefault]) },
            { id: "detailed" satisfies EstimateFormat, label: t(FORMAT_NAME.detailed) },
            { id: "grouped" satisfies EstimateFormat, label: t(FORMAT_NAME.grouped) },
            { id: "tasks" satisfies EstimateFormat, label: t(FORMAT_NAME.tasks) },
          ]}
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {t("qt_paperFormatHelp")}
      </p>
    </div>
  );
}
