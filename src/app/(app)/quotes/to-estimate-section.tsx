import { InspectionList } from "../inspections/inspection-list";
import type { ListRow } from "../inspections/list-rows";

/**
 * INSPECTIONS TO ESTIMATE (cn-v1172), the top of the Estimates page. Erik, 2026-11-19: "lets break
 * the Estimate page into 2 parts consisting of completed inspections in its own new list called
 * Inspections To Estimate, and the other section below is all Estimates like they are now".
 *
 * Its rows are the Inspections list's own write_up rows (lib/inspections inspectionsToEstimate, read
 * through the one reader both pages use), built by the same row builder and drawn by the same card:
 * who in bold opening the person's file, what and where, how long ago, the boxed Create Estimate and
 * the same ⋯. Empty: one quiet slate line. A failed read is said here, never drawn as none.
 */
export function ToEstimateSection({
  rows,
  tz,
  failed,
  t,
}: {
  rows: readonly ListRow[];
  tz: string;
  failed: boolean;
  t: (key: string) => string;
}) {
  return (
    <section data-section="to-estimate" className="mb-6">
      <h2 className="mb-2 px-1 text-base font-semibold text-slate-900">{t("qt_toEstimateHeading")}</h2>
      {failed ? (
        <p role="status" data-read-failed="" className="rounded-xl border-2 border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          {t("qt_toEstimateFailed")}
        </p>
      ) : rows.length === 0 ? (
        <p data-to-estimate-empty="" className="px-1 text-sm text-slate-500">
          {t("qt_toEstimateNone")}
        </p>
      ) : (
        <InspectionList rows={rows} tz={tz} />
      )}
    </section>
  );
}

/** The heading over the list as it always was, drawn only when the section above it is. */
export function AllEstimatesHeading({ t }: { t: (key: string) => string }) {
  return <h2 className="mb-2 px-1 text-base font-semibold text-slate-900">{t("qt_allEstimatesHeading")}</h2>;
}
