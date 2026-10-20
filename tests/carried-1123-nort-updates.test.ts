/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123): three Nort findings in the hand-over of held
 * updates (lib/nort/updates) and the registry of screens (lib/nort/screens). One describe per
 * finding, named by its title.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/test/fake-supabase";
import { REPORTS_LIMIT, holdingFor, readMyUpdates } from "@/lib/nort/updates";
import { SCREENS, SHELL_SPOTS, literalAnchorNames } from "@/lib/nort/screens";

// The Inspector, rendered for the Tasks anchor below: the same mocks its own test uses.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/appointments/actions", () => ({
  addInspectionPhotos: vi.fn(),
  removeInspectionPhoto: vi.fn(),
  saveInspectionAnswers: vi.fn(),
  saveInspectionCapture: vi.fn(),
  setAppointmentPlace: vi.fn(),
  linkAppointmentTo: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
vi.mock("@/app/(app)/appointments/hear-actions", () => ({ hearIntoPlaybook: vi.fn() }));
vi.mock("@/app/(app)/forms/actions", () => ({ createStarterInspectionSheet: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: () => createElement("input", { "data-address-box": "yes" }),
}));

import { Inspector } from "@/app/(app)/appointments/[id]/inspector";

const read = (p: string) => readFileSync(p, "utf8");
const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const me = "u-me";

type Fake = ReturnType<typeof fakeDb>["sb"];

/** A client whose READS of one table fail (its writes still go through) — the way a dropped
 *  connection or a policy error answers a select: no data, an error. */
function readsFail(sb: Fake, table: string): Fake {
  return {
    ...sb,
    from(t: string) {
      const real = sb.from(t);
      if (t !== table) return real;
      let wrote = false;
      const chain: any = new Proxy({}, {
        get(_, k: string) {
          if (k === "then") {
            return wrote
              ? real.then.bind(real)
              : (res: (v: unknown) => void) => res({ data: null, error: { message: "could not reach the database" } });
          }
          return (...a: unknown[]) => {
            if (k === "update" || k === "insert" || k === "delete") wrote = true;
            real[k](...a);
            return chain;
          };
        },
      });
      return chain;
    },
  } as Fake;
}

/** A client that HONOURS .limit() on reads (the fake ignores it) and can slip a change in between
 *  the read and whatever write follows — what PostgREST does that a plain fake does not. */
function realLimits(sb: Fake, onRead?: (table: string) => void): Fake {
  return {
    ...sb,
    from(t: string) {
      const real = sb.from(t);
      let n: number | null = null;
      let wrote = false;
      const chain: any = new Proxy({}, {
        get(_, k: string) {
          if (k === "then") {
            return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
              real.then((r: { data: unknown }) => {
                if (wrote) return res(r);
                const out = n != null && Array.isArray(r.data) ? { ...r, data: r.data.slice(0, n) } : r;
                res(out);
                onRead?.(t);
              }, rej);
          }
          return (...a: unknown[]) => {
            if (k === "limit") n = a[0] as number;
            if (k === "update" || k === "insert" || k === "delete") wrote = true;
            real[k](...a);
            return chain;
          };
        },
      });
      return chain;
    },
  } as Fake;
}

describe("read_my_updates drops read errors, so a yes to the held-updates question can be answered with nothing", () => {
  const tables = () => ({
    bug_reports: [
      { id: "r1", reported_by: me, status: "fixed", filer_notified_at: null, note: "the leads list", created_at: ago(1) },
      { id: "r2", reported_by: me, status: "wontfix", filer_notified_at: null, note: "a thing", created_at: ago(2) },
    ],
    notifications: [
      { id: "n1", user_id: me, type: "daily_report", title: "Daily report from Larkspur Crew", body: "Pulled wire at Bayberry", url: "/planner", read_at: null, created_at: ago(0.1) },
    ],
  });

  it("a failed bug_reports read is SAID, not answered as an empty hold; nothing is stamped, so the ask can be made again", async () => {
    const db = fakeDb(tables());
    const u = await readMyUpdates(me, readsFail(db.sb, "bug_reports"), db.sb);
    expect(u.reports).toEqual([]);
    expect(u.summary).toBeUndefined();
    expect(u.unstamped).toBe("Couldn't read the report updates just now — they are still held, so ask me again.");
    // the held reports are exactly as they were: still held, the next Talk asks again
    expect(db.tables.bug_reports.every((r) => r.filer_notified_at === null)).toBe(true);
    expect((await holdingFor(me, db.sb, db.sb)).reports).toBe(2);
    // what DID read is handed over and stamped as before
    expect(u.dailyReports.map((d) => d.from)).toEqual(["Larkspur"]);
    expect(db.tables.notifications[0].read_at).toBeTruthy();
  });

  it("a failed daily-report read is said too, and the report updates still come through", async () => {
    const db = fakeDb(tables());
    const u = await readMyUpdates(me, db.sb, readsFail(db.sb, "notifications"));
    expect(u.dailyReports).toEqual([]);
    expect(u.unstamped).toBe("Couldn't read the daily reports just now — they are still held, so ask me again.");
    expect(u.reports.map((r) => r.outcome)).toEqual(["shipped", "not being built"]);
    expect(db.tables.bug_reports.every((r) => r.filer_notified_at)).toBe(true);
    expect(db.tables.notifications[0].read_at).toBeNull();
  });

  it("both reads failing names both, in ONE ask; a stamp that misses on top of a failed read says that as well", async () => {
    const db = fakeDb(tables());
    const both = readsFail(readsFail(db.sb, "bug_reports"), "notifications");
    const u = await readMyUpdates(me, both, both);
    expect(u.reports).toEqual([]);
    expect(u.dailyReports).toEqual([]);
    expect(u.unstamped).toBe("Couldn't read the report updates and the daily reports just now — they are still held, so ask me again.");
    // a read that failed AND a stamp that was refused: both sentences, nothing swallowed
    const refused = fakeDb(tables(), { onUpdate: (table) => (table === "notifications" ? { message: "permission denied" } : undefined) });
    const mixed = await readMyUpdates(me, readsFail(refused.sb, "bug_reports"), refused.sb);
    expect(mixed.unstamped).toBe(
      "Couldn't read the report updates just now — they are still held, so ask me again. Couldn't mark the daily reports as heard — they will be offered again.",
    );
  });

  it("a clean read says nothing extra", async () => {
    const db = fakeDb(tables());
    const u = await readMyUpdates(me, db.sb, db.sb);
    expect(u.unstamped).toBeUndefined();
    expect(u.reports).toHaveLength(2);
  });
});

describe("One yes stamps every unheard report as heard, including those past the 100 read and any filed since the read", () => {
  const backlog = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`, reported_by: me, status: i % 5 === 4 ? "wontfix" : "fixed", filer_notified_at: null as string | null,
      note: `thing ${i}`, created_at: ago(20 + i), // r0 newest, r129 oldest — the table is already newest first
    }));
  const tables = (n: number) => ({ bug_reports: backlog(n), notifications: [] as Record<string, unknown>[] });

  it("a filer with 130 unheard hears the newest 100 and ONLY those are marked heard; the other 30 stay held and are named next time", async () => {
    expect(REPORTS_LIMIT).toBe(100);
    const db = fakeDb(tables(130));
    const sb = realLimits(db.sb);
    const u = await readMyUpdates(me, sb, sb);
    expect(u.reports).toHaveLength(100);
    expect(u.summary?.total).toBe(100);
    expect(u.unstamped).toBeUndefined();
    const heard = db.tables.bug_reports.filter((r) => r.filer_notified_at).map((r) => r.id).sort();
    expect(heard).toEqual(Array.from({ length: 100 }, (_, i) => `r${i}`).sort());
    // the oldest 30 — including the not-being-built decisions — were never read out, so they are still held
    const left = db.tables.bug_reports.filter((r) => !r.filer_notified_at);
    expect(left).toHaveLength(30);
    expect(left.some((r) => r.status === "wontfix")).toBe(true);
    expect((await holdingFor(me, sb, sb)).reports).toBe(30);
    // and the second yes hands them over, so nothing is lost
    const again = await readMyUpdates(me, sb, sb);
    expect(again.reports).toHaveLength(30);
    expect(again.summary?.notBeingBuilt).toBe(left.filter((r) => r.status === "wontfix").length);
    expect((await holdingFor(me, sb, sb)).reports).toBe(0);
  });

  it("a report resolved between the read and the write is NOT marked heard", async () => {
    const db = fakeDb(tables(3));
    let slipped = false;
    const sb = realLimits(db.sb, (t) => {
      if (t === "bug_reports" && !slipped) {
        slipped = true; // resolved just after the read came back, before the stamp
        db.tables.bug_reports.push({ id: "late", reported_by: me, status: "fixed", filer_notified_at: null, note: "resolved a moment ago", created_at: ago(0.01) });
      }
    });
    const u = await readMyUpdates(me, sb, sb);
    expect(u.reports).toHaveLength(3);
    expect(u.unstamped).toBeUndefined();
    expect(db.tables.bug_reports.find((r) => r.id === "late")?.filer_notified_at).toBeNull();
    expect((await holdingFor(me, sb, sb)).reports).toBe(1);
  });

  it("the stamp is by the ids that were read, with the guards kept (source pin: the fake cannot see the query text)", () => {
    const s = read("src/lib/nort/updates.ts");
    expect(s).toContain('.in("id", ids).eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).select("id");');
    expect(s).toContain("const ids = rows.map((r) => r.id);");
    // a SKIP is the one place that marks by filter — they said skip to ALL of them
    expect(s).toContain('.eq("reported_by", userId).in("status", RESOLVED).is("filer_notified_at", null).select("id");');
  });
});

describe("Registry anchor need-tasks is not an id the pages carry in real companies, so Nort cannot ring the Tasks", () => {
  // A playbook's keys are its owner's own: the editor makes q_<time36>, no starter sets "tasks".
  const KEY = "q_mq1x2y3z";
  const SHEET = {
    id: "sheet-1",
    name: "Site walk",
    schema: [],
    playbook: {
      needs: [
        { key: "work", label: "Work", ask: "What kind of work is this?", slot: { type: "select", options: ["Deck", "Remodel"], other: true } },
        { key: KEY, label: "Tasks", ask: "What are the tasks?", slot: { type: "tasks" } },
      ],
    },
  };
  const html = renderToStaticMarkup(
    createElement(Inspector, {
      appointmentId: "appt-1",
      orgId: "org-1",
      userId: "u-1",
      templates: [SHEET],
      priceBook: [],
      initialTemplateId: "sheet-1",
      initialAnswers: { work: "Remodel", [KEY]: [{ id: "t1", name: "Transfer switch", hours: 3, units: null, kit_id: null, materials: [] }] } as never,
      initialCapture: { notes: "", photos: [], measures: [] },
      initialPhotos: [],
      initialLocation: "",
      linked: null,
      estimateHref: null,
      access: "office",
    } as never),
  );

  it("on a playbook whose Tasks key is the owner's own, the page carries the one fixed id the registry names", () => {
    const tasksSpot = SCREENS.find((s) => s.path === "/appointments/<id>")!.spots!.find((sp) => sp.say === "the Tasks")!;
    expect(tasksSpot.name).toBe("insp-tasks");
    expect(html).toContain(`id="need-${KEY}"`); // the wrapper is the owner's key …
    expect(html).not.toContain('id="need-tasks"'); // … so the old registry name was never on this page
    expect(html).toContain(`id="${tasksSpot.name}"`); // … and the fixed name is
    expect(html.split('id="insp-tasks"').length - 1).toBe(1);
  });

  it("no fixed need-… name is in the registry (a playbook key is not ours to promise); only the placeholder is", () => {
    const names = [...SCREENS.flatMap((s) => (s.spots ?? []).map((sp) => sp.name)), ...SHELL_SPOTS.map((sp) => sp.name)];
    expect(names.filter((n) => n.startsWith("need-"))).toEqual(["need-<question key>"]);
    expect(literalAnchorNames().filter((n) => n.startsWith("need-"))).toEqual([]);
  });

  it("the test that holds the registry to the markup no longer has a need family that vouches for a guessed key", () => {
    const t = read("tests/field-1014-screen.test.ts");
    expect(t).not.toContain('need: ["tasks"]');
  });
});
