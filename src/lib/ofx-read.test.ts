import { describe, expect, it } from "vitest";
import { looksLikeOfx, ofxDate, OFX_HEADER, readOfx } from "./ofx-read";
import { isListFile, tableFromHtml } from "./open-list-file";

/**
 * A BANK'S QUICKEN / QUICKBOOKS DOWNLOAD (OFX, QFX, QBO) AND A WEB PAGE SAVED AS ".xls", as the
 * rows the bank reader reads. MADE-UP statements only.
 */

describe("readOfx", () => {
  it("reads OFX 2 XML: account, posted day, signed amount, check number, the bank's own id", () => {
    const xml = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><BANKID>000000000</BANKID><ACCTID>99990000555</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260904</DTPOSTED><TRNAMT>1275.00</TRNAMT><FITID>A-1</FITID><NAME>DEPOSIT</NAME></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260909120000</DTPOSTED><TRNAMT>-45.10</TRNAMT><FITID>A-2</FITID><NAME>HOME HARDWARE</NAME><MEMO>STORE 55</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(looksLikeOfx(xml)).toBe(true);
    expect(readOfx(xml, "x.qbo")).toEqual({
      ok: true,
      rows: [
        [...OFX_HEADER],
        ["99990000555", "2026-09-04", "DEPOSIT", "1275.00", "", "A-1"],
        ["99990000555", "2026-09-09", "HOME HARDWARE STORE 55", "-45.10", "", "A-2"],
      ],
    });
  });

  it("says so by name when a file has no transactions or isn't OFX", () => {
    expect(readOfx("OFXHEADER:100\n<OFX></OFX>", "empty.qfx")).toEqual({ ok: false, error: "empty.qfx has no transactions in it." });
    expect(readOfx("Date,Amount", "a.ofx")).toMatchObject({ ok: false, error: expect.stringMatching(/^a\.ofx isn't a bank download/) });
    expect(ofxDate("20261340")).toBeNull();
  });

  it("the drop doors take .ofx, .qfx and .qbo as list files", () => {
    for (const name of ["Checking.ofx", "Checking.QFX", "books.qbo", "AccountHistory.xls"]) expect(isListFile({ name })).toBe(true);
    expect(isListFile({ name: "photo.jpg", type: "image/jpeg" })).toBe(false);
  });
});

describe("tableFromHtml", () => {
  it("reads the table in a web page saved as .xls", () => {
    const html = `<html><body><table><tr><th>Post Date</th><th>Description</th><th>Amount</th></tr>
<tr><td>09/02/2026</td><td>SHELL&nbsp;123 &amp; CO</td><td>-88.45</td></tr><tr><td></td><td></td><td></td></tr></table></body></html>`;
    expect(tableFromHtml(html)).toEqual([
      ["Post Date", "Description", "Amount"],
      ["09/02/2026", "SHELL 123 & CO", "-88.45"],
    ]);
    expect(tableFromHtml("<p>no table</p>")).toBeNull();
  });
});
