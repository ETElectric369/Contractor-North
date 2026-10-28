import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inStockWords, stockForLines } from "@/lib/materials-stock";
import { apptDayOf } from "@/app/(app)/schedule/add-to-schedule-sheet";
import { hmWords } from "@/lib/schedule/job-block";

/** THE 2026-10-15 ROUND'S THREE ASKS (field-feedback-1015-round items 5, 6, 7). */
const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("New Inspection in the + menu (33b28e4b)", () => {
  it("is the schedule's one create form, opened on the inspection type; Leads off = no door", () => {
    const menu = read("src/components/global-quick-add.tsx");
    expect(menu).toContain('{ label: "New Inspection", href: "/schedule?new=inspection", icon: ClipboardCheck, staffOnly: true, feature: "leads" }');
    const page = read("src/app/(app)/schedule/page.tsx");
    expect(page).toContain('if (sp.new === "appointment" || sp.new === "inspection" || (sp.new === "1" && (sp.view !== "day" || !date))) {');
    expect(page).toContain("redirect(`/schedule?view=day&date=${date ?? todayStrInTz(tz)}&new=1${type ? `&type=${type}` : \"\"}${time ? `&time=${time}` : \"\"}`);");
    const form = read("src/app/(app)/appointments/appointment-button.tsx");
    expect(form).toContain("type: appointment?.type ?? urlSeed.current.type ?? defaultType ?? (defaultJobId ? \"job\" : \"other\"),");
    expect(form).toContain('{ date, time: urlSeed.current.time ?? "08:00" }');
    expect(form).toMatch(/if \(!newParam\.take\(claimant\)\) return;\s*const type = searchParams\.get\("type"\) \?\? "";/);
    expect(form).toContain('params.delete("type");');
    expect(form.split("urlSeed.current = {};").length - 1).toBe(2); // a close AND a save clear it: the next plain open starts clean
    // The seed is read at mount (useState(emptyForm)), so the ref is declared first (skeptic #10: a ReferenceError otherwise).
    expect(form.indexOf("const urlSeed = useRef")).toBeLessThan(form.indexOf("const emptyForm = "));
    // The seeded form is not an edit: the close guard's baseline is taken from it, as applyOrgTz does.
    expect(form).toContain("initialSnap.current = JSON.stringify({ form: seeded, mode: live.mode, slots: live.slots });");
    // Only a type a person could pick, and a clock that exists (hand-typed URLs only).
    expect(form).toContain("(PICKABLE_APPOINTMENT_TYPES as readonly string[]).includes(type)");
    expect(form).toContain("/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time)");
    expect(page).toContain("(PICKABLE_APPOINTMENT_TYPES as readonly string[]).includes(sp.type ?? \"\")");
    expect(page).toContain("/^([01]\\d|2[0-3]):[0-5]\\d$/.test(sp.time ?? \"\")");
  });
});

describe("a tapped time offers a new appointment too (9072ec46)", () => {
  it("the day's Add To Schedule sheet pushes the create intent at that half hour; the calendar closes it once the URL lands", () => {
    const sheet = read("src/app/(app)/schedule/add-to-schedule-sheet.tsx");
    expect(sheet).toContain("<Heading>Or An Appointment</Heading>");
    expect(sheet).toContain("router.push(`/schedule?view=day&date=${apptDayOf(day, at?.day)}&new=1${at?.minute != null ? `&time=${minutesToHm(at.minute)}` : \"\"}`)");
    expect(sheet).not.toMatch(/onClose\(\);\s*router\.push/); // never close-then-push: the Modal's history step would overtake the navigation
    expect(sheet).toContain("New Appointment {at?.minute != null ? `At ${hmWords(minutesToHm(at.minute))}` : `On ${dayWords(apptDayOf(day, at?.day))}`}");
    const cal = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(cal).toContain('if (searchParams.get("new") === "1") setAdding(null);');
    expect(hmWords("14:30")).toBe("2:30 PM"); // the app's own clock words, not a second copy
    expect(apptDayOf("2026-10-16", "2026-10-15")).toBe("2026-10-16");
    expect(apptDayOf("", "2026-10-15")).toBe("2026-10-15"); // a cleared Day box: the tapped day, never a silent today
    expect(apptDayOf("nope", undefined)).toBe("");
  });
});

describe("no money on the materials checklist; the shelf speaks instead (66c77f1c, 28fe1330)", () => {
  it("matches a line to the shelf by name only, exactly, and only what is on hand", () => {
    const shelf = [
      { name: "12/2 NM", unit: "ft", onHand: 250 },
      { name: "12/2 NM 250ft roll", unit: "roll", onHand: 2 },
      { name: "Wire nuts", unit: "ea", onHand: 0 },
      { name: "  wire NUTS ", unit: "ea", onHand: 40 },
    ];
    const items = [
      { id: "a", description: "12/2 nm" },
      { id: "b", description: "Wire Nuts" },
      { id: "c", description: "12/2" },
      { id: "d", description: null },
    ];
    expect(stockForLines(shelf, items)).toEqual({ a: { onHand: 250, unit: "ft" }, b: { onHand: 40, unit: "ea" } });
    // Two rows, one name: added when the unit is the same; a second unit is not added to the first's count.
    expect(stockForLines([{ name: "Staples", unit: "box", onHand: 2 }, { name: "staples", unit: "box", onHand: 3 }], [{ id: "s", description: "Staples" }])).toEqual({ s: { onHand: 5, unit: "box" } });
    expect(stockForLines([{ name: "12/2 NM", unit: "ft", onHand: 250 }, { name: "12/2 NM", unit: "roll", onHand: 2 }], [{ id: "w", description: "12/2 NM" }])).toEqual({ w: { onHand: 250, unit: "ft" } });
    expect(stockForLines(null, items)).toEqual({});
    expect(stockForLines(shelf, null)).toEqual({});
    expect(inStockWords({ onHand: 12, unit: "ea" })).toBe("In Stock · 12 ea");
    expect(inStockWords({ onHand: 2.5, unit: "" })).toBe("In Stock · 2.5");
    expect(inStockWords({ onHand: 2.25, unit: "ft" })).toBe("In Stock · 2.25 ft");
    expect(inStockWords({ onHand: 0.04, unit: "ft" })).toBe("In Stock · 0.04 ft");
    // In the reader's language (cn-v1138): the lead is mt_inStockLead; English with none, byte for byte.
    expect(inStockWords({ onHand: 12, unit: "ea" }, "es")).toBe("En Inventario · 12 ea");
    expect(inStockWords({ onHand: 12, unit: "ea" }, "en")).toBe("In Stock · 12 ea");
  });
  it("neither list page prints a price, a total or a cost box; both read the shelf with Shop Stock on", () => {
    const editor = read("src/app/(app)/materials/[id]/item-editor.tsx");
    for (const gone of ["formatCurrency", "lineExtension", "listTotalLine", "List Total", "No Price Yet", "Est. cost", "est_cost: viewerIsStaff", "eCost"]) expect(editor).not.toContain(gone);
    expect(editor).toContain("est_cost: null, // no money on a checklist: the column stays, nothing here fills it");
    expect(editor).toContain("{!it.purchased && stock?.[it.id] && (");
    const list = read("src/app/(app)/materials/[id]/page.tsx");
    for (const gone of ["formatCurrency", "lineExtension", "readOnlyFigure", "No Price Yet"]) expect(list).not.toContain(gone);
    expect(list).toContain('const shelf = featureOn(sw.features, "shop_stock") ? await shelfForCrew(supabase).catch(() => null) : null;');
    const job = read("src/app/(app)/jobs/[id]/page.tsx");
    expect(job).toContain('const crewShelfP = on("shop_stock") ? shelfForCrew(supabase).catch(() => null) : Promise.resolve(null);'); // started early, awaited by the tab
    expect(job).toContain("const crewShelf = await crewShelfP;");
    // The new-list dialog is a materials door too: no "$ each", no price column, no estimated total.
    const dialog = read("src/app/(app)/materials/new-list-button.tsx");
    for (const gone of ["$ each", "est. material cost", "formatCurrency", "estTotal", "mCost"]) expect(dialog).not.toContain(gone);
    expect(job).toContain("stock={materialsStock}");
  });
});
