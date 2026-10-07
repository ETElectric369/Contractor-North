import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { countDoors, doorsIn, sectionOf, textOf } from "@/test/rendered-page";
import { RECONCILE_ANSWERED_HERE, RECONCILE_KINDS } from "@/lib/reconcile-kinds";
import { LIST_ACCEPT, STATEMENT_ACCEPT } from "@/lib/open-list-file";
import { createElement } from "react";
import { InfoBullets } from "@/components/info-popup";
import { STATEMENT_FACTS } from "./statement-facts";

/**
 * EVERY DOOR THAT MOVED OFF /bills HAS A HOME HERE, AND NOWHERE ELSE (cn-v1037).
 *
 * The bottom fold of /bills held five things. Four of them moved to this page as one unit — the
 * merge proposals, the one question the matcher will not answer, the loose spellings and the ticket
 * filed to two jobs — because they are literally derived from each other: what is "loose" is what no
 * proposal and no question already speaks for. The fifth (an import picker) was DELETED, because it
 * was a second copy of Snap Or Note.
 *
 * A move like that is exactly how a door the office uses goes missing without anybody noticing. So
 * this renders THE PAGE ITSELF — the server component, with a fake database answering in live shapes
 * — and finds every door, in the section that is its home, exactly once. bills-page-doors.test.ts
 * asserts the mirror image: that none of them is still over there.
 *
 * SYNTHETIC THROUGHOUT. Every supplier name, account number, job and figure below is invented. This
 * repository is public and no real customer, supplier or bank row goes in a committed file.
 */

const ORG = "org-synthetic";
const NORTH = "acct-north";
const TILL = "acct-till";
const J1 = "job-sycamore";
const J2 = "job-bramble";
const J3 = "job-kestrel";

const job = (id: string, job_number: string, name: string, address: string) => ({
  id,
  job_number,
  name,
  status: "in_progress",
  address,
  created_at: "2026-08-01T00:00:00Z",
  customers: null,
});
const JOBS = [
  job(J1, "J-101", "12 Sycamore Row", "12 Sycamore Row"),
  job(J2, "J-102", "4 Bramble Lane", "4 Bramble Lane"),
  job(J3, "J-103", "88 Kestrel Way", "88 Kestrel Way"),
];
const jobRef = (id: string) => {
  const j = JOBS.find((x) => x.id === id)!;
  return { job_number: j.job_number, name: j.name };
};

let lineSeq = 0;
const line = (description: string, amount: number) => ({
  id: `line-${++lineSeq}`,
  description,
  quantity: 1,
  unit_price: amount,
  amount,
  category: "Materials",
  sort_order: lineSeq,
});
const bill = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier: "Northside Wholesale Supply, Inc. (NWS)",
  bill_number: null,
  amount: 0,
  status: "unpaid",
  bill_date: "2026-09-01",
  job_id: null,
  po_id: null,
  category: null,
  notes: null,
  supplier_account_id: null,
  supplier_invoice_number: null,
  is_statement: false,
  superseded_by_bill_id: null,
  pricing_provisional: false,
  jobs: null,
  bill_line_items: [],
  ...over,
});

/** The identical ticket, line for line to the penny, that lands on two jobs. */
const SIX = ["Lever connector 3-port", "1/2 conduit", "1/2 conduit coupling", "4in square box", "4in square ring", "12 AWG black"];
const ticketLines = () => SIX.map((d) => line(d, 7.25));

const BILLS = [
  // ── ON THE ACCOUNT, so the page can draw their papers against ours ──
  bill("b-north-1", { amount: 1200, bill_date: "2026-09-02", job_id: J1, jobs: jobRef(J1), supplier_account_id: NORTH }),
  bill("b-north-2", { amount: 300, bill_date: "2026-09-08", job_id: J1, jobs: jobRef(J1), supplier_account_id: NORTH }),
  // ── TWO SPELLINGS ON NO ACCOUNT THAT LOOK LIKE ONE: the merge proposal ──
  // STILL OPEN, and that is load-bearing now (cn-v1041): a purchase paid at the register has ONE
  // record, so it is not a disagreement and no section here speaks for it. These used to be `paid`,
  // which is how the fixture drew a page Erik would never have been shown.
  bill("b-ridge-1", { supplier: "Ridgeway's Fastener Depot", amount: 61.4, category: "Receipt", bill_date: "2026-08-11", job_id: J2, jobs: jobRef(J2) }),
  bill("b-ridge-2", { supplier: "Ridgeways Fastener Depot", amount: 44.15, category: "Receipt", bill_date: "2026-08-19", job_id: J2, jobs: jobRef(J2) }),
  // ── A SPELLING THE MATCHER WILL NOT RULE ON: same initials as the account, first word differs ──
  bill("b-maybe", { supplier: "Northern Wholesale Supply", amount: 475.5, category: "Receipt", bill_date: "2026-07-21", job_id: J2, jobs: jobRef(J2) }),
  // ── A SPELLING WITH NO RELATIVE AT ALL: Give It Its Own Account, and nothing filed it under an
  //    expense category, so it is the one row that gets asked ("if it's unclear ask") ──
  bill("b-loose", { supplier: "Harbour Point Tool Rental", amount: 88.9, bill_date: "2026-06-30", job_id: J3, jobs: jobRef(J3) }),
  // ── THE SAME TICKET ON TWO JOBS ──
  bill("b-dup-a", { amount: 43.5, bill_date: "2026-07-29", job_id: J3, jobs: jobRef(J3), supplier_account_id: NORTH, notes: "portal-20260729-1.pdf", bill_line_items: ticketLines() }),
  bill("b-dup-b", { amount: 43.5, bill_date: "2026-08-28", job_id: J2, jobs: jobRef(J2), supplier_account_id: NORTH, notes: "bramble ticket.pdf", bill_line_items: ticketLines() }),
];

const doc = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier_account_id: NORTH,
  invoice_number: "",
  kind: "invoice",
  invoice_date: "2026-09-01",
  due_date: null,
  job_name_raw: null,
  job_id: null,
  total: 0,
  open_balance: null,
  closed: false,
  discount_amount: null,
  discount_by: null,
  source_file: null,
  jobs: null,
  ...over,
});
/** Their own book: ONE open invoice for $500.00. Our own four open tickets there come to $1,587.00
 *  (both copies of the twice-filed ticket count until he picks a job), so the two records are
 *  $1,087.00 apart — which is what the page must lead with. */
const SUPPLIER_INVOICES = [doc("d-open", { invoice_number: "9900-1", invoice_date: "2026-09-02", total: 500, open_balance: 500 })];

const TABLES: Record<string, unknown[]> = {
  profiles: [{ id: "user-owner", org_id: ORG, role: "owner", full_name: "A N Owner" }],
  organizations: [{ settings: { timezone: "America/Los_Angeles" }, name: "Synthetic Electric" }],
  bills: BILLS,
  jobs: JOBS,
  supplier_accounts: [
    { id: NORTH, name: "Northside Wholesale Supply", account_number: "SYN-7", branch_code: "4100", on_account: true, note: null },
    { id: TILL, name: "Lakeside Hardware", account_number: null, branch_code: null, on_account: false, note: null },
  ],
  supplier_aliases: [
    { id: "al-1", supplier_account_id: NORTH, alias: "Northside Wholesale Supply, Inc. (NWS)", branch_label: null },
    { id: "al-2", supplier_account_id: TILL, alias: "Lakeside Hardware", branch_label: null },
  ],
  supplier_payments: [],
  supplier_invoices: SUPPLIER_INVOICES,
  bill_supplier_invoices: [],
};

/** The database the fake answers from: the fixture, a tech's, or a new company's (nothing yet). */
let CURRENT: Record<string, unknown[]> = TABLES;

function chain(table: string) {
  const rows = CURRENT[table] ?? [];
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "ilike", "filter", "range"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
  c.single = c.maybeSingle;
  c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, err);
  return c;
}
const fake = {
  auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) },
  from: (t: string) => chain(t),
  rpc: async () => ({ data: null, error: null }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake, createServiceClient: () => fake }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));

/** Where a redirect went, so the staff gate can be proved without a Next runtime. */
let redirectedTo: string | null = null;
class RedirectError extends Error {}
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/reconcile",
  redirect: (to: string) => {
    redirectedTo = to;
    throw new RedirectError(to);
  },
}));

const render = async () => {
  const { default: ReconcilePage } = await import("./page");
  return renderToStaticMarkup((await ReconcilePage()) as React.ReactElement);
};

let html = "";
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
  html = await render();
}, 30_000);
afterAll(() => vi.useRealTimers());

const section = (id: string) => sectionOf(html, id);
const doors = doorsIn;
const text = textOf;
const count = countDoors;

/**
 * EVERY DOOR THAT WAS IN /bills' "More" FOLD, AND WHERE IT LIVES NOW. `home` is the section id it
 * must be found in; `times` is how many of it that home must hold for this fixture, which is what
 * "exactly one home" means for a door that repeats per row.
 */
const HOMES: { door: string | RegExp; was: string; home: string; times?: number }[] = [
  { door: /^Accept And (File Them There|Make The Account)$/, was: "/bills More: Supplier Names That Look Like One Account", home: "supplier-names" },
  { door: "Not The Same", was: "/bills More: Supplier Names That Look Like One Account", home: "supplier-names" },
  { door: "Join Them Onto One Account", was: "/bills More: Same Supplier, Or Two?", home: "same-supplier-or-two" },
  { door: "Keep Them Separate", was: "/bills More: Same Supplier, Or Two?", home: "same-supplier-or-two" },
  { door: "Give It Its Own Account", was: "/bills More: Supplier Names Not On An Account Yet", home: "not-on-an-account" },
  { door: /^Keep It On /, was: "/bills More: The Same Ticket On Two Jobs", home: "same-ticket-two-jobs", times: 2 },
];

describe("the doors that moved off Bills each have exactly one home here", () => {
  for (const h of HOMES) {
    it(`${String(h.door)} (was: ${h.was}) lives in ${h.home}`, () => {
      const inHome = count(doors(section(h.home)), h.door);
      if (h.times != null) expect(inHome).toBe(h.times);
      else expect(inHome).toBeGreaterThanOrEqual(1);
      // And nowhere else on the page.
      expect(count(doors(html), h.door)).toBe(inHome);
    });
  }

  it("nothing it used to do has been lost: all six doors are on the page", () => {
    const all = doors(html);
    for (const h of HOMES) expect(count(all, h.door), String(h.door)).toBeGreaterThanOrEqual(1);
  });

  /**
   * THE SECOND COPY THAT WAS DELETED RATHER THAN MOVED. The import picker was a paper-intake door,
   * and a paper-intake door here would have made Reconcile the thing Erik's law forbids: a screen
   * that controls a system rather than one that fills in dots.
   */
  it("carries no paper-intake door of its own", () => {
    for (const gone of ["Choose Supplier PDFs", "Snap Or Note", "Add By Hand", "Paste Text Instead", "Import Documents"]) {
      expect(count(doors(html), gone), gone).toBe(0);
    }
  });
});

/**
 * ERIK'S LAW, AS A TEST: "reconcile is the bottom fold filling in dots not controlling systems, a
 * peace maker". The supplier gap is the page's lead and it is READ-ONLY — the figures belong to
 * lib/supplier-owed.ts and the screen that records a payment is the Suppliers card on /bills.
 */
describe("the page reads; it does not re-rule", () => {
  it("the supplier gap draws two sides against each other, names the difference, and offers a link, not a button", () => {
    const gap = section(RECONCILE_KINDS["supplier-gap"].anchor);
    // Ours and theirs, both named, with the supplier's own name on their side.
    expect(text(gap)).toContain("Your Tickets");
    expect(text(gap)).toContain("Northside Wholesale Supply Says");
    // $1,587.00 ours (four open tickets on that account) against $500.00 theirs: $1,087.00 apart.
    expect(text(gap)).toContain("$1,587.00");
    expect(text(gap)).toContain("$500.00");
    expect(text(gap)).toContain("$1,087.00 Apart");
    expect(text(gap)).toContain("4 bills bought on account and not squared up yet");
    // TEXT TO VISUAL: two bars, scaled against the bigger pile, not two paragraphs.
    expect((gap.match(/rounded-full/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Its one door is a LINK to the screen that owns those figures. No form, no button.
    expect(count(doors(gap), /^Open Northside Wholesale Supply On Bills$/)).toBe(1);
    expect(gap).toContain('href="/bills#supplier-invoices-acct-north"');
    expect(gap).not.toContain("<button");
    expect(gap).not.toContain("<form");
  });

  it("leads with ONE number, and it is the money in dispute rather than a count of rows", () => {
    // The lead is the sum of every supplier's gap, said before anything else on the page.
    const lead = text(html.slice(0, html.indexOf(`id="${RECONCILE_KINDS["supplier-gap"].anchor}"`)));
    expect(lead).toContain("$1,087.00");
    expect(lead).toContain("is the difference between what your own bills say you bought on account");
    expect(lead).not.toMatch(/^\s*\d+ Things/);
  });

  /**
   * THE STATEMENT DOOR IS AN INTAKE, NOT A CONTROL. Erik asked for it here twice ("i want to upload
   * my bank statement and supplier statement, every item will either match or need a category", and
   * of the line on Money: "this should be in reconcile too i imagine"), and it moved off /analytics
   * rather than being copied: one door. It DOES carry the Apply, since 2026-10-03: answering a statement
   * IS the reconciliation, and this page still owns no record — every write goes through the server
   * action the card always called, and the same card is drawn in the Organize tray and on Snap Or Note's
   * own sheet, so no screen is the only door to it. (This docblock used to say the opposite, which is the
   * sentence a maintainer would have cited to move the cards back.) With nothing waiting there is no
   * Apply on the page, because there is nothing to apply.
   */
  it("takes a statement in, answers it here, and shows no Apply while nothing is waiting", () => {
    expect(count(doors(html), "Drop A Bank Or Supplier Statement")).toBe(1);
    expect(text(html)).toContain("Bring In A Statement");
    // ANSWERED WHERE IT IS DROPPED SINCE 2026-10-03. Erik: "so it still doesnt make sense to me that
    // all this reconcile stuff is on the bills page." This used to say "answered on its own card under
    // Needs You on Bills", and sending him to another page to finish what he had just started is the
    // merry-go-round. The card is inside this one now, so the copy promises no other page — and with
    // nothing waiting there is still no Apply anywhere on the page.
    expect(text(html)).toContain("Whatever you drop waits here on its own card");
    expect(text(html)).not.toContain("Needs You on Bills");
    expect(count(doors(html), "Open Bills")).toBe(0);
    for (const gone of ["Apply", "Undo It", "Swap"]) expect(count(doors(html), gone), gone).toBe(0);
  });

  /**
   * AND THE DOOR THAT WAS NAMED "BELOW THIS CARD" ON MONEY NOW LANDS HERE. The Net Profit card's
   * Owner's Draw line said "Drop Your Bank Download below to change that" because the door was three
   * inches under it on /analytics. With the door moved, "below" pointed at nothing — so it is a link
   * now, and a link to an anchor that is not drawn is the same dead end from the other end.
   */
  it("the anchor the Net Profit card links to is drawn on this page, for either half of the gate", () => {
    const card = readFileSync(join(process.cwd(), "src/app/(app)/analytics/left-for-card.tsx"), "utf8");
    expect(card).toContain('href="/reconcile#bring-in-a-statement"');
    expect(card).not.toContain("Drop Your Bank Download");
    expect(html).toContain('id="bring-in-a-statement"');
  });

  /**
   * AND IT NAMES WHAT IT ACTUALLY READS. The door takes the PDF statement a supplier emails now (the
   * pages are read as a table: lib/pdf-table.ts), so the copy names the PDF — and names the one PDF
   * it still cannot do anything with, a SCAN, with the door that can. Copy that promised or refused
   * the wrong thing is how he finds out by being turned away.
   *
   * LIST_ACCEPT STILL HAS NO ".pdf" IN IT, and that is not an oversight: `isListFile` feeds `oneList`,
   * which calls `readListFile`, and that reader cannot read a PDF. The statement door has its own
   * constant (STATEMENT_ACCEPT) and its own route through the table reader.
   */
  /**
   * NO MERRY-GO-ROUND (Erik, 2026-10-02: "i dont want people to have to jump on a merry go round to
   * do shit"). This test used to REQUIRE the card to name CSV, Excel, OFX, QFX and QBO, on the
   * reasoning that what a door takes should be named rather than implied. That reasoning was wrong:
   * a person is emailed a statement and hands it over, and a list of file extensions is a lecture on
   * something they should never have to learn. So the law is inverted here, and the test with it —
   * the card may name NO format, because the reader works out what the file is.
   *
   * AND THE SCAN READS HERE NOW (2026-10-02), so the sentence that sent it to the + button is gone, as
   * it said it would be. What replaces it is not a format or a door: it is the PROMISE that makes a
   * model read safe to look at — the statement's own figures are held against what came off its pages,
   * and when the paper prints no figures the card says that out loud. This test pins the promise rather
   * than the wording, because copy that promises or refuses the wrong thing is how he finds out by
   * being turned away.
   *
   * The accept lists are still pinned, because they are what the browser filters on: .pdf must be in
   * STATEMENT_ACCEPT and must NOT be in LIST_ACCEPT, where isListFile would send every PDF to
   * readListFile, a reader that cannot open one.
   */
  /**
   * ── THE CARD KEEPS ONE LINE; THE REST IS BEHIND THE INFO ICON, AS BULLETS (Erik, 2026-10-03) ──
   *
   * "this huge box of text in front of me is hard for me to read and takes up a lot of space on the
   * screen, valuable space for reconciling, so my idea is in places like this we can have a little info
   * icon with a popup text box" — and: "inside the info box that wall of text will be a lot easier to
   * read if its broken into bullet points".
   *
   * This test used to read all eleven facts off the card itself. They are still every one of them here,
   * one bullet each (STATEMENT_FACTS), and each one still traced to the code that does it — which is
   * the half of this test that matters: an explanation must not be lost on its way into the box.
   */
  it("the card keeps one line, names no file formats, and the icon is a real target with a name", () => {
    const card = text(sectionOf(html, "bring-in-a-statement"));
    for (const lecture of ["CSV", "TSV", "Excel", "OFX", "QFX", "QBO", ".xlsx"]) expect(card, lecture).not.toContain(lecture);
    expect(card).toContain("whatever your bank or supplier gave you");
    // ONE LINE: the wall of prose is not on the card any more, in any of its clauses.
    for (const moved of ["PICTURES", "scanned, photographed", "running balance", "takes a minute"])
      expect(card, moved).not.toContain(moved);
    // AND NOT THE SECOND PARAGRAPH EITHER (review, 2026-10-03). It survived the move, under the drop
    // button, in both the waiting and the empty state — about four more lines of 14px prose at 375px, in
    // the space he asked for back, while the card's own comment claimed every crowding clause was already
    // in the box. It is a bullet in STATEMENT_FACTS now.
    for (const moved of ["either matches a paper you already have", "nothing is written until you press Apply"])
      expect(card, moved).not.toContain(moved);
    expect(STATEMENT_FACTS.join(" ")).toContain("Every line either matches a paper you already have or asks you what it was for, and nothing is written until you press Apply.");
    // THE ICON IS A 44px TARGET, KEYBOARD REACHABLE, AND HAS A NAME A SCREEN READER CAN SAY.
    const icon = /<button[^>]*aria-label="How A Statement Is Read"[^>]*>/.exec(sectionOf(html, "bring-in-a-statement"))?.[0];
    expect(icon, "the info icon").toBeTruthy();
    expect(icon).toMatch(/\bh-11\b/);
    expect(icon).toMatch(/\bw-11\b/);
    expect(icon).toContain('type="button"');
    expect(icon).toContain('aria-expanded="false"');
  });

  it("every fact that was on the card is in the box, one bullet each, and still traces to the code", () => {
    const box = textOf(renderToStaticMarkup(createElement(InfoBullets, { bullets: STATEMENT_FACTS })));
    expect((renderToStaticMarkup(createElement(InfoBullets, { bullets: STATEMENT_FACTS })).match(/<li/g) ?? []).length).toBe(STATEMENT_FACTS.length);
    // A SCAN IS READ HERE, and it is no longer sent anywhere else.
    expect(box).toContain("PICTURES");
    expect(box).not.toContain("+ button");
    /**
     * AND THE CLAIM TRACES TO THE CODE. "with no text on its pages at all" was narrower than the
     * routing: open-list-file.ts sends EVERY PDF the text lane cannot tabulate to the reader, and the
     * file this lane exists for — his September statement — has 125 text marks on it and a table that
     * is an image. A promise that doesn't trace to the code is how he finds out by being turned away.
     */
    expect(box).not.toContain("no text on its pages");
    expect(box).toContain("scanned, photographed");
    // A CARD'S BALANCE RUNS THE OTHER WAY, and the gate walks it that way, so the box may say so.
    expect(box).toContain("what you owe goes up with a purchase");
    // AND THE TIME IS THE READ'S REAL TIME. "A few seconds" is an Opus transcription's worst lie.
    expect(box).toContain("takes a minute");
    // AND THE PROMISE THAT MAKES IT SAFE: arithmetic first, and a word when there is none to do.
    expect(box).toContain("held against what came off them");
    expect(box).toContain("nothing is");
    expect(box).toContain("prints no totals");
    expect(box).toContain("running balance");
    expect(box).not.toContain("prints no totals at all");
    expect(box).toContain("no totals and no running balance");
    // AND WHAT A BREAK DOES AT EACH DOOR, because a scan is refused on one and a file only warned: a person
    // turned away for a reason the page never mentioned is how he finds out by being turned away.
    expect(box).toContain("refused");
    expect(box).toContain("names the line");
    // AND NO BULLET LECTURES HIM ON FILE TYPES EITHER (no merry-go-round): the app works it out.
    for (const lecture of ["CSV", "TSV", "Excel", "OFX", "QFX", "QBO", ".xlsx"]) expect(box, lecture).not.toContain(lecture);
    for (const ext of [".csv", ".tsv", ".txt", ".xlsx", ".xls", ".ofx", ".qfx", ".qbo"]) expect(LIST_ACCEPT, ext).toContain(ext);
    expect(LIST_ACCEPT).not.toContain(".pdf");
    for (const ext of [".pdf", ".csv", ".xlsx", ".ofx", ".qbo"]) expect(STATEMENT_ACCEPT, ext).toContain(ext);
  });
});

/**
 * A ONE-TAP WRITE WITH NO UNDO SAYS SO ON SCREEN, NOT ONLY IN A FOLD. This travelled here with its
 * buttons: it is a safety test, and dropping it in a move would have been the quiet kind of loss.
 */
describe("a one-tap write with no undo says so on screen", () => {
  it("Not The Same and Keep Them Separate each carry their warning outside the Why? fold", () => {
    const names = section("supplier-names");
    const maybe = section("same-supplier-or-two");
    expect(text(names)).toContain("Not The Same Can't Be Undone Here");
    expect(text(maybe)).toContain("Keeping Them Separate Can't Be Undone Here");
    for (const fold of html.match(/<div class="mb-2 space-y-1 leading-relaxed">[\s\S]*?<\/div>/g) ?? []) {
      expect(fold).not.toContain("Undone Here");
    }
    expect(text(html)).toContain("What Does Each Answer Do?");
  });
});

/**
 * TECHS NEVER SEE PRICES. The dock row is staffOnly, which hides the door; this redirect is the
 * boundary. Two renders: staff gets the page, a tech gets sent to the Timeclock, and not one dollar
 * figure is serialized on the way.
 */
describe("staff only, and proved", () => {
  it("a tech is redirected to the Timeclock and no figure is rendered for him", async () => {
    CURRENT = { ...TABLES, profiles: [{ id: "user-tech", org_id: ORG, role: "tech", full_name: "A Tech" }] };
    redirectedTo = null;
    try {
      let out = "";
      await expect(async () => {
        out = await render();
      }).rejects.toThrow();
      expect(redirectedTo).toBe("/timeclock");
      expect(out).toBe("");
    } finally {
      CURRENT = TABLES;
    }
  });

  it("an owner gets the page, with the figures on it", () => {
    expect(redirectedTo === "/timeclock" || redirectedTo === null).toBe(true);
    expect(text(html)).toContain("Reconcile");
    expect(text(html)).toContain("$1,087.00");
  });
});

/**
 * THE DROP DOOR IS THE OWNER'S MONEY, GATED BY THE OWNER'S ONE SWITCH (0286). A bank download is the
 * draw and the personal spending, line by line. /analytics gated this door on that switch; Reconcile
 * asks the SAME function (lib/bank-viewer.ts viewerSeesOwnerMoney) rather than deciding again, and
 * these two renders are the proof — a second copy of the condition would pass a source scan and fail
 * right here.
 */
describe("who may bring a bank download in", () => {
  const asOffice = (officeSees: boolean) => ({
    ...TABLES,
    profiles: [{ id: "user-owner", org_id: ORG, role: "office", full_name: "An Office Hand" }],
    organizations: [{ settings: { timezone: "America/Los_Angeles", office_sees_owner_money: officeSees }, name: "Synthetic Electric" }],
  });

  it("an office hand the owner has switched off gets no door, and is told which door is theirs", async () => {
    CURRENT = asOffice(false);
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Statement")).toBe(0);
      expect(out).not.toContain('type="file"');
      // NOT A DEAD END: no control that could only refuse, and the door that IS theirs is named.
      expect(text(out)).toContain("The owner brings in bank downloads");
      expect(text(out)).toContain("Snap Or Note on Bills");
      // And no link off this page: a supplier's open list is answered right here now, whoever brings it in.
      expect(count(doors(out), "Open Bills")).toBe(0);
    } finally {
      CURRENT = TABLES;
    }
  });

  it("an office hand the owner has shared with gets the same door the owner has", async () => {
    CURRENT = asOffice(true);
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Statement")).toBe(1);
      expect(text(out)).not.toContain("The owner brings in bank downloads");
    } finally {
      CURRENT = TABLES;
    }
  });

  it("a company whose settings could not be read gets no door: the switch's default is never taken as a yes", async () => {
    CURRENT = { ...TABLES, profiles: [{ id: "user-owner", org_id: ORG, role: "office", full_name: "An Office Hand" }], organizations: [] };
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Statement")).toBe(0);
    } finally {
      CURRENT = TABLES;
    }
  });

  /**
   * AND FAIL-CLOSED IS FOR THE VIEWER THE SWITCH IS ABOUT, NEVER FOR THE OWNER. The page read the
   * settings first and required the row, so a lost read — or an org_id that is still null, which
   * profiles allows — took the OWNER'S own door away and printed "The owner brings in bank downloads"
   * at the owner. The same owner stayed a yes through viewerSortsBank in every server action, which is
   * two answers to one question. The rule is asked in bank-viewer's own order now: the owner first,
   * and the read only where the switch can change the answer.
   */
  it("an owner whose settings could not be read keeps his own door: the switch was never his gate", async () => {
    CURRENT = { ...TABLES, profiles: [{ id: "user-owner", org_id: ORG, role: "owner", full_name: "A N Owner" }], organizations: [] };
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Statement")).toBe(1);
      expect(text(out)).not.toContain("The owner brings in bank downloads");
    } finally {
      CURRENT = TABLES;
    }
  });
});

/**
 * A KIND WITH NOTHING OPEN DRAWS NOTHING, and a page with nothing open says so in plain words and is
 * NOT an error (badges show open; no dead ends).
 */
describe("a new company sees words, not an error", () => {
  it("nothing disagrees yet, said plainly, with no empty headings and no sections", async () => {
    CURRENT = { profiles: TABLES.profiles, organizations: TABLES.organizations };
    try {
      const fresh = await render();
      expect(text(fresh)).toContain("Reconcile");
      expect(text(fresh)).toContain("Nothing Disagrees Right Now");
      expect(text(fresh)).not.toContain("Couldn't");
      // No section of any kind, and no decision to press: nothing disagrees, so nothing is asked.
      for (const k of Object.values(RECONCILE_KINDS)) expect(fresh, k.anchor).not.toContain(`id="${k.anchor}"`);
      // THE ONLY DOOR ON A QUIET PAGE IS THE STATEMENT INTAKE, and it is drawn PRECISELY here: the book
      // is quiet and the next download is in his hand. The card used to be hidden on this page, which
      // left an all-clear with no way to put anything on it — a dead end. So the lead may not then
      // print a flat "Nothing for you to do here" above a door, and it does not: it names the door.
      // (The link to Bills that used to sit beside it is gone: the statement is answered here, so there
      // is nothing on Bills to send him to.)
      // The info icon is a door with no words on it, so it reads as "" here; it is asserted by the name a
      // screen reader says, above. Everything else on a quiet page is the one intake.
      expect(doors(fresh).filter(Boolean)).toEqual(["Drop A Bank Or Supplier Statement"]);
      expect(fresh).toContain('aria-label="How A Statement Is Read"');
      expect(text(fresh)).toContain("drop it in below");
      expect(text(fresh)).not.toContain("Nothing for you to do here");
    } finally {
      CURRENT = TABLES;
    }
  });

  it("a book with names to sort but no money gap leads with what is waiting, not with $0.00", async () => {
    // The account's own papers agree with our tickets to the cent, so there is no gap to lead with.
    CURRENT = {
      ...TABLES,
      bills: BILLS.filter((b) => !String(b.id).startsWith("b-north")),
      supplier_invoices: [doc("d-open", { invoice_number: "9900-1", total: 87, open_balance: 87 })],
    };
    try {
      const fresh = await render();
      expect(text(fresh)).not.toContain("$0.00");
      expect(text(fresh)).toMatch(/\d+ Things To Sort Out/);
      expect(fresh).not.toContain(`id="${RECONCILE_KINDS["supplier-gap"].anchor}"`);
      // The decisions are still all there.
      expect(countDoors(doors(fresh), "Give It Its Own Account")).toBeGreaterThanOrEqual(1);
    } finally {
      CURRENT = TABLES;
    }
  });
});

/**
 * THE TYPED RECORD IS LOAD-BEARING, not documentation: the words it declares are the words on the
 * page, so a kind added to the union cannot ship with a heading nobody wrote.
 */
describe("the kinds Record is what the page is made of", () => {
  it("every kind answered here is drawn under the heading the Record gives it, with its own count", () => {
    for (const k of RECONCILE_ANSWERED_HERE) {
      const def = RECONCILE_KINDS[k];
      expect(html, k).toContain(`id="${def.anchor}"`);
      expect(text(section(def.anchor)), k).toContain(def.heading);
      // Its count is plain text in its own heading — never a dock number. ("(1)" on three of them,
      // "(1 Waiting)" on the duplicate picker, which keeps the picks he already made on the page.)
      const esc = def.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(text(section(def.anchor)), k).toMatch(new RegExp(`${esc}[^(]*\\(\\d+( Waiting)?\\)`));
    }
  });

  it("the sections run in the Record's order, the money reading first", () => {
    const order = Object.values(RECONCILE_KINDS)
      .sort((a, b) => a.order - b.order)
      // "They Call It Paid" is drawn only with a row in it (a link kind, answered on the bill), and
      // this book has none: a closed supplier paper over an open bill is a fixture of its own.
      .filter((d) => d.anchor !== RECONCILE_KINDS["they-call-it-paid"].anchor)
      .map((d) => html.indexOf(`id="${d.anchor}"`));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
