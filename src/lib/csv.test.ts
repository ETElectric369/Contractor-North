import { describe, it, expect } from "vitest";
import { parseCSV, csvToObjects } from "./csv";

/**
 * THE INCH MARK. Every "must not swallow" case here is a real shape out of a trade parts list —
 * an unescaped `"` meaning inches, in a field nobody quoted. Before cn-v696 the first one of these
 * in a file collapsed EVERY remaining row into a single cell, silently.
 */
describe("parseCSV — a quote only opens a field at its start", () => {
  it("an inch mark mid-field does not eat the rest of the file", () => {
    const csv = [
      "code,description,unit,price",
      'SMX4RLSFSD2W,4" RND LS(650/800/1000),ea,36.73',
      "H245ICAT,4'' LED SHALLOW IC HSG,ea,12.50",
      "NEXT,PLAIN ROW,ea,1.00",
    ].join("\n");
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual(["SMX4RLSFSD2W", '4" RND LS(650/800/1000)', "ea", "36.73"]);
    // The row AFTER the inch mark is the one that used to vanish.
    expect(rows[3]).toEqual(["NEXT", "PLAIN ROW", "ea", "1.00"]);
  });

  it("keeps the columns aligned — the live symptom was a price landing in `unit`", () => {
    const rows = parseCSV(['code,description,unit,price', 'X,1/2" EMT,ft,0.89'].join("\n"));
    expect(rows[1][2]).toBe("ft");
    expect(rows[1][3]).toBe("0.89");
  });

  it("two inch marks in one field are both literal, not a quoted region", () => {
    const rows = parseCSV(['a,b\n1,2x6" x 12" board,\n'].join(""));
    expect(rows[1][1]).toBe('2x6" x 12" board');
  });

  it("a foot mark is untouched", () => {
    expect(parseCSV("a,b\n1,2x6x12' PT")[1][1]).toBe("2x6x12' PT");
  });
});

describe("parseCSV — real quoting still works exactly as before", () => {
  it("a quoted field carries its commas", () => {
    expect(parseCSV('a,b\n1,"Truckee, CA 96161"')[1]).toEqual(["1", "Truckee, CA 96161"]);
  });

  it('escaped "" inside a quoted field is one literal quote', () => {
    expect(parseCSV('a,b\n1,"4"" RND LS"')[1][1]).toBe('4" RND LS');
  });

  it("a quoted field carries newlines", () => {
    const rows = parseCSV('a,b\n1,"line one\nline two"\n2,plain');
    expect(rows).toHaveLength(3);
    expect(rows[1][1]).toBe("line one\nline two");
    expect(rows[2]).toEqual(["2", "plain"]);
  });

  it("CRLF and blank rows", () => {
    expect(parseCSV("a,b\r\n1,2\r\n\r\n3,4\r\n")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("empty cells survive as empty strings, not dropped columns", () => {
    expect(parseCSV("a,b,c\n1,,3")[1]).toEqual(["1", "", "3"]);
  });
});

describe("csvToObjects", () => {
  it("keys by a lowercased header and trims", () => {
    expect(csvToObjects(' Code , Description \nA1, 1/2" EMT ')).toEqual([
      { code: "A1", description: '1/2" EMT' },
    ]);
  });

  it("no data rows is an empty list, not a throw", () => {
    expect(csvToObjects("a,b")).toEqual([]);
    expect(csvToObjects("")).toEqual([]);
  });
});
