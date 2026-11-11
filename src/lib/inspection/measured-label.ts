import type { MeasureMode } from "@/lib/native-measure";

/**
 * A MEASURED ROW'S STORED LABEL IS ENGLISH (skeptic #50). "Measured length" is a RECORD — the office, the
 * estimate and every later reader open the capture as stored — so Measure writes the row's label in
 * English whatever the tech's language, and the sheet draws the tech's own word for it (the catalog's
 * Spanish) while the stored text is still one of the four; anything he typed over it is shown as typed.
 * An English reader sees the stored text either way.
 *
 * Moved here from the Inspector (cn-v1160) so the + menu's Measure can name a result without importing
 * the 2,790-line Inspector. A file under src/lib imports no catalog, so the English record words are
 * handed in: `en` is translator("en"). The Inspector re-exports both functions bound to it, and the four
 * keys stay the visit-inspector catalog's own.
 */
export const MEASURED_LABEL_KEYS = ["vi_measuredLength", "vi_measuredLengthApprox", "vi_measuredArea", "vi_measuredAreaApprox"] as const;

/** Which of the four keys a result is. */
export function measuredLabelKey(mode: MeasureMode, approx: boolean): (typeof MEASURED_LABEL_KEYS)[number] {
  return mode === "area" ? (approx ? "vi_measuredAreaApprox" : "vi_measuredArea") : approx ? "vi_measuredLengthApprox" : "vi_measuredLength";
}

/** The label Measure writes on its row: neutral, not a guess, and English for the record. */
export function measuredRowLabelIn(en: (key: string) => string, mode: MeasureMode, approx: boolean): string {
  return en(measuredLabelKey(mode, approx));
}

/** The label as the reader sees it in the row's box: the catalog's word for a stored Measure label,
 *  else as stored. */
export function measureLabelWordsIn(en: (key: string) => string, label: string, t: (key: string) => string): string {
  const key = MEASURED_LABEL_KEYS.find((k) => en(k) === label);
  return key ? t(key) : label;
}
