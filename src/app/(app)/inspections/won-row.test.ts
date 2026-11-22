import { describe, it, expect } from "vitest";
import { translator } from "@/lib/i18n";
import { inspectionRowBuilder } from "./row-words";
import { primaryOf } from "./list-rows";
import { rowButtons, wonSheetHref } from "@/lib/action-items/row-buttons";
import { AFFORDANCES, KIND_GROUP, type ActionItem } from "@/lib/action-items/types";

/**
 * A WIN WITH NO JOB ON THE LISTS (cn-v1176, E5). The Inspections row and the Needs You row of a visit
 * marked Won with no job say "Won · Start the Job" and open the Won sheet on the visit (?won=1); the
 * Done as <job>? offer is restored on such a row (a job made for this customer after the visit is the
 * likeliest answer); the row's ⋯ is unchanged (Not Sold, with Open Inspection when the offer took the
 * boxed button). Stand-in names only.
 */
const NOW = new Date("2026-11-21T20:00:00.000Z");
const TZ = "America/Los_Angeles";
const build = (lang: "en" | "es") => inspectionRowBuilder({ t: translator(lang), lang, tz: TZ, now: NOW, estimatesOn: true });
const WON = {
  id: "v-won",
  type: "inspection",
  title: "Inspection: Dana Rook",
  outcome: "won",
  job_id: null,
  status: "completed",
  starts_at: "2026-11-15T18:00:00.000Z",
  ends_at: null,
  created_at: "2026-11-10T18:00:00.000Z",
  location: "4 Snowbell Ct",
  customers: { name: "Dana Rook" },
  customer_id: "cust-dana",
  inquiry_id: null,
};
const OFFER = { kind: "job" as const, id: "job-900", label: "J-900", others: [{ kind: "job" as const, id: "job-901", label: "J-901" }] };

describe("the Inspections row of a win with no job", () => {
  it("its boxed button is Won · Start the Job, to the Won sheet, in both languages", () => {
    expect(primaryOf("write_up", { decidable: true, estimatesOn: true, wonNoJob: true })).toBe("wonStart");
    const en = build("en").rowOf(WON, "write_up");
    expect(en.primary).toEqual({ label: "Won · Start the Job", href: "/appointments/v-won?won=1" });
    expect(en.stateWord).toBe("Won, No Job Picked");
    // cn-v1181 (I1): every row's ⋯ holds Open Inspection first when the boxed button does not say it.
    expect(en.doors).toEqual(["open", "lost"]);
    const es = build("es").rowOf(WON, "write_up");
    expect(es.primary).toEqual({ label: "Ganada · Empezar el Trabajo", href: "/appointments/v-won?won=1" });
  });

  it("the Done as <job>? offer is restored on it, with Open Inspection behind the ⋯", () => {
    const row = build("en").rowOf(WON, "write_up", OFFER);
    expect(row.offer).toEqual({ id: "job-900", label: "J-900" });
    expect(row.offerOthers).toEqual([{ id: "job-901", label: "J-901" }]);
    // cn-v1181 (I3): the offer is the boxed button, and Won · Start the Job moves behind the ⋯ (a second
    // job is never the first thing offered when the job exists), to the Won sheet.
    expect(row.doors).toEqual(["open", "wonStart", "lost"]);
    expect(row.wonHref).toBe("/appointments/v-won?won=1");
    // The won row's button underneath is still the Won sheet's (drawn when no offer takes its place).
    expect(row.primary.href).toBe("/appointments/v-won?won=1");
  });

  it("an undecided row is as it was", () => {
    const row = build("en").rowOf({ ...WON, outcome: null }, "write_up");
    expect(row.primary.label).toBe("Create Estimate");
    expect(row.primary.href).not.toContain("won=1");
  });
});

describe("the Needs You row of a win with no job", () => {
  it("Won · Start the Job, to the Won sheet; Write It Up otherwise", () => {
    const item: ActionItem = {
      id: "v-won",
      kind: "inspection_writeup",
      group: KIND_GROUP.inspection_writeup,
      title: "Dana Rook",
      when: null,
      urgency: 1,
      done: false,
      href: "/appointments/v-won",
      affordances: AFFORDANCES.inspection_writeup,
      wonNoJob: true,
    };
    const doors = rowButtons(item, { leadsOn: true, isStaff: true });
    expect(doors.primary?.label).toBe("Won · Start the Job");
    expect(doors.primary?.act).toEqual({ type: "open", href: "/appointments/v-won?won=1" });
    const plain = rowButtons({ ...item, wonNoJob: false }, { leadsOn: true, isStaff: true });
    expect(plain.primary?.label).toBe("Write It Up");
    expect(plain.primary?.act).toEqual({ type: "open", href: "/appointments/v-won" });
    const es = rowButtons(item, { leadsOn: true, isStaff: true, lang: "es", words: translator("es") } as never);
    expect(es.primary?.label).toBe("Ganada · Empezar el Trabajo");
    expect(wonSheetHref("/appointments/v-1")).toBe("/appointments/v-1?won=1");
    expect(wonSheetHref("/appointments/v-1?start=1")).toBe("/appointments/v-1?start=1&won=1");
    expect(wonSheetHref("/appointments/v-1?won=1")).toBe("/appointments/v-1?won=1");
  });
});

describe("cn-v1176 fix F2: the Won button only where the Won sheet takes the visit", () => {
  it("an estimate visit marked Won with no job gets it; a call or a meeting keeps a button that opens the visit", () => {
    expect(build("en").rowOf({ ...WON, type: "quote" }, "write_up").primary.href).toBe("/appointments/v-won?won=1");
    for (const type of ["call", "meeting"]) {
      const row = build("en").rowOf({ ...WON, type }, "coming_up");
      expect(row.primary.href, type).toBe("/appointments/v-won");
      expect(row.primary.label, type).not.toBe("Won · Start the Job");
    }
  });
  it("the Needs You row's flag is made by the same rule (won-sheet wonStartShown), never the bare outcome", async () => {
    const { readFileSync } = await import("node:fs");
    const q = readFileSync("src/lib/action-items/query.ts", "utf8");
    expect(q).toContain("wonNoJob: wonStartShown({ type: a.type, outcome: a.outcome, hasJob: !!a.job_id }),");
    expect(q).not.toContain('wonNoJob: a.outcome === "won" && !a.job_id,');
  });
});

describe("cn-v1181 fixer: inspectionFileHref's comment says where a name with no file is a link now (F18)", () => {
  it("names the Inspections page's link to the visit, and the one list that still draws plain words", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/lib/inspections.ts`, "utf8");
    const doc = src.slice(src.lastIndexOf("/**", src.indexOf("export function inspectionFileHref")), src.indexOf("export function inspectionFileHref"));
    expect(doc).toContain("On the Inspections page such a name is still a link, to the visit itself");
    expect(doc).toContain("`nameOpensVisit`");
    expect(doc).not.toMatch(/the name is plain words, and the row's button still opens the visit/);
  });
});
