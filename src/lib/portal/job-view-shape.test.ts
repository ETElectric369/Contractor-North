import { describe, it, expect } from "vitest";
import { isJobPhotoPath, pickHasContent, portalPathsToSign, shapePortalJob, type PortalJobRaw } from "./job-view-shape";
import { INV_078, LINES, PAYMENTS, STRETCHES } from "./j011-fixture";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const CUST = "33333333-3333-4333-8333-333333333333";
const OTHER_JOB = "44444444-4444-4444-8444-444444444444";

/** What portal_job_view hands the server, plus a few things it must never let through. */
function raw(over: Partial<PortalJobRaw> = {}): PortalJobRaw {
  return {
    scope: { org_id: ORG, job_id: JOB, customer_id: CUST },
    org: { name: "ET Electric", logo_url: null, phone: "(530) 555-0100", email: "office@example.com", license: "C-10", brand_color: "#599ce2", glass_tint: "#006d8f", timezone: "America/Los_Angeles" },
    customer: { name: "A Customer", company_name: null },
    job: { id: JOB, name: "Remodel", job_number: "J-011", status: "in_progress", address: "1 Main St", unit: null, city: "Truckee", state: "CA", zip: "96161" },
    billing: { billing_type: "tm", quote_statuses: [], milestones: 0 },
    stretches: STRETCHES,
    invoices: [{ ...INV_078, invoice_kind: "progress", public_token: "a".repeat(32), doc: { invoice: {}, items: [], payments: [], customer: null, site_candidates: [], org: null } }],
    lines: LINES,
    payments: PAYMENTS,
    picks: [
      {
        id: "p1",
        category: "Paint Color",
        brand: "Benjamin Moore",
        name: "Swiss Coffee",
        code: "OC-45",
        location: "Kitchen",
        note: "Eggshell on the walls",
        color_hex: "#F2EFE6",
        link_url: "https://example.com/oc-45",
        file_path: `${ORG}/picks/${JOB}/1-swatch.jpg`,
        file_kind: "image",
        updated_at: "2026-09-24T18:00:00Z",
        // A column the function might one day return by mistake: it must not reach the page.
        ...({ buy_price: 41.5, markup_pct: 25 } as object),
      },
      {
        id: "p2",
        category: "Fixture",
        brand: null,
        name: "Halo RL4",
        code: null,
        location: null,
        note: null,
        color_hex: "not-a-color",
        link_url: "http://insecure.example.com",
        // Another job's paper: never signed, never shown.
        file_path: `${ORG}/picks/${OTHER_JOB}/2-spec.pdf`,
        file_kind: "pdf",
        updated_at: "2026-09-24T18:00:00Z",
      },
    ],
    photos: [
      { id: "ph1", file_path: `${ORG}/${JOB}/100-panel.jpg`, added_at: "2026-09-19T00:30:00Z" },
      // A receipt path from another job must never be signed, even if a row named it.
      { id: "ph2", file_path: `${ORG}/${OTHER_JOB}/200-receipt.jpg`, added_at: "2026-09-20T00:30:00Z" },
    ],
    ...over,
  };
}
const signedFor = (r: PortalJobRaw) => new Map(portalPathsToSign(r).map((p) => [p, `https://signed.example/${encodeURIComponent(p)}?t=1`]));
const NOW = new Date("2026-09-24T23:00:00Z");

describe("the customer's job page carries an allowlist, nothing else", () => {
  const r = raw();
  const v = shapePortalJob(r, { signed: signedFor(r), unbilled: null, now: NOW });

  it("top-level and nested keys are exactly the allowlist", () => {
    expect(Object.keys(v).sort()).toEqual(
      ["asOf", "asOfDay", "customer", "documents", "invoices", "job", "ledger", "org", "photos", "picks", "running", "timezone", "unbilled"].sort(),
    );
    expect(Object.keys(v.org).sort()).toEqual(["accent", "email", "license", "logoUrl", "name", "phone", "tint"]);
    expect(Object.keys(v.customer).sort()).toEqual(["companyName", "name"]);
    expect(Object.keys(v.job).sort()).toEqual(["id", "name", "number", "site", "status"]);
    expect(Object.keys(v.invoices[0]).sort()).toEqual(["amountPaid", "balance", "doc", "isDraft", "number", "payToken", "status", "total"]);
    expect(Object.keys(v.picks[0]).sort()).toEqual(["brand", "category", "code", "colorHex", "file", "id", "linkUrl", "location", "name", "note"]);
    expect(Object.keys(v.photos[0]).sort()).toEqual(["addedOn", "id", "url"]);
    expect(Object.keys(v.ledger).sort()).toEqual(["balance", "billedBalance", "billedTotal", "paidTotal", "reconciles", "stretches", "workTotal"]);
    const day = v.ledger.stretches[0].days[0];
    expect(Object.keys(day).sort()).toEqual(["date", "hours", "inRange", "items", "labor", "outside", "total"]);
    expect(Object.keys(day.labor[0]).sort()).toEqual(["amount", "hours", "invoiceNumber", "lump", "person", "rate"]);
  });

  it("never carries the scope ids, a storage path, a clock time or a cost field", () => {
    // The signed URLs themselves name their object (that is how storage signs), so they are
    // checked above by shape; everything else is read as text here.
    const text = JSON.stringify({
      ...v,
      invoices: v.invoices.map((i) => ({ ...i, doc: null })),
      picks: v.picks.map((p) => ({ ...p, file: p.file ? { kind: p.file.kind } : null })),
      photos: v.photos.map((p) => ({ ...p, url: null })),
    });
    for (const banned of [ORG, CUST, "/picks/", `${JOB}/`, "clock_in", "clock_out", "lunch", "buy_price", "markup", "hourly", "source", "file_path", "gps"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("the skin takes the org's own glass color, and a bad one falls back to the default teal", () => {
    expect(v.org.tint).toBe("#006d8f");
    const bad = shapePortalJob(raw({ org: { ...r.org!, glass_tint: "red; background:url(x)" } }), { signed: new Map(), unbilled: null, now: NOW });
    expect(bad.org.tint).toBe("#1b9488");
  });

  it("a draft bill is a running total with no pay door", () => {
    expect(v.running).toBe(true);
    expect(v.invoices[0]).toMatchObject({ number: "INV-078", isDraft: true, payToken: null, balance: 1558.62 });
    expect(v.ledger.balance).toBe(1558.62);
    expect(v.ledger.reconciles).toBe(true);
  });

  it("a sent bill keeps its pay door, exactly the /i token", () => {
    const sent = raw({ invoices: [{ ...r.invoices![0], status: "sent", sent_at: "2026-09-24T20:00:00Z" }] });
    const s = shapePortalJob(sent, { signed: signedFor(sent), unbilled: null, now: NOW });
    expect(s.running).toBe(false);
    expect(s.invoices[0].payToken).toBe("a".repeat(32));
  });

  it("files leave only as signed URLs, and only from where that kind of file lives", () => {
    expect(portalPathsToSign(r)).toEqual([`${ORG}/picks/${JOB}/1-swatch.jpg`, `${ORG}/${JOB}/100-panel.jpg`]);
    expect(v.picks[0].file).toEqual({ url: expect.stringMatching(/^https:\/\/signed\.example\//), kind: "image" });
    expect(v.picks[1].file).toBeNull();
    expect(v.photos.map((p) => p.id)).toEqual(["ph1"]);
    // Added 5:30 PM Pacific on the 18th: the org's day, not UTC's.
    expect(v.photos[0].addedOn).toBe("2026-09-18");
  });

  it("the J-011 page names no supplier anywhere in the stretches", () => {
    const text = JSON.stringify(v.ledger);
    for (const supplier of ["Consolidated", "Home Depot", "Supplies & tax —"]) expect(text).not.toContain(supplier);
  });

  it("a pick with nothing to show yet stays off the page (no publish step: Add Pick is live)", () => {
    const blank = { id: "p3", category: "Paint Color", brand: null, name: null, code: null, location: "Kitchen", note: "Deciding Friday", color_hex: null, link_url: null, file_path: null, file_kind: null, updated_at: null };
    const withBlank = raw({ picks: [...r.picks!, blank] });
    const s = shapePortalJob(withBlank, { signed: signedFor(withBlank), unbilled: null, now: NOW });
    expect(s.picks.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(pickHasContent(blank)).toBe(false);
    for (const has of [{ name: "Swiss Coffee" }, { code: "OC-45" }, { brand: "Leviton" }, { color_hex: "#FFFFFF" }, { link_url: "https://example.com" }, { file_path: "x", file_kind: "pdf" as const }]) {
      expect(pickHasContent({ ...blank, ...has })).toBe(true);
    }
    // An unsafe link or a bad swatch does not count as something to show.
    expect(pickHasContent({ ...blank, link_url: "http://x.example", color_hex: "nope" })).toBe(false);
  });

  it("a photo filed outside its job's folder (Organize's <org>/organize/) is not a job photo", () => {
    expect(isJobPhotoPath(`${ORG}/organize/1-photo.jpg`, ORG, JOB)).toBe(false);
    expect(isJobPhotoPath(`${ORG}/${JOB}/1-photo.jpg`, ORG, JOB)).toBe(true);
  });

  it("an unsafe link and a bad swatch are dropped, not passed along", () => {
    expect(v.picks[0]).toMatchObject({ colorHex: "#F2EFE6", linkUrl: "https://example.com/oc-45" });
    expect(v.picks[1]).toMatchObject({ colorHex: null, linkUrl: null });
  });

  it("a photo the server could not sign is left out rather than shown broken", () => {
    const s = shapePortalJob(r, { signed: new Map(), unbilled: null, now: NOW });
    expect(s.photos).toEqual([]);
    expect(s.picks[0].file).toBeNull();
  });

  it("an org with no timezone set reads in the default one, and says so", () => {
    const s = shapePortalJob(raw({ org: { ...r.org!, timezone: null } }), { signed: new Map(), unbilled: null, now: NOW });
    expect(s.timezone).toBe("America/Los_Angeles");
    expect(s.asOfDay).toBe("2026-09-24");
  });
});

describe("the plans and drawings (0326)", () => {
  const doc = (id: string, kind: string | null, file: string, over: Record<string, unknown> = {}) => ({
    id,
    kind,
    title: `Title ${id}`,
    file_path: file,
    added_at: "2026-09-24T01:00:00Z",
    shown_at: "2026-09-24T02:00:00Z",
    is_update: false,
    ...over,
  });
  const r = raw({
    documents: [
      doc("d1", "circuit_map", `${ORG}/${JOB}/300-circuit-map-rev2.pdf`, { is_update: true }),
      doc("d2", "plan", `${ORG}/${JOB}/301-floor.jpg`),
      doc("d3", "scan_3d", `${ORG}/${JOB}/302-house.e57`),
      doc("d4", "rendering", `${ORG}/${JOB}/303-kitchen.glb`),
      // A kind a later build adds: shown as a Document, never dropped.
      doc("d5", "hologram", `${ORG}/${JOB}/304-notes.docx`),
      // Another job's paper and a folder listing's receipt: never signed, never shown.
      doc("d6", "plan", `${ORG}/${OTHER_JOB}/305-plan.pdf`),
      doc("d7", "document", `${ORG}/organize/306-receipt.jpg`),
      // A title a database never sent falls back to the kind's name.
      doc("d8", "permit", `${ORG}/${JOB}/307-permit.pdf`, { title: "  " }),
      // A row carrying a column the function might one day return by mistake.
      doc("d9", "drawing", `${ORG}/${JOB}/308-panel.png`, { shared_by: "SECRET-PERSON", category: "Receipt" }),
    ],
  });
  const v = shapePortalJob(r, { signed: signedFor(r), unbilled: null, now: NOW });

  it("each carries exactly its allowlist of fields, and only a signed URL for its file", () => {
    for (const d of v.documents) {
      expect(Object.keys(d).sort()).toEqual(["addedOn", "format", "id", "isUpdate", "kind", "kindLabel", "title", "url"]);
      expect(d.url).toMatch(/^https:\/\/signed\.example\//);
    }
    expect(JSON.stringify(v.documents)).not.toMatch(/SECRET-PERSON|Receipt|shown_at|file_path/);
  });

  it("only the job's own folder is signed: another job's paper and an Organize file are left out", () => {
    const paths = portalPathsToSign(r);
    expect(paths).not.toContain(`${ORG}/${OTHER_JOB}/305-plan.pdf`);
    expect(paths).not.toContain(`${ORG}/organize/306-receipt.jpg`);
    expect(v.documents.map((d) => d.id)).not.toContain("d6");
    expect(v.documents.map((d) => d.id)).not.toContain("d7");
  });

  it("grouped by kind in the page's order, and the file says how it is shown", () => {
    expect(v.documents.map((d) => [d.id, d.kindLabel, d.format])).toEqual([
      ["d2", "Plan", "image"],
      ["d1", "Circuit Map", "pdf"],
      ["d9", "Drawing", "image"],
      ["d8", "Permit", "pdf"],
      ["d4", "Rendering", "model"],
      ["d3", "3D Scan", "model"],
      ["d5", "Document", "file"],
    ]);
    expect(v.documents.find((d) => d.id === "d8")!.title).toBe("Permit");
    expect(v.documents.find((d) => d.id === "d1")!.isUpdate).toBe(true);
    // Added 6 PM Pacific on the 23rd: the org's day.
    expect(v.documents[0].addedOn).toBe("2026-09-23");
  });

  it("before 0326 the read has no documents at all, and the page has none", () => {
    const old = raw();
    delete (old as { documents?: unknown }).documents;
    expect(shapePortalJob(old, { signed: signedFor(old), unbilled: null, now: NOW }).documents).toEqual([]);
  });

  it("a file the server could not sign is left out rather than shown broken", () => {
    expect(shapePortalJob(r, { signed: new Map(), unbilled: null, now: NOW }).documents).toEqual([]);
  });
});
