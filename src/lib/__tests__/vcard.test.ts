import { describe, expect, it } from "vitest";
import { parseVCards } from "../vcard";

/**
 * THE REGRESSION THIS FILE EXISTS FOR: a real iPhone contact imported as a NAME AND NOTHING ELSE.
 * Apple emits grouped properties (`item1.TEL`), the matchers were anchored `^TEL`, and every phone,
 * email and address fell on the floor without an error. Any future rewrite of the matcher has to
 * keep passing a genuine Apple export, not a hand-tidied one.
 */
const APPLE = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 17.5.1//EN",
  "N:Cain;Sara;;;",
  "FN:Sara Cain",
  "ORG:Cain Residence;",
  "item1.TEL;type=HOME;type=VOICE:(530) 555-9999",
  "item2.TEL;type=CELL;type=VOICE;type=pref:(775) 555-0142",
  "item3.EMAIL;type=INTERNET;type=HOME;type=pref:sara.cain@example.com",
  "item4.ADR;type=HOME;type=pref:;;1234 Alder Creek Rd;Truckee;CA;96161;United States",
  "END:VCARD",
].join("\r\n");

describe("parseVCards", () => {
  it("reads every field off a real iPhone export, not just the name", () => {
    const [c] = parseVCards(APPLE);
    expect(c).toEqual({
      name: "Sara Cain",
      company_name: "Cain Residence",
      phone: "(775) 555-0142",
      email: "sara.cain@example.com",
      address: "1234 Alder Creek Rd",
      city: "Truckee",
      state: "CA",
      zip: "96161",
    });
  });

  it("prefers the number Apple marked preferred over the first one listed", () => {
    // The home line comes FIRST in the file; the cell is the one he actually calls.
    expect(parseVCards(APPLE)[0].phone).toBe("(775) 555-0142");
  });

  it("still reads an ungrouped card (Google/Outlook emit these)", () => {
    const plain = "BEGIN:VCARD\nVERSION:3.0\nFN:Andrew Cohen\nTEL;TYPE=CELL:5305551234\nEMAIL:a@b.com\nEND:VCARD";
    const [c] = parseVCards(plain);
    expect(c.name).toBe("Andrew Cohen");
    expect(c.phone).toBe("5305551234");
    expect(c.email).toBe("a@b.com");
  });

  it("splits a multi-card file and drops nameless cards", () => {
    const two = `${APPLE}\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nitem1.TEL:5305550000\r\nEND:VCARD\r\n`;
    expect(parseVCards(two)).toHaveLength(1); // the nameless one is not a customer
  });

  it("honours RFC line folding", () => {
    const folded = "BEGIN:VCARD\r\nFN:Sara Cain\r\nitem1.ADR;type=HOME:;;1234 Alder\r\n  Creek Rd;Truckee;CA;96161;\r\nEND:VCARD";
    expect(parseVCards(folded)[0].address).toBe("1234 Alder Creek Rd");
  });
});
