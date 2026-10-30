import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { BackLink } from "@/components/back-link";
import { PrintButton } from "@/components/print-button";
import { inchWords, panelGeometry, type PanelGeometry } from "@/lib/panel/geometry";
import { circuitsOfPanel } from "@/lib/panel/held";
import { stripLengthIn, stripLines, type StripLine } from "@/lib/panel/strip";
import { BORDER_PT, LABEL_PAD_IN, MIN_PT, fitCheck, labelPt, tightWords } from "@/lib/panel/fit";
import type { JobCircuit, JobPanel } from "@/lib/types";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only what the strips draw (the projection law): the door's shape and its three measurements
 *  (0402), never the notes, the photo or who changed what. */
const PANEL_COLS = "id, name, brand, spaces, numbering, dead_spaces, twin_spaces, space_pitch_in, label_width_in, label_width_in_right";
const CIRCUIT_COLS = "id, panel_id, room, description, panel_label, amps, poles, space, half, work, state, removed_at";

/** The faint space number beside each box: its type size, and the gutter OUTSIDE each strip it sits
 *  in (the left strip's left, the right strip's right), clear of the box so it never prints over a
 *  name and falls away when the strip is cut. */
const SPACE_NO_PT = 5;
const SPACE_NO_GUTTER_IN = 0.25;
const SPACE_NO_GAP_IN = 0.03;

type LabelPanel = Pick<
  JobPanel,
  "id" | "name" | "brand" | "spaces" | "numbering" | "dead_spaces" | "twin_spaces" | "space_pitch_in" | "label_width_in" | "label_width_in_right"
>;

/**
 * THE PANEL'S DOOR LABELS, PRINTED (the panel-first wave): /print/panel-labels/<job>?panel=<id>.
 *
 * Two strips side by side at TRUE SCALE, through the browser's own print (window.print): the left
 * strip names the odd spaces, the right the even, in the order they hang. One line between them is
 * the cut. Each strip is exactly as wide as the panel's label area (measured once and kept on the
 * panel, 0402; the make's default until then) and each box exactly as tall as its handle: a space
 * for a single or a 2-pole line, half a space for a tandem's (lib/panel/strip). The words are set as
 * large as they fit, down to 6 pt (lib/panel/fit); a name that still can't fit is SAID on screen
 * before printing, never clipped. No scaling, no halves, no cut marks, no sheet picker: a strip
 * longer than the sheet runs on to the next one BY NATURAL MEANS — each box keeps itself whole
 * (break-inside: avoid) and the strips may break between boxes, so the page turns between two
 * labels, never through one — and "Print at 100%." says the one thing that matters.
 *
 * THE PRINT PATH IS THE BUSINESS CARD'S (/print/business-card): outside the app shell, the top
 * padding clears the installed shell's status bar (--sat), and the app-wide @page { margin: 0 }
 * stands (globals.css): the quarter inch the paper needs is padding on the sheet, in print only.
 *
 * WHO: any active member of the job's company (the crew print labels at the panel), the same guards
 * as the panel directory (/print/panel/<job>): signed in, active, the job in their own company, and
 * RLS on job_panels / job_circuits (0333) behind it. Kept, live circuits only — the panel's own, and
 * the job's loose ones when it is the only panel (lib/panel/held, the tab's rule).
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ panel?: string | string[] }>;
}): Promise<Metadata> {
  const { jobId } = await params;
  const want = (await searchParams)?.panel;
  if (!UUID.test(jobId)) return { title: "Panel Labels" };
  const supabase = await createClient();
  // The tenant law: the query names the company as well as RLS holding it.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = user ? await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle() : { data: null };
  const orgId = (me as { org_id?: string | null } | null)?.org_id;
  if (!orgId) return { title: "Panel Labels" };
  let pq = supabase.from("job_panels").select("name").eq("job_id", jobId).eq("org_id", orgId).is("removed_at", null);
  pq = typeof want === "string" && UUID.test(want) ? pq.eq("id", want) : pq.order("created_at").order("id").limit(1);
  const [{ data: job }, { data: panel }] = await Promise.all([
    supabase.from("jobs").select("name, job_number").eq("id", jobId).eq("org_id", orgId).maybeSingle(),
    pq.maybeSingle(),
  ]);
  const j = job as { name?: string | null; job_number?: string | null } | null;
  const jobName = j?.name?.trim() || j?.job_number || "This Job";
  const panelName = (panel as { name?: string | null } | null)?.name?.trim() || "Panel";
  return { title: `${panelName} Labels — ${jobName}` };
}

/** How wide the strips are, each said on its own: a width nobody measured is "the make's" until it is. */
function widthSentence(panel: Pick<JobPanel, "label_width_in" | "label_width_in_right">, geo: PanelGeometry): string {
  const leftMeasured = panel.label_width_in != null;
  const rightMeasured = panel.label_width_in_right != null || leftMeasured;
  const base =
    geo.labelWidthRightIn === geo.labelWidthLeftIn
      ? `Each strip is ${inchWords(geo.labelWidthLeftIn)} in wide`
      : `The left strip is ${inchWords(geo.labelWidthLeftIn)} in wide and the right ${inchWords(geo.labelWidthRightIn)} in`;
  if (leftMeasured && rightMeasured) return `${base}.`;
  if (!leftMeasured && !rightMeasured) return `${base}, the make's width until the label area is measured.`;
  return `${base}; the left is the make's width until it is measured.`;
}

/** How tall a space is: measured, or the make's until it is. */
function pitchSentence(panel: Pick<JobPanel, "space_pitch_in">, geo: PanelGeometry): string {
  return `Each space is ${inchWords(geo.pitchIn)} in tall${panel.space_pitch_in != null ? "." : ", the make's size until a space is measured."}`;
}

/** How long the strips print (stripLengthIn: the boxes, top to bottom). */
function lengthSentence(left: number, right: number): string {
  return left === right ? `Each strip is ${inchWords(left)} in long.` : `The left strip is ${inchWords(left)} in long and the right ${inchWords(right)} in.`;
}

/** One strip: a column of boxes exactly `widthIn` wide, each exactly its line's height, with the
 *  border and inner margin fit.ts measures by. The column may break between boxes; a box never
 *  breaks. The space number sits faint OUTSIDE the box, in the gutter on the strip's outer side (the
 *  left strip's left, the right strip's right). The cell beside an odd panel's last space is no box
 *  at all: only its height, so the two strips still line up. */
function Strip({ lines, widthIn, side }: { lines: StripLine[]; widthIn: number; side: "left" | "right" }) {
  return (
    <div data-strip={side} style={{ width: `${widthIn}in`, flex: "none", breakInside: "auto" }}>
      {lines.map((l) => {
        const key = `${l.space}${l.half ?? ""}`;
        if (l.kind === "none") return <div key={key} data-space={l.space} data-kind="none" aria-hidden style={{ height: `${l.heightIn}in`, breakInside: "avoid" }} />;
        const pt = l.text ? labelPt(l, widthIn) : null;
        return (
          <div
            key={key}
            data-space={l.space}
            data-half={l.half ?? undefined}
            data-kind={l.kind}
            data-pt={l.text ? (pt ?? "tight") : undefined}
            style={{
              position: "relative",
              boxSizing: "border-box",
              width: "100%",
              height: `${l.heightIn}in`,
              border: `${BORDER_PT}pt solid #000`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: `${LABEL_PAD_IN}in`,
              textAlign: "center",
              overflow: "visible",
              fontFamily: "Arial, Helvetica, sans-serif",
              fontSize: `${pt ?? MIN_PT}pt`,
              lineHeight: 1.15,
              color: "#000",
              breakInside: "avoid",
            }}
          >
            <span
              aria-hidden
              data-space-no=""
              style={{
                position: "absolute",
                top: 0,
                [side === "left" ? "right" : "left"]: `calc(100% + ${SPACE_NO_GAP_IN}in)`,
                fontSize: `${SPACE_NO_PT}pt`,
                lineHeight: 1,
                whiteSpace: "nowrap",
                color: "#94a3b8",
              }}
            >
              {l.space}
              {l.half ?? ""}
            </span>
            {l.text}
          </div>
        );
      })}
    </div>
  );
}

export default async function PanelLabelsPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ panel?: string | string[] }>;
}) {
  const { jobId } = await params;
  const want = (await searchParams)?.panel;
  if (!UUID.test(jobId)) notFound();
  if (want != null && (typeof want !== "string" || !UUID.test(want))) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data: me } = await supabase.from("profiles").select("org_id, active").eq("id", user.id).maybeSingle();
  const my = me as { org_id?: string | null; active?: boolean | null } | null;
  if (!my?.org_id || my.active === false) notFound();

  const { data: job } = await supabase.from("jobs").select("id, name, job_number").eq("id", jobId).eq("org_id", my.org_id).maybeSingle();
  if (!job) notFound();
  const j = job as { id: string; name: string | null; job_number: string | null };
  const jobName = j.name?.trim() || j.job_number || "This Job";

  // The job's live panels, oldest first: ?panel=<id> picks one; with none, the first (the panel the
  // Panel 1 rules use). How many there are decides whether a loose circuit is this panel's.
  const { data: panelRows } = await supabase
    .from("job_panels")
    .select(PANEL_COLS)
    .eq("job_id", jobId)
    .eq("org_id", my.org_id)
    .is("removed_at", null)
    .order("created_at")
    .order("id");
  const livePanels = (panelRows ?? []) as unknown as LabelPanel[];
  const panel = (want ? livePanels.find((p) => p.id === want) : livePanels[0]) ?? null;
  if (want && !panel) notFound();

  const back = (
    <div className="mb-3 flex items-center justify-between gap-3">
      <BackLink fallback={`/jobs/${jobId}?tab=panel`} fallbackLabel="Back" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800" />
      {panel ? <PrintButton label="Print Labels" /> : null}
    </div>
  );

  if (!panel) {
    return (
      // Outside the app shell, like the business card: in the full-bleed iOS shell a plain top
      // padding put Back under the status bar. --sat is 0 in a browser, so nothing moves there.
      <div className="min-h-screen bg-white px-4 pb-6 pt-[max(1.5rem,var(--sat,0px))] text-slate-900">
        <div className="no-print mx-auto max-w-2xl print:hidden">
          {back}
          <h1 className="text-lg font-bold">{jobName}</h1>
          <p className="mt-2 text-sm text-slate-600">This job has no panel yet. Open its Panel tab and add a circuit; the panel comes with it.</p>
        </div>
      </div>
    );
  }

  // Every kept, live circuit of the job; the panel's are the ones the door draws (lib/panel/held:
  // its own, and the loose ones when it is the job's only panel).
  const { data: circuitRows } = await supabase
    .from("job_circuits")
    .select(CIRCUIT_COLS)
    .eq("job_id", jobId)
    .eq("org_id", my.org_id)
    .eq("state", "kept")
    .is("removed_at", null)
    .order("sort_order")
    .order("created_at");
  const circuits = circuitsOfPanel(panel, (circuitRows ?? []) as unknown as JobCircuit[], livePanels.length);

  const geo = panelGeometry(panel);
  const strips = stripLines(panel, circuits);
  const tight = [...fitCheck(strips.left, geo.labelWidthLeftIn).tight, ...fitCheck(strips.right, geo.labelWidthRightIn).tight].sort(
    (a, b) => a.space - b.space || String(a.half ?? "").localeCompare(String(b.half ?? "")),
  );
  const tightSentence = tightWords(tight.length);
  const panelName = panel.name?.trim() || "Panel";

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Outside the app shell, like the business card: the top padding clears the installed
          shell's status bar (--sat is 0 in a browser, so nothing moves there). */}
      <div className="no-print mx-auto max-w-2xl px-4 pt-[max(1.5rem,var(--sat,0px))] print:hidden" data-labels-header>
        {back}
        <h1 className="text-lg font-bold">{panelName}</h1>
        <p className="text-sm text-slate-600">{jobName}</p>
        <p className="mt-2 text-sm font-semibold">Print at 100%.</p>
        <p className="mt-1 text-sm text-slate-600" data-measures>
          {widthSentence(panel, geo)} {pitchSentence(panel, geo)} {lengthSentence(stripLengthIn(strips.left), stripLengthIn(strips.right))}
        </p>
        {tightSentence ? (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-tight>
            <p className="font-semibold">{tightSentence}</p>
            <ul className="mt-1 list-disc pl-5">
              {tight.map((t) => (
                <li key={`${t.space}${t.half ?? ""}`}>
                  Space {t.space}
                  {t.half ?? ""}: {t.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {strips.warnings.length ? (
          <ul className="mt-3 list-disc pl-5 text-sm text-slate-600" data-warnings>
            {strips.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* THE SHEET. On paper its quarter inch is padding, print only (the app-wide @page margin is 0),
          and repeated on every page a long strip runs onto (box-decoration-break: clone). */}
      <div className="px-4 py-6 print:p-[0.25in]" data-sheet style={{ boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
        <div data-strips style={{ display: "flex", alignItems: "flex-start", width: "max-content", padding: `0 ${SPACE_NO_GUTTER_IN}in` }}>
          <Strip lines={strips.left} widthIn={geo.labelWidthLeftIn} side="left" />
          <div aria-hidden data-cut style={{ flex: "none", width: 0, alignSelf: "stretch", borderLeft: "1px solid #000" }} />
          <Strip lines={strips.right} widthIn={geo.labelWidthRightIn} side="right" />
        </div>
      </div>
    </div>
  );
}
