import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE INSPECTION, RENDERED, FOR EACH OF ITS THREE READERS (0356; Erik, 2026-09-26: "crew leader
 * yes tech no"). Counted on the real component (the dead-door lesson: run the selector, count the
 * doors):
 *
 *   office    unchanged: the address box, the links, the price book, scope prices and their total,
 *             the photo trash, Save and Start The Estimate.
 *   crewLead  fills it in: every control live, Take / Add / Save; no price anywhere (even when a
 *             price is handed in by mistake), no price book, no Start The Estimate, no address box,
 *             no photo trash; every door he can reach is Title Case and 44px.
 *   view      a plain tech: one disabled fieldset and none of the doors that would only fail.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../actions", () => ({
  addInspectionPhotos: vi.fn(),
  removeInspectionPhoto: vi.fn(),
  saveInspectionAnswers: vi.fn(),
  saveInspectionCapture: vi.fn(),
  setAppointmentPlace: vi.fn(),
  linkAppointmentTo: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
vi.mock("../hear-actions", () => ({ hearIntoPlaybook: vi.fn() }));
vi.mock("../../forms/actions", () => ({ createStarterInspectionSheet: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
// The address box is a Places widget; here it only needs to say whether it was drawn.
vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: () => createElement("input", { "data-address-box": "yes" }),
}));

import { Inspector } from "./inspector";
import { sheetsWithoutMoney, type InspectionAccess } from "@/lib/inspection/inspection-access";

const SHEET = {
  id: "sheet-1",
  name: "Site walk",
  schema: [],
  playbook: {
    needs: [
      { key: "work", label: "Work", ask: "What kind of work is this?", slot: { type: "select", options: ["Deck", "Remodel"], other: true } },
      { key: "scope", label: "Scope", ask: "Which scopes?", slot: { type: "scopes" } },
      { key: "panel", label: "Panel", ask: "Which panel is it?", slot: { type: "text" } },
      { key: "tasks", label: "Tasks", ask: "What are the tasks?", slot: { type: "tasks" } },
    ],
  },
};
// A price, handed in as if it leaked: the crew's and the tech's inspection must not draw it.
// The tasks are his: one with his hours and a coded part, one still asking.
const ANSWERS = {
  work: "Remodel",
  scope: [{ code: "R1", qty: 2, price: 517.25 }],
  tasks: [
    { id: "t1", name: "Transfer switch", hours: 3, units: null, kit_id: null, materials: [{ code: "R1", words: null, qty: 2 }] },
    { id: "t2", name: "Hot tub wires", hours: null, units: null, kit_id: null, materials: [] },
  ],
};
const BOOK = [
  { code: "R1", description: "Remodel scope", unit: "EA", price: 517.25 },
  { code: "R2", description: "Demo", unit: "EA", price: 243.5 },
];
const PHOTO = { path: "org-1/appointments/appt-1/1-panel.jpg", url: "https://example.invalid/1-panel.jpg" };
// A TASK KIT (0386, W4) as the page hands it over: minutes for one unit, lines by name and count,
// no money field anywhere (kitsWithoutMoney) — the vendors under a code ride by NAME only, so a part
// previews under the words the estimate will write (item 2, 2026-10-10). Seven footings.
const KIT = {
  id: "k1",
  name: "Footing",
  labor_minutes: 120,
  unit: "footing",
  items: [
    { id: "i1", description: "Concrete, 80 lb", quantity: 4, unit: "ea", sort_order: 0 },
    { id: "i2", description: "Rebar stake", quantity: 2, unit: "ea", sort_order: 1 },
    { id: "i3", description: "Window (snapshot)", quantity: 1, unit: "ea", sort_order: 2, price_list_item_id: "pli-830",
      price_list_items: { id: "pli-830", code: "830", description: "Windows (Allowance)", unit: "ea", archived: false,
        price_list_item_options: [{ id: "o-mar", vendor: "Marvin", label: null, part_number: "M-1", unit: "ea", buy_price: null, is_default: true, sort_order: 0, archived: false }] } },
  ],
};
const KIT_ANSWERS = {
  ...ANSWERS,
  tasks: [{ id: "t1", name: "Footings", hours: null, units: 7, kit_id: "k1", materials: [] }, ANSWERS.tasks[1]],
};

const render = (access: InspectionAccess, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(Inspector, {
      appointmentId: "appt-1",
      orgId: "org-1",
      userId: "u-1",
      templates: [SHEET],
      priceBook: access === "office" ? BOOK : [],
      initialTemplateId: "sheet-1",
      initialAnswers: ANSWERS as never,
      initialCapture: { notes: "Meter base pulling off the wall", photos: [PHOTO.path], measures: [{ id: "m1", label: "Run", value: 40, unit: "ft" }] },
      initialPhotos: [PHOTO],
      initialLocation: "13125 Mayfern Rd",
      linked: { kind: "lead", name: "Sara Dale" },
      estimateHref: access === "office" ? "/quotes/new?capture=appt-1" : null,
      access,
      // THE TASK SHEET (item 2b): one task open at a time. The editor pins below look at t1 open;
      // the sheet's own cases render with every task collapsed to its row.
      initialOpenTaskId: "t1",
      ...over,
    }),
  );

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], open: m[0].match(/^<button[^>]*>/)![0], text: textOf(m[0]) }));
const TARGET = /min-h-\[44px\]|\bh-11\b|\bh-12\b|min-w-\[44px\]/;
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w));
/** Any money on screen: a dollar sign, the "@ rate" of a scope row, or either book price. (The
 *  words "the office prices it" are the point, not a leak.) */
const PRICE = /\$|517|243|@/;

describe("the office: unchanged", () => {
  const html = render("office");
  it("keeps the address box, the price book, the scope prices and their total", () => {
    expect(html).toContain('data-address-box="yes"');
    expect(html).toContain("Add a line item");
    expect(html).toMatch(/Demo — \$243\.5\/EA/);
    expect(textOf(html)).toContain("$1,034.50"); // 2 × 517.25
  });
  it("keeps the photo trash, Save and Start The Estimate, and nothing is disabled", () => {
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain("absolute right-1 top-1"); // the photo's trash
    const t = buttons(html).map((b) => b.text);
    expect(t).toContain("Save");
    expect(t).toContain("Start The Estimate");
    expect(t).toContain("Take");
    expect(t).toContain("Add");
    expect(html).toContain('href="/quotes/new?capture=appt-1"');
  });
});

describe("a crew lead on this visit: fills it in, never a price", () => {
  const html = render("crewLead");
  const t = textOf(html);

  it("says whose it is, and every control is live", () => {
    expect(t).toContain("You're the crew lead on this visit: fill it in here. The office prices it.");
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    const doors = buttons(html).map((b) => b.text);
    for (const d of ["Save", "Take", "Add", "Just Tell Nort", "Deck", "Remodel", "Something Else", "Add A Measurement"]) expect(doors, d).toContain(d);
    // What he answered is still there to edit, and his notes and measurements are his.
    expect(html).toContain("Meter base pulling off the wall");
    expect(html).toMatch(/value="Run"/);
  });

  it("no price, no price book, no Start The Estimate, even with a price handed in", () => {
    expect(t).not.toMatch(PRICE);
    expect(html).not.toContain("Add a line item");
    expect(t).not.toMatch(/Start The Estimate/i);
    expect(html).not.toContain("/quotes/new");
    // What was picked, and how many, and whose job the price is.
    expect(t).toMatch(/R1 × 2/);
    expect(t).toContain("The office picks and prices these.");
  });

  it("the address and the links are the office's: shown, not editable", () => {
    expect(html).not.toContain('data-address-box="yes"');
    expect(t).toContain("13125 Mayfern Rd");
    expect(t).toContain("Sara Dale");
    expect(buttons(html).map((b) => b.text)).not.toContain("change");
  });

  it("he adds photos and never takes one off", () => {
    expect(html).not.toContain("absolute right-1 top-1");
    expect(html).toContain(PHOTO.url);
  });

  it("the sheet can't be switched once one is saved on the visit", () => {
    const two = [SHEET, { ...SHEET, id: "sheet-2", name: "Service call" }];
    expect(render("crewLead", { templates: two })).not.toContain("Pick a sheet");
    expect(render("crewLead", { templates: two, initialTemplateId: null })).toContain("Pick a sheet");
    expect(render("office", { templates: two })).toContain("Pick a sheet");
  });

  it("every door he can reach is Title Case and 44px", () => {
    const bs = buttons(html);
    expect(bs.length).toBeGreaterThan(8);
    for (const b of bs) {
      if (/h-full w-full/.test(b.open)) continue; // a photo tile is the whole thumbnail
      expect(b.open, b.text || b.open).toMatch(TARGET);
      expect(titleCase(b.text), b.text).toBe(true);
    }
  });

  it("a file question: he adds through a 44px door, and never takes the office's file off", () => {
    const withFile = {
      ...SHEET,
      playbook: { needs: [...SHEET.playbook.needs, { key: "plans", label: "Plans", ask: "Upload the plans", slot: { type: "file", multi: true } }] },
    };
    const planPath = "org-1/appointments/appt-1/1700000000000-plans.pdf";
    const over = { templates: [withFile], initialAnswers: { ...ANSWERS, plans: [planPath] } };
    const crewHtml = render("crewLead", over);
    expect(textOf(crewHtml)).toContain("plans.pdf");
    const door = crewHtml.match(/<label[^>]*>(?:(?!<\/label>)[\s\S])*Add Files[\s\S]*?<\/label>/)?.[0] ?? "";
    expect(door).toMatch(TARGET);
    expect(door).toContain('type="file"');
    expect(buttons(crewHtml).map((b) => b.text)).not.toContain("Remove");
    // The office still takes one off.
    expect(buttons(render("office", over)).map((b) => b.text)).toContain("Remove");
  });

  it("with no questions set up, he is told it's the office's, and notes and photos still save", () => {
    const none = textOf(render("crewLead", { templates: [], initialTemplateId: null, initialAnswers: {} }));
    expect(none).toContain("The office hasn't set up inspection questions yet. Notes, measurements and photos below still save.");
    expect(none).not.toMatch(/Set Up My Questions/i);
  });
});

describe("the owner's dollar figures in a why line or a note never reach the crew or a tech", () => {
  // ET's own panel question, as written on production: the why names a price, and so does the note.
  const WHY = "Decides breaker or service change — Zinsco or FPE turns a $400 circuit into a panel swap.";
  const priced = {
    ...SHEET,
    playbook: {
      needs: SHEET.playbook.needs.map((n) =>
        n.key === "panel" ? { ...n, why: WHY, note: "A $400 circuit becomes a panel swap; never price it with the cover on." } : n,
      ),
    },
  };
  it("the office reads its own why line, figure and all", () => {
    expect(textOf(render("office", { templates: [priced] }))).toContain("turns a $400 circuit");
  });
  for (const access of ["crewLead", "view"] as const) {
    it(`${access}: the page's sheets carry the words without the figure, and no note`, () => {
      const sent = sheetsWithoutMoney([priced]);
      expect(JSON.stringify(sent)).not.toMatch(/\$|400|"note"/);
      const t = textOf(render(access, { templates: sent }));
      expect(t).toContain("Zinsco or FPE turns a circuit into a panel swap.");
      expect(t).not.toMatch(/\$|400/);
    });
  }
});

describe("a plain tech: reads it", () => {
  const html = render("view");
  const t = textOf(html);
  it("one disabled fieldset, and none of the doors that would only fail", () => {
    expect(t).toContain("Only the office can change the inspection.");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    const doors = buttons(html).map((b) => b.text);
    for (const d of ["Save", "Take", "Add", "Start The Estimate"]) expect(doors, d).not.toContain(d);
    expect(html).not.toContain("absolute right-1 top-1");
    expect(html).not.toContain('data-address-box="yes"');
  });
  it("never a price, even with one handed in", () => {
    expect(t).not.toMatch(PRICE);
    expect(html).not.toContain("Add a line item");
  });
  it("a crew lead before 0356 gets the same read-only sheet, with the page's line", () => {
    const before = textOf(render("view", { viewNote: "Crew leads can fill this in once the office finishes an update. Until then only the office can change it." }));
    expect(before).toContain("Crew leads can fill this in once the office finishes an update.");
    expect(before).not.toContain("Only the office can change the inspection.");
  });
});

describe("a tasks question: his tasks, his hours, his parts — never a price", () => {
  const pills = (html: string) => (html.match(/>hours\?</g) ?? []).length;

  it("the office: both tasks, the coded part as the book names it, one task asking, both add doors, the book as a list", () => {
    const html = render("office");
    expect(html).toContain('value="Transfer switch"');
    expect(textOf(html)).toContain("Hot tub wires"); // t2 collapsed to its row (the task sheet)
    // A part picked from the book is a chip, not a box: a keystroke must not unlink the code.
    expect(html).toContain('title="R1 — Remodel scope">R1 — Remodel scope</span>');
    expect(pills(html)).toBe(1);
    const doors = buttons(html).map((b) => b.text);
    expect(doors).toContain("Add A Task");
    expect(doors).toContain("Add A Material");
    expect(html).toContain('aria-label="Remove This Task"');
    const list = html.match(/<datalist id="tasks-book-tasks">[\s\S]*?<\/datalist>/)?.[0] ?? "";
    expect(list).toContain('value="R1 — Remodel scope"');
    expect(list).toContain('value="R2 — Demo"');
    expect(list).not.toMatch(PRICE);
  });

  it("a crew lead: the same live control, the coded part by its code (no book), and never a price", () => {
    const html = render("crewLead");
    expect(html).toContain('value="Transfer switch"');
    expect(textOf(html)).toContain("Hot tub wires"); // t2 collapsed to its row (the task sheet)
    expect(html).toContain('title="R1">R1</span>');
    expect(html).not.toContain("Remodel scope");
    expect(html).not.toContain("<datalist");
    expect(pills(html)).toBe(1);
    const doors = buttons(html).map((b) => b.text);
    expect(doors).toContain("Add A Task");
    expect(doors).toContain("Add A Material");
    expect(html).toContain('aria-label="Remove This Task"');
    expect(html).toContain('aria-label="Remove This Material"');
    expect(textOf(html)).not.toMatch(PRICE);
  });

  it("a plain tech: the tasks, read; no door that would only fail", () => {
    const html = render("view");
    expect(html).toContain('value="Transfer switch"');
    expect(textOf(html)).toContain("Hot tub wires"); // t2 collapsed to its row (the task sheet)
    expect(pills(html)).toBe(1);
    const doors = buttons(html).map((b) => b.text);
    expect(doors).not.toContain("Add A Task");
    expect(doors).not.toContain("Add A Material");
    expect(html).not.toContain('aria-label="Remove This Task"');
    expect(textOf(html)).not.toMatch(PRICE);
  });
});

describe("a task kit on the visit (W4): picked by name, counted in units, previewed without a price", () => {
  const pills = (html: string) => (html.match(/>hours\?</g) ?? []).length;
  // The window names its default vendor — the same words the estimate line and the job's list will carry.
  const PREVIEW = "From the kit, for ×7 footing: 14 h · Concrete, 80 lb ×28, Rebar stake ×14, Windows (Allowance) (Marvin, #M-1) ×7";
  // The office's page carries the scope prices above; the TASKS block itself must never carry one.
  // From the tasks question's wrapper (the jump bar's "Tasks" chip comes first on the page now).
  const tasksBlock = (html: string) => html.slice(html.indexOf('id="need-tasks"'), html.indexOf("Measurements", html.indexOf('id="need-tasks"')));

  it("the office: the kit picker, the units box with the kit's word, the preview from the kit; the kit task no longer asks", () => {
    const html = render("office", { taskKits: [KIT], initialAnswers: KIT_ANSWERS });
    expect(html).toContain('aria-label="Kit"');
    expect(html).toContain('<option value="k1"');
    expect(html).toContain(">Footing<");
    expect(html).toContain(">No Kit<");
    // Units count a KIT's units: the box stands beside the kit task, not beside hand-typed hours.
    expect((html.match(/placeholder="units"/g) ?? []).length).toBe(1);
    expect(html).toContain('value="7"');
    expect(textOf(html)).toContain(PREVIEW);
    // Only the hot tub task asks: the footings take their hours from the kit.
    expect(pills(html)).toBe(1);
    expect(tasksBlock(html)).not.toMatch(PRICE);
  });

  it("a crew lead: the same picker and preview, never a price", () => {
    const html = render("crewLead", { taskKits: [KIT], initialAnswers: KIT_ANSWERS });
    expect(html).toContain('aria-label="Kit"');
    expect(html).toContain('<option value="k1"');
    expect(textOf(html)).toContain(PREVIEW);
    expect(textOf(html)).not.toMatch(PRICE);
  });

  it("a plain tech reads the kit's name; no picker", () => {
    const html = render("view", { taskKits: [KIT], initialAnswers: KIT_ANSWERS });
    expect(html).not.toContain("<select");
    expect(textOf(html)).toContain("Kit Footing");
    expect(textOf(html)).toContain(PREVIEW);
    expect(textOf(html)).not.toMatch(PRICE);
  });

  it("without a task kit in the org there is no picker and no units box — his hours are the whole task's", () => {
    const html = render("office");
    expect(html).not.toContain('aria-label="Kit"');
    expect(html).not.toContain('placeholder="units"');
  });

  it("his own hours win over the kit's, and the preview says so", () => {
    const answers = { ...KIT_ANSWERS, tasks: [{ ...KIT_ANSWERS.tasks[0], hours: 3 }, KIT_ANSWERS.tasks[1]] };
    const html = render("office", { taskKits: [KIT], initialAnswers: answers });
    expect(textOf(html)).toContain("From the kit, for ×7 footing: your 3 h stand (the kit says 14 h) · Concrete, 80 lb ×28, Rebar stake ×14, Windows (Allowance) (Marvin, #M-1) ×7");
  });

  it("a kit that left the price list is said, not hidden", () => {
    const html = render("office", { taskKits: [], initialAnswers: KIT_ANSWERS });
    expect(html).toContain('aria-label="Kit"');
    expect(textOf(html)).toContain("kit?");
    expect(tasksBlock(html)).not.toMatch(PRICE);
  });
});

describe("the kits read says how it went (item 3): a sentence once, and never a false 'no longer in the price list'", () => {
  const NOTE = "The kits could not be read — a task's kit picker is off until you reload; its own hours stand.";
  it("every role reads the note once above the tasks (no money in it)", () => {
    for (const access of ["office", "crewLead", "view"] as const) {
      const html = render(access, { taskKits: [], kitsNote: NOTE, kitsUnread: true, initialAnswers: KIT_ANSWERS });
      expect((textOf(html).match(/The kits could not be read/g) ?? []).length).toBe(1);
      // The office's page carries the scope prices above the tasks by design; the TASKS block never does.
      const tasks = html.slice(html.indexOf('id="need-tasks"'), html.indexOf("Measurements", html.indexOf('id="need-tasks"')));
      expect(textOf(tasks)).not.toMatch(PRICE);
      if (access !== "office") expect(textOf(html)).not.toMatch(PRICE);
    }
  });
  it("a task that picked a kit says 'not read' with no picker — not that the kit left the price list", () => {
    const html = render("office", { taskKits: [], kitsNote: NOTE, kitsUnread: true, initialAnswers: KIT_ANSWERS });
    expect(textOf(html)).toContain("kit not read");
    expect(html).not.toContain("No Longer In The Price List");
    expect(html).not.toContain(">kit?<");
    expect(html).not.toContain('aria-label="Kit"'); // nothing to pick from
    expect(textOf(html)).toContain("Kit");
    expect(textOf(html)).toContain("not read");
  });
  it("a kit that is truly gone (the kits were read, it was not among them) still says so", () => {
    const html = render("office", { taskKits: [], initialAnswers: KIT_ANSWERS });
    expect(textOf(html)).toContain("kit?");
    expect(html).toContain("Kit No Longer In The Price List");
    expect(textOf(html)).not.toContain("not read");
  });
  it("a whole read says nothing", () => {
    const html = render("office", { taskKits: [KIT], kitsNote: null, initialAnswers: KIT_ANSWERS });
    expect(textOf(html)).not.toContain("could not be read");
  });
});

describe("the scope lights its kits (field feedback 10-13, item 2): one offer row, the picker grouped by scope", () => {
  const SCOPE_SHEET = {
    ...SHEET,
    playbook: {
      needs: [
        { key: "work", label: "Work", ask: "What kind of work is this?", slot: { type: "scope", options: ["Deck", "Remodel"] } },
        { key: "tasks", label: "Tasks", ask: "What are the tasks?", slot: { type: "tasks" } },
      ],
    },
  };
  const DECK_KITS = [
    { id: "dk1", name: "Footings", labor_minutes: 120, unit: "footing", category: "Deck", items: [] },
    { id: "dk2", name: "Railing", labor_minutes: 30, unit: "lf", category: " deck ", items: [] },
    { id: "rk1", name: "Demo", labor_minutes: 60, unit: "room", category: "Remodel", items: [] },
    { id: "nk", name: "Service call", labor_minutes: 60, unit: "ea", category: null, items: [] },
  ];
  const one = (html: string) => buttons(html).map((b) => b.text);

  it("typed 'deck' (the Something Else box) lights the two Deck kits, blind to case and spacing; a kit already on the list is not offered twice", () => {
    const html = render("office", { templates: [SCOPE_SHEET], taskKits: DECK_KITS, initialAnswers: { work: "deck", tasks: null } });
    expect(one(html)).toContain("Add The Deck Tasks (2)");
    expect(html).toContain(">Something Else<");
    const withOne = render("office", {
      templates: [SCOPE_SHEET],
      taskKits: DECK_KITS,
      initialAnswers: { work: "Deck", tasks: [{ id: "t1", name: "Footings", hours: null, units: null, kit_id: "dk1", materials: [] }] },
    });
    expect(one(withOne)).toContain("Add The Deck Tasks (1)");
    // the picker is grouped: the visit's scope first, Other Kits last
    const sel = withOne.match(/<select aria-label="Kit"[\s\S]*?<\/select>/)?.[0] ?? "";
    const labels = [...sel.matchAll(/<optgroup label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Deck", "Remodel", "Other Kits"]);
    expect(sel).toContain(">No Kit<");
  });
  it("no scope answer, a word no kit is filed under, a plain tech, or the Kits switch off: no offer row", () => {
    expect(one(render("office", { templates: [SCOPE_SHEET], taskKits: DECK_KITS, initialAnswers: { tasks: null } }))).not.toContainEqual(expect.stringMatching(/^Add The .* Tasks/));
    expect(one(render("office", { templates: [SCOPE_SHEET], taskKits: DECK_KITS, initialAnswers: { work: "Hot tub", tasks: null } }))).not.toContainEqual(expect.stringMatching(/^Add The .* Tasks/));
    expect(one(render("view", { templates: [SCOPE_SHEET], taskKits: DECK_KITS, initialAnswers: { work: "Deck", tasks: null } }))).not.toContainEqual(expect.stringMatching(/^Add The .* Tasks/));
    expect(one(render("office", { templates: [SCOPE_SHEET], taskKits: DECK_KITS, kitsPicker: false, initialAnswers: { work: "Deck", tasks: null } }))).not.toContainEqual(expect.stringMatching(/^Add The .* Tasks/));
    // a crew lead fills the visit in: the offer is his too, and it is 44px
    const lead = render("crewLead", { templates: [SCOPE_SHEET], taskKits: DECK_KITS, initialAnswers: { work: "remodel", tasks: null } });
    const row = buttons(lead).find((b) => b.text === "Add The Remodel Tasks (1)");
    expect(row).toBeTruthy();
    expect(row!.open).toMatch(TARGET);
  });
  it("type freely: the scope is a one-line box holding his words; no kit has a category → the flat picker as before", () => {
    const FREE_SHEET = { ...SCOPE_SHEET, playbook: { needs: [{ ...SCOPE_SHEET.playbook.needs[0], slot: { type: "scope" } }, SCOPE_SHEET.playbook.needs[1]] } };
    const flatKits = DECK_KITS.map((k) => ({ ...k, category: null }));
    const html = render("office", { templates: [FREE_SHEET], taskKits: flatKits, initialAnswers: { work: "Panel swap", tasks: [{ id: "t1", name: "Swap", hours: null, units: null, kit_id: null, materials: [] }] } });
    expect(html).toContain('value="Panel swap"');
    expect(html).not.toContain(">Something Else<");
    expect(html).not.toContain("<optgroup");
    expect(html).toContain('<option value="dk1"');
  });
});

describe("the task sheet (field feedback 10-13, item 2b): rows, one open task, its own photos and measurements, the jump bar", () => {
  const PHOTO2 = { path: "org-1/appointments/appt-1/2-task.jpg", url: "https://x/2.jpg" };
  const CAP = {
    notes: "",
    photos: [PHOTO.path, PHOTO2.path],
    photo_meta: { [PHOTO2.path]: { task_id: "t2" } },
    measures: [{ id: "m1", label: "Run", value: 40, unit: "ft" }, { id: "m2", label: "Drop", value: 8, unit: "ft", task_id: "t2" }],
  };
  const over = (x: Record<string, unknown> = {}) => ({ initialOpenTaskId: null, initialCapture: CAP, initialPhotos: [PHOTO, PHOTO2], ...x });

  it("every task collapsed to its row by default: his words, what it still asks, no editor on the page", () => {
    const html = render("office", over());
    expect(html).not.toContain('value="Transfer switch"');
    expect(html).toContain('data-task-row="t1"');
    expect(html).toContain('data-task-row="t2"');
    const t = textOf(html);
    expect(t).toContain("Transfer switch");
    expect(t).toContain("Hot tub wires");
    expect((html.match(/>hours\?</g) ?? []).length).toBe(1); // t2 asks, on its row
    expect(html).toContain("1 photo"); // t2's row counts its own photo and measurement
    expect(html).toContain("1 measurement");
    expect(buttons(html).map((b) => b.text)).toContain("Add A Task");
    expect(buttons(html).map((b) => b.text)).not.toContain("Done");
  });

  it("the open task: its editor, ONLY its photos and measurements, a note, Take / Add that place the shot on it, Done; the visit's list hides the placed measurement", () => {
    const html = render("office", over({ initialOpenTaskId: "t2" }));
    expect(html).toContain('value="Hot tub wires"');
    expect(html).not.toContain('value="Transfer switch"');
    const card = html.slice(html.indexOf('id="task-t2"'), html.indexOf("Add A Task"));
    expect(card).toContain(PHOTO2.url);
    expect(card).not.toContain(PHOTO.url); // the visit's own photo is not on this task
    expect(card).toContain('value="Drop"');
    expect(card).not.toContain('value="Run"');
    expect(card).toContain("What&#x27;s true about this piece");
    expect(card).toContain('aria-label="Remove This Photo"');
    const doors = buttons(card).map((b) => b.text);
    expect(doors).toContain("Take");
    expect(doors).toContain("Add");
    expect(doors).toContain("Add A Measurement");
    expect(doors).toContain("Done");
    // the visit's own Measurements section shows the rows no task claimed
    const visitMeasures = html.slice(html.lastIndexOf(">Measurements<"), html.indexOf("Materials", html.lastIndexOf(">Measurements<")));
    expect(visitMeasures).toContain('value="Run"');
    expect(visitMeasures).not.toContain('value="Drop"');
  });

  it("a crew lead's open task has Take / Add / Done and no photo trash; a plain tech's has none of them", () => {
    const lead = render("crewLead", over({ initialOpenTaskId: "t2" }));
    const card = lead.slice(lead.indexOf('id="task-t2"'), lead.indexOf("Add A Task"));
    const doors = buttons(card);
    expect(doors.map((b) => b.text)).toEqual(expect.arrayContaining(["Take", "Add", "Add A Measurement", "Done"]));
    expect(card).not.toContain('aria-label="Remove This Photo"');
    for (const b of doors.filter((x) => x.text.trim())) expect(b.open, b.text).toMatch(TARGET);
    const view = render("view", over({ initialOpenTaskId: "t2" }));
    const vcard = view.slice(view.indexOf('id="task-t2"'), view.indexOf(">Measurements<", view.indexOf('id="task-t2"') + 200));
    expect(buttons(vcard).map((b) => b.text)).not.toEqual(expect.arrayContaining(["Done"]));
    expect(vcard).not.toContain(">Take<");
  });

  it("the jump bar: Where (the office), Tasks, Photos, Notes — 44px chips above the card, landing on ids", () => {
    const html = render("office", over());
    const bar = html.slice(html.indexOf('aria-label="Jump To"'), html.indexOf("Inspection"));
    const chips = buttons(bar);
    expect(chips.map((b) => b.text)).toEqual(["Where", "Tasks", "Photos", "Notes"]);
    for (const c of chips) expect(c.open).toMatch(TARGET);
    expect(html).toContain('id="insp-where"');
    expect(html).toContain('id="need-tasks"');
    expect(html).toContain('id="insp-photos"');
    const lead = render("crewLead", over());
    expect(buttons(lead.slice(lead.indexOf('aria-label="Jump To"'), lead.indexOf("Inspection"))).map((b) => b.text)).toEqual(["Tasks", "Photos", "Notes"]);
  });
});
