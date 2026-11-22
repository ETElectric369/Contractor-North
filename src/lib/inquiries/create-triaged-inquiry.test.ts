import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyLead, type LeadIntake } from "@/lib/lead-triage";
import { standIn, type Row } from "./public-stand-in.test-support";

/**
 * THE ONE WRITER OF A TRIAGED LEAD, ON A STAND-IN THAT HONOURS FILTERS AND COLUMN LISTS (cn-v1180).
 *
 * A2: the alert opens the lead's own file. A web lead over the inspection threshold used to get a
 *     visit booked for it (9 AM two days out, nobody told); a standing visit takes a lead off the
 *     Leads list, and the alert opened that list. The hold is OFF for every company since this
 *     release, on the owner's word, and the alert opens the lead itself.
 * A4: a repeat through a public form is never silent. "The newest submission is the truth" (audit
 *     v921) is KEPT; quiet is only a true double-submit, and when the answer the office reads moved,
 *     the lead's message carries both halves even when the visitor typed nothing.
 */
const sent = vi.hoisted(() => ({ bell: [] as any[], push: [] as any[], mail: [] as any[] }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async (...a: any[]) => void sent.bell.push(a)) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async (...a: any[]) => void sent.push.push(a)), orgStaffIds: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async (m: any) => void sent.mail.push(m)) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: vi.fn() }));

const { createTriagedInquiry, answerChanged, repeatIsQuiet, answerLine, boundedMessage, CAME_BACK_KEEP, MESSAGE_MAX } = await import("./create-triaged-inquiry");

const ORG = "org-a";
const OTHER = "org-b";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const intake = (total: number, projectType: LeadIntake["projectType"] = "new_deck"): LeadIntake => ({
  projectType,
  hasPlans: false,
  hasDimensions: true,
  estimateTotal: total,
  contact: { name: "Sam Tillery", phone: "555-0101" },
});

/** A lead as the first submission wrote it: the triage columns are what classifyLead gave. */
const firstLead = (over: Row = {}, total = 12000): Row => {
  const t = classifyLead(intake(total));
  return {
    id: "lead-larkspur",
    org_id: ORG,
    name: "Sam Tillery",
    email: null,
    phone: "555-0101",
    message: null,
    status: "new",
    converted_at: null,
    created_at: ago(20),
    updated_at: ago(10),
    address: "1 Larkspur Way",
    city: null,
    state: null,
    zip: null,
    project_type: "new_deck",
    lead_bucket: t.bucket,
    estimate_total: total,
    site_inspection_required: t.siteInspectionRequired,
    priority: t.priority,
    intake: { project_type: "new_deck", intake_answers: { plans: ["org-a/plans/larkspur.pdf"] }, estimate: { total } },
    ...over,
  };
};

function world(leads: Row[] = [], features: Record<string, boolean> = {}) {
  return standIn({
    organizations: [
      { id: ORG, name: "Larkspur Decks", email: "office@example.test", settings: { timezone: "America/Los_Angeles", features } },
      { id: OTHER, name: "Snowbell Decks", email: "office-b@example.test", settings: {} },
    ],
    profiles: [
      { id: "p-owner", org_id: ORG, active: true, role: "owner", email: "owner@example.test" },
      { id: "p-other", org_id: OTHER, active: true, role: "owner", email: "other@example.test" },
    ],
    inquiries: leads,
    appointments: [],
  });
}

const submit = (db: ReturnType<typeof world>, total: number, over: Record<string, unknown> = {}) =>
  createTriagedInquiry(db.client, ORG, {
    name: "Sam Tillery",
    phone: "555-0101",
    source: "deck_configurator",
    intake: intake(total),
    intakeJson: { project_type: "new_deck", estimate: { total } },
    inspectionThreshold: 20000,
    ...over,
  });

beforeEach(() => {
  sent.bell = [];
  sent.push = [];
  sent.mail = [];
});

describe("A2 · the alert opens the lead's own file", () => {
  it("a new lead, Leads on: the bell, the push and the e-mail's button open /leads/<its id>", async () => {
    const db = world();
    const { id } = await submit(db, 12000);
    expect(sent.bell[0][2].url).toBe(`/leads/${id}`);
    expect(sent.push[0][2].url).toBe(`/leads/${id}`);
    expect(sent.mail[0].html).toContain(`/leads/${id}"`);
    expect(sent.mail[0].html).toContain("Open the lead →");
  });

  // The owner, 2026-11-22: "stop the auto booking until that feature is turned on in each account
  // when there are inspection days set and calendar can corroborate open times and specified days".
  it("a big lead books NOTHING by itself: it lands asking for a site inspection, and the alert opens its own file", async () => {
    const db = world();
    const { id, triage } = await submit(db, 45000);
    expect(triage.siteInspectionRequired).toBe(true);
    expect(db.tables.appointments).toEqual([]);
    expect(db.tables.inquiries.find((l) => l.id === id)?.site_inspection_required).toBe(true);
    expect(sent.bell[0][2].url).toBe(`/leads/${id}`);
  });

  it("no caller's flag turns the hold back on, and a repeat that grew past the threshold books nothing either", async () => {
    const db = world([firstLead()]);
    await submit(db, 45000, { autoBookInspection: true });
    expect(db.tables.appointments).toEqual([]);
  });

  it("Leads off: My Day, as before", async () => {
    const db = world([], { leads: false });
    await submit(db, 12000);
    expect(sent.bell[0][2].url).toBe("/planner");
  });
});

describe("A4 · a repeat is never silent, and both halves can be read", () => {
  it("an unchanged repeat inside the hour, nothing typed: quiet (a true double-submit)", async () => {
    const db = world([firstLead()]);
    const { id } = await submit(db, 12000);
    expect(id).toBe("lead-larkspur");
    expect(sent.bell).toEqual([]);
    expect(db.tables.inquiries[0].message).toBeNull();
  });

  it("a CHANGED repeat inside the hour alerts as a lead that came back, opening its own file", async () => {
    const db = world([firstLead()]);
    await submit(db, 15000);
    expect(sent.bell).toHaveLength(1);
    expect(sent.bell[0][2].title).toContain("Lead came back");
    expect(sent.bell[0][2].url).toBe("/leads/lead-larkspur");
  });

  it("the message carries the divider and both figures though the visitor typed nothing", async () => {
    const db = world([firstLead()]);
    await submit(db, 15000);
    const msg = String(db.tables.inquiries[0].message);
    expect(msg).toMatch(/^— Came back \d{4}-\d{2}-\d{2} —\n/);
    expect(msg).toContain("Earlier answer: New deck, $12,000.00. New answer: New deck, $15,000.00.");
    // The newest submission is still the truth (audit v921, kept).
    expect(db.tables.inquiries[0].estimate_total).toBe(15000);
  });

  it("a repeat from a door with no estimate says 'no estimate' and names no type", async () => {
    const db = world([firstLead()]);
    await createTriagedInquiry(db.client, ORG, {
      name: "Sam Tillery",
      phone: "555-0101",
      source: "site_contact",
      intake: { contact: { phone: "555-0101" } },
      intakeJson: {},
    });
    expect(String(db.tables.inquiries[0].message)).toContain("Earlier answer: New deck, $12,000.00. New answer: no project type, no estimate.");
    expect(sent.bell).toHaveLength(1);
  });

  it("new words alert; the same words pressed again stay quiet", async () => {
    const db = world([firstLead()]);
    await submit(db, 12000, { message: "Can you also look at the stairs?" });
    expect(sent.bell).toHaveLength(1);
    expect(String(db.tables.inquiries[0].message)).toContain("— Came back");
    expect(String(db.tables.inquiries[0].message)).not.toContain("Earlier answer");
    sent.bell = [];
    db.tables.inquiries[0].updated_at = ago(2);
    await submit(db, 12000, { message: "Can you also look at the stairs?" });
    expect(sent.bell).toEqual([]);
  });

  it("past the hour a repeat alerts even unchanged, as it always did", async () => {
    const db = world([firstLead({ updated_at: ago(90) })]);
    await submit(db, 12000);
    expect(sent.bell).toHaveLength(1);
  });

  it("the first submission's uploaded paths still sit at the top level afterwards", async () => {
    const db = world([firstLead()]);
    await submit(db, 15000);
    const after = db.tables.inquiries[0].intake as any;
    expect(after.intake_answers.plans).toEqual(["org-a/plans/larkspur.pdf"]);
    expect(after.previous).toHaveLength(1);
  });

  it("another company's lead with the same phone is neither read as the repeat nor written", async () => {
    const theirs = firstLead({ id: "lead-snowbell", org_id: OTHER });
    const db = world([theirs]);
    const { id } = await submit(db, 15000);
    expect(id).not.toBe("lead-snowbell");
    expect(theirs.estimate_total).toBe(12000);
    expect(theirs.message).toBeNull();
    for (const w of db.log.filter((l) => l.table === "inquiries")) {
      if (w.op === "select" || w.op === "update") expect(w.filters).toContain(`org_id=${ORG}`);
    }
  });
});

describe("the three rules, as a table", () => {
  const a = { project_type: "new_deck", lead_bucket: "B", estimate_total: 12000, site_inspection_required: false, priority: 40 };
  it("answerChanged: each of the five, to the cent; no figure and zero are the same", () => {
    expect(answerChanged(a, { ...a })).toBe(false);
    expect(answerChanged(a, { ...a, estimate_total: "12000.00" })).toBe(false);
    expect(answerChanged(a, { ...a, estimate_total: 12000.01 })).toBe(true);
    expect(answerChanged(a, { ...a, project_type: "railing" })).toBe(true);
    expect(answerChanged(a, { ...a, lead_bucket: "A" })).toBe(true);
    expect(answerChanged(a, { ...a, site_inspection_required: true })).toBe(true);
    expect(answerChanged(a, { ...a, priority: 41 })).toBe(true);
    expect(answerChanged({ ...a, estimate_total: null }, { ...a, estimate_total: 0 })).toBe(false);
  });
  it("repeatIsQuiet: only inside the hour, unchanged, with nothing new typed", () => {
    expect(repeatIsQuiet({ sinceLastTouchMs: 60_000, changed: false, said: "", priorMessage: null })).toBe(true);
    expect(repeatIsQuiet({ sinceLastTouchMs: 60_000, changed: true, said: "", priorMessage: null })).toBe(false);
    expect(repeatIsQuiet({ sinceLastTouchMs: 60_000, changed: false, said: "hi", priorMessage: null })).toBe(false);
    expect(repeatIsQuiet({ sinceLastTouchMs: 60_000, changed: false, said: "hi", priorMessage: "x\n\nhi" })).toBe(true);
    expect(repeatIsQuiet({ sinceLastTouchMs: 3_600_001, changed: false, said: "", priorMessage: null })).toBe(false);
  });
  it("answerLine: the app's money formatter, the office's English type words", () => {
    expect(answerLine(a, { ...a, project_type: "railing", estimate_total: null })).toBe(
      "Earlier answer: New deck, $12,000.00. New answer: Railing only, no estimate.",
    );
  });
});

describe("skeptic #83 (S3) · the line says what moved, and a stamp is not an answer", () => {
  const a = { project_type: "new_deck", lead_bucket: "B", estimate_total: 12000, site_inspection_required: false, priority: 40 };
  it("a repeat that moved only the bucket, or only the priority, names it in both halves", () => {
    expect(answerLine(a, { ...a, lead_bucket: "A" })).toBe(
      "Earlier answer: New deck, $12,000.00, Measure & quote. New answer: New deck, $12,000.00, Ready to quote.",
    );
    expect(answerLine(a, { ...a, priority: 55 })).toBe("Earlier answer: New deck, $12,000.00, priority 40. New answer: New deck, $12,000.00, priority 55.");
    expect(answerLine(a, { ...a, site_inspection_required: true })).toBe(
      "Earlier answer: New deck, $12,000.00, no site visit. New answer: New deck, $12,000.00, site visit needed.",
    );
  });

  it("the site-visit flag is a change only when this submission turns it on", () => {
    expect(answerChanged(a, { ...a, site_inspection_required: true })).toBe(true);
    expect(answerChanged({ ...a, site_inspection_required: null }, { ...a, site_inspection_required: true })).toBe(true);
    expect(answerChanged({ ...a, site_inspection_required: true }, { ...a, site_inspection_required: false })).toBe(false);
  });

  it("a lead the site-visit tap stamped: an unchanged repeat stays quiet, and the stamp stays on", async () => {
    const db = world([firstLead({ site_inspection_required: true })]);
    await submit(db, 12000);
    expect(sent.bell).toEqual([]);
    expect(db.tables.inquiries[0].message).toBeNull();
    expect(db.tables.inquiries[0].site_inspection_required).toBe(true);
  });
});

describe("skeptic #83 (S4) · a lead's message cannot be grown without limit", () => {
  it("twelve changed repeats leave the first text, at most five blocks, the newest last", async () => {
    const db = world([firstLead({ message: "Sam's first words about the Larkspur deck." })]);
    for (let i = 1; i <= 12; i++) {
      db.tables.inquiries[0].updated_at = ago(90);
      await submit(db, 12000 + i);
    }
    const msg = String(db.tables.inquiries[0].message);
    expect(msg.startsWith("Sam's first words about the Larkspur deck.\n\n— Came back ")).toBe(true);
    expect(msg.match(/— Came back /g)).toHaveLength(CAME_BACK_KEEP);
    expect(msg).toContain("New answer: New deck, $12,012.00.");
    expect(msg.trimEnd().endsWith("New answer: New deck, $12,012.00.")).toBe(true);
    expect(msg).not.toContain("New answer: New deck, $12,007.00.");
    expect(msg).toContain("New answer: New deck, $12,008.00.");
  });

  it("the whole stays under the ceiling by dropping the oldest blocks first; the first text never goes", () => {
    const first = "First words.";
    const block = (n: number) => `— Came back 2026-11-0${n} —\n${String(n).repeat(2500)}`;
    let msg: string | null = first;
    for (let n = 1; n <= 4; n++) msg = boundedMessage(msg, block(n));
    expect(Array.from(msg!).length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(msg!.startsWith(first)).toBe(true);
    expect(msg).toContain(block(4));
    expect(msg).toContain(block(3));
    expect(msg).not.toContain(block(2));
    // A lead whose first submission said nothing: its blocks alone, bounded the same way.
    expect(boundedMessage(null, block(1))).toBe(block(1));
    expect(boundedMessage(null, null)).toBeNull();
  });
});
