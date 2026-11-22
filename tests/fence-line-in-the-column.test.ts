import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dict } from "@/lib/i18n";

/**
 * THE SITE FENCE'S IDLE LINE IS A STRIP IN THE PAGE'S COLUMN, NEVER A COLUMN OF ITS OWN (2026-11-18).
 *
 * The owner, with a photo of his phone: "i cant get it open on my phone something happened with
 * location". Nothing had crashed. He had started his clock after the fact (a typed start, no
 * location), so the fence had no anchor and said its one line about that: "I couldn’t get a location
 * at <the job>, so I can’t offer to clock you out when you leave this job." The monitor that says it
 * was mounted on the shell's ROOT, which is a flex ROW, so the line was laid out as a column beside
 * the page: the full height of the screen, as wide as its sentence. On his phone that was every
 * pixel but the dock, for the whole shift, with nothing on it to tap. On a desktop it took the
 * right-hand two thirds.
 *
 * It had been mounted there since 2026-08-18. Every sentence it says belongs to a state a set-up
 * phone is rarely in (location off, not asked yet, While Using, no anchor), which is how it stood
 * unseen; this one has no door and lasts the shift.
 *
 * WHAT IS PINNED HERE, with no DOM to measure in: the PLACE (the layout mounts the monitor inside
 * the column, between the top bar and <main>, once), the STRIP (the idle return draws the line in a
 * box with the page's gutters that is no box at all when there is no line), THE ROW (what else is
 * mounted on the root, by name, so the next thing mounted there is read first), and GOT IT (the
 * sentence about one clock-in can be put away for that clock-in).
 */
vi.mock("@/app/(app)/timeclock/actions", () => ({ adoptGeofenceAnchor: vi.fn(), geoClockOut: vi.fn(), notifyGeofenceExit: vi.fn() }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));
const { GeofenceIdleLine, IDLE_STRIP, lostSeenFor, markLostSeen } = await import("@/components/geofence-monitor");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const ROOT = path.resolve(__dirname, "..");
const layout = readFileSync(path.join(ROOT, "src/app/(app)/layout.tsx"), "utf8");
const g = readFileSync(path.join(ROOT, "src/components/geofence-monitor.tsx"), "utf8");

const idle = (over: Partial<Parameters<typeof GeofenceIdleLine>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(GeofenceIdleLine, {
      watchOff: false,
      waitingGrant: false,
      fenceDark: null,
      anchorLost: false,
      anchorKnown: true,
      jobLabel: "85 Larkspur",
      onTurnOn: () => {},
      ...over,
    }),
  );

/** Everything that would let a box cover the page: a position of its own, or a height of its own. */
const COVERS = /(^|\s)(fixed|absolute|sticky|inset-\S+|h-screen|h-dvh|h-full|min-h-screen|min-h-dvh|self-stretch|flex-1|grow)(\s|$)/;

describe("The place: the monitor is mounted in the page's column, above <main>", () => {
  const at = (needle: string) => layout.indexOf(needle);
  const root = at('className="app-backdrop flex h-dvh overflow-hidden"');
  const column = at('<div className="flex flex-1 flex-col overflow-hidden">');
  const topbar = at("<Topbar ");
  const monitor = at("<GeofenceMonitor");
  const main = at('<main className="turn-host');
  const mainEnd = at("</main>");

  it("the shell's root is still a row and the page is still a column inside it (what the defect needed)", () => {
    for (const [name, i] of Object.entries({ root, column, topbar, monitor, main, mainEnd })) expect(i, name).toBeGreaterThan(-1);
    expect(root).toBeLessThan(column);
  });

  it("once, after the top bar and before <main>: a strip under the bar, never a sibling of the column", () => {
    expect(layout.split("<GeofenceMonitor").length - 1).toBe(1);
    expect(column).toBeLessThan(topbar);
    expect(topbar).toBeLessThan(monitor);
    expect(monitor).toBeLessThan(main);
    expect(main).toBeLessThan(mainEnd);
    // The column closes right after </main>: nothing of the fence that draws a box follows it on the row.
    const afterMain = layout.slice(mainEnd);
    expect(afterMain).not.toContain("<GeofenceMonitor");
    expect(afterMain).toContain("<FenceStandDown />"); // draws nothing; it only disarms
  });
});

describe("The strip: the page's gutters, nothing when there is no line, and no way to cover a page", () => {
  it("the idle return draws the line inside the strip", () => {
    expect(g).toMatch(/if \(phase === "idle"\)\s*return \(\s*<div className=\{IDLE_STRIP\}>\s*<GeofenceIdleLine/);
  });

  it("the strip has no position and no height of its own, is never printed, and is no box when it is empty", () => {
    expect(IDLE_STRIP.split(" ")).toEqual(["no-print", "bg-slate-50/70", "px-4", "pt-3", "empty:hidden", "shell:px-6"]);
    expect(IDLE_STRIP).not.toMatch(COVERS);
    // The tint is <main>'s own, so the strip reads as the top of the page.
    expect(layout).toContain('<main className="turn-host flex-1 overflow-y-auto bg-slate-50/70 ');
  });

  it("each of the four sentences is a plain block: no position, no height, a width that stops", () => {
    const lines = [
      idle({ watchOff: true }),
      idle({ waitingGrant: true }),
      idle({ fenceDark: "whenInUse" }),
      idle({ fenceDark: "denied" }),
      idle({ fenceDark: "unavailable" }),
      idle({ anchorLost: true, anchorKnown: false }),
      idle({ anchorLost: true, anchorKnown: false, onGotIt: () => {} }),
    ];
    for (const html of lines) {
      const cls = /^<div class="([^"]*)"/.exec(html)?.[1] ?? "";
      expect(cls, html.slice(0, 60)).toContain("max-w-2xl");
      expect(cls, html.slice(0, 60)).not.toMatch(COVERS);
    }
    // Nothing wrong, nothing drawn: the strip is then empty and `empty:hidden` takes its padding too.
    expect(idle()).toBe("");
    expect(idle({ anchorLost: true, anchorKnown: true })).toBe("");
  });
});

describe("The row: what is mounted on the shell's root beside the column draws fixed, in a portal, or nothing", () => {
  it("is this list and no other: read a new one's root element before its name is added here", () => {
    // From the end of the column to the end of the root, comments taken out, every component named.
    const columnEnd = layout.indexOf("</main>\n      </div>\n");
    const rootEnd = layout.indexOf("    </div>\n    </LangProvider>");
    expect(columnEnd).toBeGreaterThan(-1);
    expect(rootEnd).toBeGreaterThan(columnEnd);
    const row = layout.slice(columnEnd, rootEnd).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const mounted = [...new Set([...row.matchAll(/<([A-Z][A-Za-z]+)/g)].map((m) => m[1]))].sort();
    // Each was read on 2026-11-18: a sheet fixed to the screen, a Modal, a fixed button or panel, or null.
    // Suspense is the wrapper of OrgPlaceBiasSlot, which draws nothing. FenceReportHost (cn-v1175)
    // draws nothing until the fence asks, then the daily report's Modal, in a portal.
    expect(mounted).toEqual(
      ["BugReporter", "CommandBar", "FenceReportHost", "FenceStandDown", "NativePushBridge", "OfflineDrain", "OrgPlaceBiasSlot", "SetupHost", "ShellNavigationWatch", "Suspense", "TapToPayAwareness", "TapToPayWarmup"].sort(),
    );
  });
});

describe("Got It: the sentence about one clock-in can be put away for that clock-in", () => {
  const lost = { anchorLost: true, anchorKnown: false } as const;

  it("the lost-anchor line carries the words and one button, Title Case, in both languages", () => {
    const html = idle({ ...lost, onGotIt: () => {} });
    expect(html).toContain("I couldn’t get a location at 85 Larkspur");
    expect(html).toContain("Clock out yourself when you’re done.");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Got It<\/button>/);
    expect(dict("en").cs_gotIt).toBe("Got It");
    expect(dict("es").cs_gotIt).toBe("Entendido");
  });

  it("without a handler it is the words alone, exactly as it was", () => {
    expect(idle(lost)).toBe(
      `<div class="mx-auto mb-3 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">${dict("en").gf_couldntGetLocationAt.replace("{label}", "85 Larkspur")}</div>`,
    );
  });

  it("only that line: the others are about the phone's own setting, keep their own door where they have one, and get no Got It", () => {
    const onGotIt = () => {};
    for (const over of [{ watchOff: true }, { waitingGrant: true }, { fenceDark: "whenInUse" }, { fenceDark: "denied" }, { fenceDark: "unavailable" }] as const) {
      expect(idle({ ...over, onGotIt }), JSON.stringify(over)).not.toContain("Got It");
    }
    // The order did not change: the ask still comes before a lost anchor.
    expect(idle({ waitingGrant: true, ...lost, onGotIt })).toContain("Turn On Location");
    expect(idle({ waitingGrant: true, ...lost, onGotIt })).not.toContain("Got It");
  });

  it("the memory names ONE entry: the next clock-in says its own line, and a phone with no storage just says it again", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
    try {
      expect(lostSeenFor("entry-a")).toBe(false);
      markLostSeen("entry-a");
      expect(lostSeenFor("entry-a")).toBe(true);
      expect(lostSeenFor("entry-b")).toBe(false); // a Switch Job or tomorrow's clock-in is a new entry
      markLostSeen("entry-b");
      expect(lostSeenFor("entry-a")).toBe(false); // one at a time, like the snooze beside it
      // Private mode, storage refused: nothing throws, and the line is simply said again.
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("no storage"); }, setItem: () => { throw new Error("no storage"); } });
      expect(() => markLostSeen("entry-c")).not.toThrow();
      expect(lostSeenFor("entry-c")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the tap is remembered for THIS entry on the phone, and read after mount", () => {
    expect(g).toContain("anchorLost={anchorLost && !lostSeen}");
    expect(g).toContain("useEffect(() => setLostSeen(lostSeenFor(entryId)), [entryId]);");
    expect(g).toContain("return localStorage.getItem(LOST_SEEN_KEY) === entryId;");
    expect(g).toContain("localStorage.setItem(LOST_SEEN_KEY, entryId);");
    expect(g).toMatch(/onGotIt=\{\(\) => \{\s*markLostSeen\(entryId\);\s*setLostSeen\(true\);\s*\}\}/);
  });
});
