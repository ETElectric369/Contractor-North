import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { fakeDb, type Row } from "@/test/fake-supabase";
import { textOf } from "@/test/rendered-page";

/**
 * THE DOOR LABELS PAGE, RENDERED (the panel-first wave): the server page itself against a fake
 * client in the live shapes. Two strips side by side, each exactly the label area's width in CSS
 * inches (the panel's own measurement, else the make's default), one cut line between them, a box
 * per handle at its height, and the tight sentence on screen only when a name can't fit at 6 pt.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PANEL = "33333333-3333-4333-8333-333333333333";
const OTHER_PANEL = "44444444-4444-4444-8444-444444444444";
const USER = "user-larkspur";

let tables: Record<string, Row[]> = {};
const fake = () => ({ ...fakeDb(tables).sb, auth: { getUser: async () => ({ data: { user: { id: USER } } }) } });

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ back: () => {}, push: () => {} }),
  usePathname: () => "/print/panel-labels",
}));

const panel = (over: Row = {}): Row => ({
  id: PANEL,
  org_id: ORG,
  job_id: JOB,
  name: "Panel 1",
  brand: "Siemens",
  spaces: 10,
  numbering: "top_down",
  dead_spaces: [],
  twin_spaces: [],
  space_pitch_in: null,
  label_width_in: null,
  label_width_in_right: null,
  removed_at: null,
  created_at: "2026-10-30T00:00:00Z",
  ...over,
});
let seq = 0;
const circuit = (space: number, half: "A" | "B" | null, words: string, over: Row = {}): Row => ({
  id: `circuit-${++seq}`,
  org_id: ORG,
  job_id: JOB,
  panel_id: PANEL,
  room: null,
  description: words,
  panel_label: null,
  amps: 20,
  poles: 1,
  space,
  half,
  work: "existing",
  state: "kept",
  removed_at: null,
  ...over,
});

function seed(panels: Row[], circuits: Row[]) {
  tables = {
    profiles: [{ id: USER, org_id: ORG, active: true }],
    jobs: [{ id: JOB, org_id: ORG, name: "Larkspur", job_number: "J-101" }],
    job_panels: panels,
    job_circuits: circuits,
  };
}

async function render(search: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ jobId: JOB }), searchParams: Promise.resolve(search) })) as ReactElement);
}

/** The opening tag of the element carrying this data attribute. */
const tagOf = (html: string, attr: string) => {
  const m = new RegExp(`<div[^>]*${attr}[^>]*>`).exec(html);
  if (!m) throw new Error(`no ${attr}`);
  return m[0];
};

const LARKSPUR = [
  circuit(1, "A", "Garage"),
  circuit(1, "B", "Floor Heat"),
  circuit(3, null, "Mini Split", { poles: 2, amps: 30 }),
  circuit(2, "A", "GDO 1"),
  circuit(2, "B", "TVSS"),
  circuit(4, null, "EV Charger", { poles: 2, amps: 50 }),
  circuit(7, null, "Laundry"),
];

describe("/print/panel-labels/<job>", () => {
  beforeEach(() => seed([panel()], LARKSPUR));

  it("prints two strips side by side at the make's width (Siemens: 1.125 in), one cut line between them", async () => {
    const html = await render();
    expect(tagOf(html, 'data-strip="left"')).toContain("width:1.125in");
    expect(tagOf(html, 'data-strip="right"')).toContain("width:1.125in");
    expect(tagOf(html, "data-cut")).toContain("border-left:1px solid #000");
    // Left strip, cut line, right strip: in that order, in one row.
    const strips = html.slice(html.indexOf("data-strips"));
    expect(strips.indexOf('data-strip="left"')).toBeLessThan(strips.indexOf("data-cut"));
    expect(strips.indexOf("data-cut")).toBeLessThan(strips.indexOf('data-strip="right"'));
  });

  it("follows the business card's print path: no @page of its own, the quarter inch is print-only padding, the top clears the shell's status bar", async () => {
    const html = await render();
    // The app-wide @page { margin: 0 } stands (globals.css): this page sets none.
    expect(html).not.toContain("@page");
    expect(tagOf(html, "data-sheet")).toContain("print:p-[0.25in]");
    // Repeated on every page a long strip runs onto.
    expect(tagOf(html, "data-sheet")).toMatch(/box-decoration-break:clone/);
    expect(html).toMatch(/class="[^"]*pt-\[max\(1\.5rem,var\(--sat,0px\)\)\][^"]*"[^>]*data-labels-header/);
    // The page with no panel yet goes the same way.
    seed([], []);
    expect(await render()).toContain("pt-[max(1.5rem,var(--sat,0px))]");
  });

  it("a strip longer than the sheet breaks BETWEEN boxes, never through a label", async () => {
    const html = await render();
    expect(tagOf(html, 'data-strip="left"')).toContain("break-inside:auto");
    expect(tagOf(html, 'data-strip="right"')).toContain("break-inside:auto");
    const boxes = [...html.matchAll(/<div[^>]*data-kind="[a-z0-9]+"[^>]*>/g)].map((m) => m[0]);
    expect(boxes.length).toBeGreaterThan(10);
    for (const b of boxes) expect(b).toContain("break-inside:avoid");
  });

  it("draws a box per handle at its height: a tandem's two half-space lines, a 2-pole's words on both spaces, a blank box for an empty space", async () => {
    const html = await render();
    expect(tagOf(html, 'data-space="1" data-half="A"')).toContain("height:0.5in");
    expect(tagOf(html, 'data-space="1" data-half="B"')).toContain("height:0.5in");
    expect(tagOf(html, 'data-space="7"')).toContain("height:1in");
    expect(html.match(/>Mini Split<\/div>/g)).toHaveLength(2);
    expect(html.match(/>EV Charger<\/div>/g)).toHaveLength(2);
    expect(tagOf(html, 'data-space="5"')).toContain('data-kind="pole2"');
    expect(tagOf(html, 'data-space="6"')).toContain('data-kind="pole2"');
    expect(tagOf(html, 'data-space="9"')).toContain('data-kind="empty"');
    expect(tagOf(html, 'data-space="10"')).toContain('data-kind="empty"');
  });

  it("uses the panel's own measurements when a person took them: 1.25 in left, 1.5 in right, 0.75 in a space", async () => {
    seed([panel({ label_width_in: 1.25, label_width_in_right: 1.5, space_pitch_in: 0.75 })], LARKSPUR);
    const html = await render();
    expect(tagOf(html, 'data-strip="left"')).toContain("width:1.25in");
    expect(tagOf(html, 'data-strip="right"')).toContain("width:1.5in");
    expect(tagOf(html, 'data-space="7"')).toContain("height:0.75in");
    expect(tagOf(html, 'data-space="1" data-half="A"')).toContain("height:0.375in");
  });

  it("says the job, the panel and Print at 100%. on screen only, and no tight sentence when every name fits", async () => {
    const html = await render();
    const header = html.slice(html.indexOf("data-labels-header"), html.indexOf("data-strips"));
    expect(html).toMatch(/class="no-print[^"]*print:hidden[^"]*"[^>]*data-labels-header/);
    expect(textOf(header)).toContain("Panel 1");
    expect(textOf(header)).toContain("Larkspur");
    expect(textOf(header)).toContain("Print at 100%.");
    expect(textOf(header)).toContain("Print Labels");
    expect(html).not.toContain("data-tight");
    expect(html).not.toContain("are tight");
  });

  it("says how many labels are tight and which, before anything is printed, and never clips them", async () => {
    seed([panel()], [...LARKSPUR, circuit(9, null, "Abcdefghijklmnopqrstuvwxyzabcd"), circuit(10, "A", "Qwertyuiopasdfghjklzxcvbnmqwer")]);
    const html = await render();
    const tight = textOf(html.slice(html.indexOf("data-tight")));
    expect(tight).toContain("2 labels are tight — shorten them or widen the strip.");
    expect(tight).toContain("Space 9: Abcdefghijklmnopqrstuvwxyzabcd");
    expect(tight).toContain("Space 10A: Qwertyuiopasdfghjklzxcvbnmqwer");
    // The tight box is still drawn, words and all, at the floor, nothing hidden.
    expect(tagOf(html, 'data-space="9"')).toContain('data-pt="tight"');
    expect(tagOf(html, 'data-space="9"')).toContain("font-size:6pt");
    expect(tagOf(html, 'data-space="9"')).toContain("overflow:visible");
    expect(html).toContain(">Abcdefghijklmnopqrstuvwxyzabcd</div>");
    // The Panel tab's Door Labels door sends a person here: the tight sentence comes BEFORE the
    // strips, so it is read before anyone prints.
    expect(html.indexOf("data-tight")).toBeGreaterThan(-1);
    expect(html.indexOf("data-tight")).toBeLessThan(html.indexOf("data-strips"));
  });

  it("?panel= picks the panel; one not on this job is a 404, and so is a job outside the company", async () => {
    seed([panel(), panel({ id: OTHER_PANEL, name: "Sub Panel", label_width_in: 2 })], LARKSPUR);
    const html = await render({ panel: OTHER_PANEL });
    expect(tagOf(html, 'data-strip="left"')).toContain("width:2in");
    expect(textOf(html)).toContain("Sub Panel");
    await expect(render({ panel: "55555555-5555-4555-8555-555555555555" })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render({ panel: "not-a-panel" })).rejects.toThrow("NEXT_NOT_FOUND");
    tables.jobs[0].org_id = "another-company";
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("names itself after the panel and the job — read in the viewer's own company only", async () => {
    const { generateMetadata } = await import("./page");
    const meta = () => generateMetadata({ params: Promise.resolve({ jobId: JOB }), searchParams: Promise.resolve({}) });
    expect((await meta()).title).toBe("Panel 1 Labels — Larkspur");
    // Another company's job and panel never name the page (the query says the org, not RLS alone).
    tables.jobs[0].org_id = "another-company";
    tables.job_panels[0].org_id = "another-company";
    expect((await meta()).title).toBe("Panel Labels — This Job");
  });

  it("a one-panel job's loose kept circuits (on no panel yet) are printed: the door draws them there, so the strips do", async () => {
    seed([panel()], [...LARKSPUR, circuit(9, null, "Snowbell Porch", { panel_id: null })]);
    const html = await render();
    expect(tagOf(html, 'data-space="9"')).toContain('data-kind="single"');
    expect(html).toContain(">Snowbell Porch</div>");
    // With a second panel it is nobody's until a person picks: not printed on Panel 1.
    seed([panel(), panel({ id: OTHER_PANEL, name: "Sub Panel", created_at: "2026-10-30T01:00:00Z" })], [...LARKSPUR, circuit(9, null, "Snowbell Porch", { panel_id: null })]);
    const two = await render();
    expect(two).not.toContain("Snowbell Porch");
    expect(tagOf(two, 'data-space="9"')).toContain('data-kind="empty"');
  });

  it("the space number sits OUTSIDE the box, in the gutter on the strip's outer side, never over a name", async () => {
    const html = await render();
    const nos = [...html.matchAll(/<span aria-hidden="true" data-space-no="" style="([^"]*)">/g)].map((m) => m[1]);
    expect(nos.length).toBeGreaterThan(0);
    for (const s of nos) {
      expect(s).toMatch(/(right|left):calc\(100% \+ 0\.03in\)/);
      expect(s).toContain("font-size:5pt");
    }
    // The left strip's numbers to its left (right: 100% + gap), the right strip's to its right.
    const left = html.slice(html.indexOf('data-strip="left"'), html.indexOf("data-cut"));
    expect(left).toContain("right:calc(100% + 0.03in)");
    expect(left).not.toContain("left:calc(100% + 0.03in)");
    // The strips leave room for them.
    expect(tagOf(html, "data-strips")).toContain("padding:0 0.25in");
    // Each box: the border and inner margin fit.ts measures by, on every side.
    expect(tagOf(html, 'data-space="7"')).toContain("border:0.5pt solid #000");
    expect(tagOf(html, 'data-space="7"')).toContain("padding:0.03in");
  });

  it("says each measurement on its own: a width or a pitch nobody measured is the make's until it is, and how long the strips print", async () => {
    const said = async () => {
      const html = await render();
      return textOf(html.slice(0, html.indexOf("data-strips")));
    };
    expect(await said()).toContain(
      "Each strip is 1.125 in wide, the make's width until the label area is measured. Each space is 1 in tall, the make's size until a space is measured. Each strip is 5 in long.",
    );
    seed([panel({ label_width_in: 1.25 })], LARKSPUR);
    expect(await said()).toContain("Each strip is 1.25 in wide. Each space is 1 in tall, the make's size until a space is measured.");
    seed([panel({ space_pitch_in: 0.75 })], LARKSPUR);
    expect(await said()).toContain("Each strip is 1.125 in wide, the make's width until the label area is measured. Each space is 0.75 in tall.");
    seed([panel({ label_width_in_right: 1.5 })], LARKSPUR);
    expect(await said()).toContain("The left strip is 1.125 in wide and the right 1.5 in; the left is the make's width until it is measured.");
  });

  it("an odd panel prints no box beside its last space: only the gap, so the strips line up", async () => {
    seed([panel({ spaces: 9 })], LARKSPUR);
    const html = await render();
    const none = tagOf(html, 'data-kind="none"');
    expect(none).toContain('data-space="10"');
    expect(none).toContain("height:1in");
    expect(none).not.toContain("border");
    expect(textOf(html)).toContain("The left strip is 5 in long and the right 4 in.");
  });
});
