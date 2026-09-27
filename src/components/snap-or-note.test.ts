import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SNAP OR NOTE: ONE PAPER DOOR (W1-30). One queue for the app and one set of rules for every way in.
 * What these pin: the same file twice adds nothing; a mixed drop names what it skipped; a note is
 * saved even when its read fails; pasted supplier text is imported instead of kept as a note; a
 * tech's photo needs a job, runs no read and says no amount; a tech's sheet has no Choose Files; and
 * closing the sheet mid-queue keeps the queue running.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
const m = vi.hoisted(() => ({
  saveVoiceNote: vi.fn(),
  addPaperwork: vi.fn(),
  fingerprintSeen: vi.fn(),
  addOpenList: vi.fn(),
  routePastedText: vi.fn(),
  snapContext: vi.fn(),
  snapPaperRows: vi.fn(),
  captureReceipt: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  prep: vi.fn(async (f: File) => f),
  readListFile: vi.fn(),
}));
vi.mock("@/app/(app)/organize/actions", () => ({
  saveVoiceNote: m.saveVoiceNote,
  archiveItem: vi.fn(),
  deleteOrganizedItem: vi.fn(),
  fileItem: vi.fn(),
  keepAsNote: vi.fn(),
  makeTaskFromPaper: vi.fn(),
  readAsCost: vi.fn(),
  readPaperworkItem: vi.fn(),
  tiePaperwork: vi.fn(),
  undoPaperwork: vi.fn(),
}));
vi.mock("@/app/(app)/organize/paperwork-actions", () => ({
  addPaperwork: m.addPaperwork,
  fingerprintSeen: m.fingerprintSeen,
  addSupplierDocuments: vi.fn(),
  keepPaperwork: vi.fn(),
  updatePaperwork: vi.fn(),
}));
vi.mock("@/app/(app)/bills/open-list-actions", () => ({ addOpenList: m.addOpenList }));
vi.mock("@/app/(app)/snap-or-note-actions", () => ({ routePastedText: m.routePastedText, snapContext: m.snapContext, snapPaperRows: m.snapPaperRows }));
vi.mock("@/lib/receipt-capture", () => ({ captureReceipt: m.captureReceipt }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ storage: { from: () => ({ upload: m.upload, remove: m.remove }) } }) }));
vi.mock("@/lib/image-prep", () => ({ prepareImageForUpload: m.prep }));
vi.mock("@/lib/pdf-text", () => ({
  isPdfBytes: (b: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(b).slice(0, 8)).startsWith("%PDF-"),
  readPdfText: async () => ({ ok: false, error: "no text" }),
}));
vi.mock("@/lib/open-list-file", async (orig) => {
  const real = await orig<typeof import("@/lib/open-list-file")>();
  return { ...real, readListFile: m.readListFile };
});

import {
  SnapOrNoteSheet,
  closeSnapOrNote,
  openSnapOrNoteForTest,
  resetSnapForTest,
  sendTechPhoto,
  snapNote,
  snapStateForTest,
  snapTake,
} from "./snap-or-note";

const STAFF = { ok: true as const, orgId: "org-1", staff: true, punchJobId: null, jobs: [], shopStock: true };
const TECH = { ok: true as const, orgId: "org-1", staff: false, punchJobId: "j-11", jobs: [{ id: "j-11", label: "13897 Herringbone" }, { id: "j-2", label: "Smith Panel" }], shopStock: true };

const photo = (name = "receipt.jpg", bytes = "JPEGDATA-1") => new File([bytes], name, { type: "image/jpeg" });
const pdf = (name = "bill.pdf") => new File(["%PDF-1.7 a bill"], name, { type: "application/pdf" });
const lines = () => snapStateForTest().lines.map((l) => ({ name: l.name, text: l.text, tone: l.tone }));

let fetched: string[] = [];
beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.prep.mockImplementation(async (f: File) => f);
  m.upload.mockResolvedValue({ error: null });
  m.remove.mockResolvedValue({});
  m.fingerprintSeen.mockResolvedValue({ ok: true, seen: null });
  m.snapPaperRows.mockResolvedValue({ ok: true, items: [], jobs: [], matches: {}, shopStock: true });
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      fetched.push(`${url} ${init.body}`);
      return new Response(
        JSON.stringify({
          ok: true,
          item: { id: "p-1", title: "receipt.jpg", vendor: "Home Depot", amount: 84.12, picture: false, destination: "none", suggestion: { jobLabel: "J-011 13897 Herringbone", bucket: null, picked: true } },
        }),
      );
    }),
  );
  resetSnapForTest(STAFF);
});
afterEach(() => vi.unstubAllGlobals());

describe("the office's files: one queue, one set of rules", () => {
  it("the same file twice adds nothing: fingerprinted before upload, and the second says Already In", async () => {
    const seen = new Set<string>();
    m.fingerprintSeen.mockImplementation(async (sha: string) => ({ ok: true, seen: seen.has(sha) ? "Already In: added Sep 27, 2026, waiting in the tray to be filed." : null }));
    m.addPaperwork.mockImplementation(async (input: { sha256: string }) => {
      seen.add(input.sha256);
      return { ok: true, id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", needsRead: true };
    });
    const f = photo();
    await snapTake([f, photo("again.jpg")]);
    expect(m.addPaperwork).toHaveBeenCalledTimes(1);
    expect(m.upload).toHaveBeenCalledTimes(1);
    expect(m.addPaperwork.mock.calls[0][0]).toMatchObject({ source: "organize", mime: "image/jpeg", name: "receipt.jpg" });
    expect(m.addPaperwork.mock.calls[0][0].path).toMatch(/^org-1\/organize\/\d+-receipt\.jpg$/);
    expect(lines()).toEqual([
      { name: "receipt.jpg", text: "Read: Home Depot, $84.12. Picked from the paper: J-011 13897 Herringbone. Waiting for your answer.", tone: "ok" },
      { name: "again.jpg", text: "Already In: added Sep 27, 2026, waiting in the tray to be filed. Nothing was added twice.", tone: "warn" },
    ]);
    // The read ran on its own route (60 seconds from any page), never analyzeAndFile.
    expect(fetched).toEqual(['/api/paperwork/read {"id":"3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}']);
    // Its card is the sheet's to show.
    expect(snapStateForTest().papers).toEqual(["3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"]);
  });

  it("a mixed drop names what it skipped, by name, and takes the rest", async () => {
    m.addPaperwork.mockResolvedValue({ ok: true, id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e", needsRead: true });
    const docx = new File(["PK"], "notes.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const huge = new File([new Uint8Array(15 * 1024 * 1024 + 1)], "huge.jpg", { type: "image/jpeg" });
    const fakePdf = new File(["just text"], "fake.pdf", { type: "application/pdf" });
    const heic = new File(["heic"], "IMG_1.HEIC", { type: "image/heic" });
    await snapTake([pdf(), docx, huge, fakePdf, heic]);
    const said = Object.fromEntries(lines().map((l) => [l.name, l]));
    expect(said["bill.pdf"].tone).toBe("ok");
    expect(said["notes.docx"]).toEqual({
      name: "notes.docx",
      text: "Not added: Snap Or Note takes PDFs, photos, and a supplier's list or a bank download (Excel, CSV or OFX).",
      tone: "error",
    });
    expect(said["huge.jpg"].text).toBe("Not added: it is over 15 MB. Save a smaller copy and add it again.");
    expect(said["fake.pdf"].text).toBe("Not added: it is named like a PDF but isn't one inside.");
    expect(said["IMG_1.HEIC"].text).toBe("Not added: this HEIC photo couldn't be converted on this device. Save it as JPEG and add it again.");
    expect(m.addPaperwork).toHaveBeenCalledTimes(1);
  });

  it("a supplier's list or a bank download goes to addOpenList, read in the browser", async () => {
    m.readListFile.mockResolvedValue({ ok: true, table: [["Invoice #", "Open Balance"], ["8802-1", "10.00"]], listDate: "2026-09-20" });
    m.addOpenList.mockResolvedValue({ ok: true, id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5f", line: "A supplier's open list, 1 paper. Waiting below: press Apply on its card." });
    await snapTake([new File(["x"], "open.csv", { type: "text/csv" })]);
    expect(m.addOpenList.mock.calls[0][0]).toMatchObject({ name: "open.csv", source: "organize", listDate: "2026-09-20" });
    expect(m.addPaperwork).not.toHaveBeenCalled();
    expect(lines()[0]).toMatchObject({ tone: "ok", text: "A supplier's open list, 1 paper. Waiting below: press Apply on its card." });
  });

  it("saved is saved: a read that never answers leaves the paper waiting with Read Now", async () => {
    m.addPaperwork.mockResolvedValue({ ok: true, id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c60", needsRead: true });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    await snapTake([photo()]);
    expect(lines()[0]).toMatchObject({ tone: "warn", text: "Saved, not read yet: the reader didn't answer. Press Read Now on its card." });
  });

  it("a row that didn't land takes its upload back out", async () => {
    m.addPaperwork.mockResolvedValue({ ok: false, error: "receipt.jpg wasn't added. permission denied" });
    await snapTake([photo()]);
    expect(m.remove).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toMatchObject({ tone: "error", text: "receipt.jpg wasn't added. permission denied" });
  });

  it("closing the sheet mid-queue keeps the queue running: every file still gets its answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    m.addPaperwork.mockImplementation(async () => {
      await gate;
      return { ok: true, id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c61", needsRead: true };
    });
    openSnapOrNoteForTest();
    const running = snapTake([photo("a.jpg", "A"), photo("b.jpg", "B")]);
    await new Promise((r) => setTimeout(r, 0));
    closeSnapOrNote();
    expect(snapStateForTest().open).toBe(false);
    expect(lines().some((l) => l.tone === "busy")).toBe(true);
    release();
    await running;
    expect(lines().map((l) => l.tone)).toEqual(["ok", "ok"]);
    expect(m.addPaperwork).toHaveBeenCalledTimes(2);
  });
});

describe("notes", () => {
  it("an office note is saved and read once; a read that fails leaves it saved and says Saved, Not Read", async () => {
    m.routePastedText.mockResolvedValue({ kind: "note" });
    m.saveVoiceNote.mockResolvedValue({ ok: true, id: "n-1", read: false });
    expect(await snapNote("call the inspector Tuesday")).toBe(true);
    expect(m.saveVoiceNote).toHaveBeenCalledWith("call the inspector Tuesday", { read: true });
    expect(lines()).toEqual([{ name: "call the inspector Tuesday", text: "Saved, Not Read.", tone: "warn" }]);
    m.saveVoiceNote.mockResolvedValue({ ok: true, id: "n-2", read: true });
    await snapNote("order more wire nuts");
    expect(lines()[1]).toMatchObject({ text: "Saved as a note, and read.", tone: "ok" });
  });

  it("pasted supplier text is imported instead of saved as a note, and the line says what came in", async () => {
    m.routePastedText.mockResolvedValue({ kind: "imported", ok: true, line: "Imported 2 supplier invoices from the pasted text: Read 2 documents. 2 documents are new." });
    expect(await snapNote("INVOICE NO.\n8802-1101363\n...")).toBe(true);
    expect(m.saveVoiceNote).not.toHaveBeenCalled();
    expect(lines()[0]).toMatchObject({ tone: "ok", text: "Imported 2 supplier invoices from the pasted text: Read 2 documents. 2 documents are new." });
  });

  it("a note that didn't save says so, and hands its words back", async () => {
    m.routePastedText.mockResolvedValue({ kind: "note" });
    m.saveVoiceNote.mockRejectedValue(new TypeError("network"));
    expect(await snapNote("don't lose me")).toBe(false);
    expect(lines()[0]).toMatchObject({ tone: "error", text: "Not saved: the connection dropped. Your words are back in the box." });
  });

  it("a tech's note is his own row, never read, never routed to the importer", async () => {
    resetSnapForTest(TECH);
    m.saveVoiceNote.mockResolvedValue({ ok: true, id: "n-3" });
    await snapNote("need more 12/2 at Herringbone");
    expect(m.saveVoiceNote).toHaveBeenCalledWith("need more 12/2 at Herringbone");
    expect(m.routePastedText).not.toHaveBeenCalled();
    expect(lines()[0]).toMatchObject({ tone: "ok", text: "Saved for the office." });
  });
});

describe("a tech's photo: which job, no read, no amount", () => {
  beforeEach(() => resetSnapForTest(TECH));

  it("waits for Which Job?, needs a job, files on it for the office through the job's own door with read: false, and says no $", async () => {
    await snapTake([photo("ticket.jpg")]);
    // Nothing went anywhere yet: it waits in the store (closing the sheet drops nothing).
    const [waiting] = snapStateForTest().pending;
    expect(waiting).toMatchObject({ name: "ticket.jpg" });
    expect(m.captureReceipt).not.toHaveBeenCalled();

    await sendTechPhoto(waiting.id, null);
    expect(m.captureReceipt).not.toHaveBeenCalled();
    expect(lines()[0]).toMatchObject({ tone: "error", text: "Not sent: pick the job it's for first." });

    await snapTake([photo("ticket2.jpg")]);
    m.captureReceipt.mockResolvedValue({ kind: "filed", docId: "d-1", tone: "ok", why: "not_asked", sentence: "Filed on the job." });
    await sendTechPhoto(snapStateForTest().pending[0].id, "j-11");
    expect(m.captureReceipt).toHaveBeenCalledTimes(1);
    expect(m.captureReceipt.mock.calls[0][0]).toMatchObject({ orgId: "org-1", jobId: "j-11", read: false, category: "Receipt" });
    expect(lines()[1]).toMatchObject({ tone: "ok", text: "Filed On 13897 Herringbone For The Office." });
    // The reader never ran, and the office's paper door was never touched.
    expect(fetched).toEqual([]);
    expect(m.addPaperwork).not.toHaveBeenCalled();
    expect(m.fingerprintSeen).not.toHaveBeenCalled();
    for (const l of lines()) expect(l.text).not.toMatch(/\$/);
  });

  it("a lost upload says its own sentence, which names no amount", async () => {
    await snapTake([photo("t.jpg")]);
    m.captureReceipt.mockResolvedValue({ kind: "lost", tone: "fail", sentence: "Didn't upload (Network error) — try again, or type it in with Add Cost." });
    await sendTechPhoto(snapStateForTest().pending[0].id, "j-2");
    expect(lines()[0]).toMatchObject({ tone: "error", text: "Didn't upload (Network error) — try again, or type it in with Add Cost." });
    expect(lines()[0].text).not.toMatch(/\$/);
  });

  it("a file that isn't a photo is the office's to add, said by name", async () => {
    await snapTake([pdf("statement.pdf")]);
    expect(snapStateForTest().pending).toEqual([]);
    expect(lines()[0]).toMatchObject({ name: "statement.pdf", tone: "error", text: "Not sent: the office adds files. Take a photo instead." });
  });
});

describe("the sheet", () => {
  const sheet = (isStaff: boolean) => renderToStaticMarkup(createElement(SnapOrNoteSheet, { isStaff, onClose: () => {} }));

  it("is titled Snap Or Note, with Take Photo, Choose Files for the office, and a note box with a mic", () => {
    const html = sheet(true);
    expect(html).toContain(">Snap Or Note</h2>");
    expect(html).toContain("Take Photo");
    expect(html).toContain("Choose Files");
    expect(html).toContain('placeholder="Type A Note…"');
    expect(html).toContain('aria-label="Say A Note"');
  });

  it("a tech's sheet has Take Photo and a note, and no Choose Files", () => {
    const html = sheet(false);
    expect(html).toContain("Take Photo");
    expect(html).toContain('placeholder="Type A Note…"');
    expect(html).not.toContain("Choose Files");
    expect(html).not.toMatch(/<input[^>]*multiple/);
  });

  it("Take Photo is one picture from the camera: capture, and never multiple beside it (iOS would open the library)", () => {
    for (const html of [sheet(true), sheet(false)]) {
      const camera = html.match(/<input[^>]*capture="environment"[^>]*>/g) ?? [];
      expect(camera).toHaveLength(1);
      expect(camera[0]).not.toContain("multiple");
      expect(camera[0]).toContain('accept="image/*"');
    }
    const files = sheet(true).match(/<input[^>]*multiple[^>]*>/g) ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("capture");
  });

  it("every control is 44px", () => {
    for (const html of [sheet(true), sheet(false)]) {
      for (const b of html.match(/<button[^>]*>/g) ?? []) {
        if (b.includes('aria-label="Close"')) continue; // the Modal's own X
        expect(b).toMatch(/\bh-11\b|\bmin-h-11\b/);
      }
      expect(html).toMatch(/<textarea[^>]*min-h-11/);
    }
  });
});

describe("one paper door (source pins)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("no client calls analyzeAndFile any more: the no-fingerprint fallback is gone", () => {
    for (const f of ["src/components/snap-or-note.tsx", "src/app/(app)/organize/organize-manager.tsx", "src/app/(app)/bills/bills-drop.tsx"]) {
      expect(src(f)).not.toContain("analyzeAndFile");
    }
    // The server action itself stays (organize/paperwork.test.ts calls it).
    expect(src("src/app/(app)/organize/actions.ts")).toContain("export async function analyzeAndFile(");
  });

  it("the queue lives in the + (mounted once in the top bar), and Organize and Bills open it instead of their own", () => {
    expect(src("src/components/global-quick-add.tsx")).toContain("<SnapOrNoteProvider");
    expect(src("src/app/(app)/organize/page.tsx")).toContain("<SnapOrNoteButton />");
    expect(src("src/app/(app)/organize/organize-manager.tsx")).not.toMatch(/Take Photo|Voice Note|capture="environment"|processFiles/);
    const bills = src("src/app/(app)/bills/page.tsx");
    expect(bills).toContain("<SnapOrNoteButton />");
    expect(bills).not.toContain("DropPaperworkButton");
    expect(src("src/app/(app)/bills/bills-drop.tsx")).toContain("snapFiles(Array.from(e.dataTransfer?.files ?? []))");
    expect(src("src/app/(app)/bills/bills-drop.tsx")).toContain("Drop Papers Here");
  });

  it("no one reads Drop Paperwork or Capture Anything any more", () => {
    for (const f of [
      "src/components/snap-or-note.tsx",
      "src/app/(app)/bills/bills-drop.tsx",
      "src/app/(app)/bills/bills-receipts.tsx",
      "src/app/(app)/bills/page.tsx",
      "src/components/global-quick-add.tsx",
      "src/lib/pdf-text.ts",
      "src/app/(app)/bills/supplier-import-actions.ts",
    ]) {
      const strings = src(f)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(strings, f).not.toMatch(/Drop Paperwork|Capture Anything|Capture anything/);
    }
  });
});
