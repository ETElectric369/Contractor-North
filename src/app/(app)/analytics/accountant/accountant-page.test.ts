import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_HIDDEN_WHY } from "@/lib/accountant-workbook";
import { ORG_UNREAD_WORDS, ROLE_UNREAD_WORDS, accountantPageViewer } from "./viewer";
import { DIDNT_COME_WORDS, NOT_THE_FILE_WORDS, SIGNED_OUT_WORDS, XLSX_TYPE, ZIP_TYPE, downloadVerdict } from "./download-response";

/**
 * THE ACCOUNTANT PAGE: who sees the totals (fail closed), what the download button accepts as the
 * file, and the page reading the route's own span. Every name here is invented.
 */
const ok = (data: unknown) => ({ data, error: null });
const failed = { data: null, error: { message: "boom" } };
const org = (officeSees: boolean) => ok({ name: "Harbor Electric", settings: { office_sees_owner_money: officeSees } });

describe("who sees the totals on the page: fail closed, and never the owner's note to the owner", () => {
  it("the owner always; the office only when the owner has shared Owner's Draw", () => {
    expect(accountantPageViewer(org(false), ok({ role: "owner" }))).toEqual({ showOwner: true, why: null });
    expect(accountantPageViewer(org(true), ok({ role: "office" }))).toEqual({ showOwner: true, why: null });
    expect(accountantPageViewer(org(false), ok({ role: "admin" }))).toEqual({ showOwner: false, why: OWNER_HIDDEN_WHY });
  });

  it("a company read that fails shows no totals and says so (the switch's default is never taken as a yes)", () => {
    expect(accountantPageViewer(failed, ok({ role: "office" }))).toEqual({ showOwner: false, why: ORG_UNREAD_WORDS });
    expect(accountantPageViewer(ok(null), ok({ role: "office" }))).toEqual({ showOwner: false, why: ORG_UNREAD_WORDS });
  });

  it("a role read that fails shows no totals and says the sign-in couldn't be checked, never 'the owner hasn't shared'", () => {
    const v = accountantPageViewer(org(false), failed);
    expect(v).toEqual({ showOwner: false, why: ROLE_UNREAD_WORDS });
    expect(v.why).not.toContain("owner hasn't shared");
    expect(accountantPageViewer(org(true), failed).showOwner).toBe(false);
  });
});

describe("the download button saves only the file", () => {
  const file = { ok: true, status: 200, type: "basic", redirected: false, contentType: XLSX_TYPE, disposition: 'attachment; filename="Harbor Electric 2026.xlsx"' };

  it("the workbook and the zip are the file", () => {
    expect(downloadVerdict(file, "xlsx")).toEqual({ ok: true });
    expect(downloadVerdict({ ...file, contentType: ZIP_TYPE }, "csv")).toEqual({ ok: true });
  });

  it("signed out: the middleware's redirect to the login page is said in words, never saved as the .xlsx", () => {
    // fetch(..., { redirect: "manual" }) hands back an opaque redirect: status 0, no headers.
    expect(downloadVerdict({ ok: false, status: 0, type: "opaqueredirect", contentType: null, disposition: null }, "xlsx")).toEqual({ ok: false, words: SIGNED_OUT_WORDS });
    // A client that followed it anyway gets the login page with a 200.
    expect(downloadVerdict({ ok: true, status: 200, redirected: true, contentType: "text/html; charset=utf-8", disposition: null }, "xlsx")).toEqual({ ok: false, words: SIGNED_OUT_WORDS });
    expect(downloadVerdict({ ok: true, status: 200, contentType: "text/html; charset=utf-8", disposition: null }, "xlsx")).toEqual({ ok: false, words: NOT_THE_FILE_WORDS });
  });

  it("the route's own refusal is said in its words; anything else is not passed off as words", () => {
    expect(downloadVerdict({ ok: false, status: 403, contentType: "text/plain; charset=utf-8", disposition: null, body: "This is for the office only." }, "xlsx")).toEqual({
      ok: false,
      words: "This is for the office only.",
    });
    expect(downloadVerdict({ ok: false, status: 500, contentType: "text/html", disposition: null, body: "<html>Internal Server Error</html>" }, "xlsx")).toEqual({ ok: false, words: DIDNT_COME_WORDS });
    // The wrong kind of file for the button tapped.
    expect(downloadVerdict({ ...file, contentType: ZIP_TYPE }, "xlsx")).toEqual({ ok: false, words: NOT_THE_FILE_WORDS });
  });
});

describe("the page and its download agree", () => {
  const src = (f: string) => readFileSync(join(__dirname, f), "utf8");

  it("the page reads the route's own span, so its two figures are the file's to the cent", () => {
    expect(src("page.tsx")).toContain("readOwnerMoneyInputs(supabase, accountantReadSpan(period), tz, todayYmd)");
    expect(src("export/route.ts")).toContain("const span = accountantReadSpan(period);");
  });

  it("its two figures are the profit and loss's top and bottom lines, by their own rows and words (Revenue, Net Profit (Owner's Draw))", () => {
    const page = src("page.tsx");
    expect(page).toContain("const pnl = figures ? profitAndLoss(figures) : [];");
    expect(page).toContain('const revenue = pnlRow(pnl, "revenue");');
    expect(page).toContain('const net = pnlRow(pnl, "net_profit");');
    expect(page).toContain("{revenue.label}");
    expect(page).toContain("{net.label}");
    // The bottom line is before income tax, said under it; the old words are gone.
    expect(page).toContain("Before income tax.");
    expect(page).not.toMatch(/>Received</);
    expect(page).not.toContain("NET_LABEL");
  });

  it("a period before the records hides the figures only when it truly has nothing in it", () => {
    const page = src("page.tsx");
    expect(page).toContain("beforeRecordsLine(period, read.inputs.recordsStart, cur.totals)");
    expect(page).toContain(") : beforeRecords?.nothing ? (");
    expect(page).not.toMatch(/\) : beforeRecords \? \(/);
  });

  it("the picker is keyed on the period it shows, and the download waits while a newly picked period opens", () => {
    expect(src("page.tsx")).toMatch(/<AccountantPeriodPicker\s+key=\{period\.key\}/);
    expect(src("page.tsx")).not.toContain("defaultValue={period.key}");
    // An older bookmarked period is among the choices, so the picker shows the period the file is.
    expect(src("page.tsx")).toContain("periodChoices(period.kind, todayYmd, period)");
    const button = src("accountant-download.tsx");
    expect(button.match(/disabled=\{busy !== null \|\| opening !== null\}/g)).toHaveLength(3);
    expect(button).toContain('redirect: "manual"');
  });

  it("a file kept for Save The File never outlives its period: the card is keyed on the period, and Save The File waits while one opens", () => {
    // Next keeps a page's client state when only the search params change, so without the key a
    // Q2 file left waiting for Save The File would still be handed over under a card that reads Q3.
    expect(src("page.tsx")).toMatch(/<AccountantDownload\s+key=\{period\.key\}/);
    const button = src("accountant-download.tsx");
    const save = button.slice(button.indexOf("onClick={() => void share(ready, true)}"), button.indexOf("Save The File\n"));
    expect(save).toContain("disabled={busy !== null || opening !== null}");
  });
});
