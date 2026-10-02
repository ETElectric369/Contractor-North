import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { codeOnly } from "@/lib/migration-body.test-util";
import { memberEditToSave, rateBoxesToSave } from "./save-what-changed";

/**
 * A SAVE NEVER DESTROYS WHAT IT ONLY READ (the /team defect's third tooth, 2026-10-01).
 *
 * The trigger was a `profile_pay` read that failed WHOLE in a migration window: every box arrived null,
 * rendered 0, and the next save wrote the zeros back as nulls. The read is fixed (profilePayRead's
 * ladder) and /team now hides the boxes and says so when it fails - but a form that sends fields nobody
 * touched is its own fault, and this is where it stops. Each case below is a figure that was really lost.
 */
describe("rateBoxesToSave - a rate box the person never changed is not in the patch", () => {
  /**
   * THE DATA LOSS, EXACTLY AS IT HAPPENED. The read failed, so Brian's boxes both show $0. The office
   * types his real $40 into Pay. The old code sent `bill || null` regardless, so the write was
   * {hourly_rate: 40, bill_rate: null} and his stored $85 bill rate was deleted by a save that was
   * never about his bill rate. Now the patch names only the box that was typed in.
   */
  it("typing a pay rate into a row whose read failed never nulls the bill rate", () => {
    const read = { rate: null, billRate: null, costRate: null }; // what a failed read hands the box
    const save = rateBoxesToSave(read, { pay: 40, bill: 0, cost: 0 }, false);
    expect(save).toEqual({ hourlyRate: 40 });
    expect(save).not.toHaveProperty("billRate");
  });

  /** And the ordinary case is unchanged: a real edit to one box sends that box. */
  it("changing only the bill rate sends only the bill rate", () => {
    const save = rateBoxesToSave({ rate: 40, billRate: 85, costRate: null }, { pay: 40, bill: 95, cost: 0 }, false);
    expect(save).toEqual({ billRate: 95 });
  });

  /** Clearing a box IS a change, and still clears. The rule is "was it touched", not "is it empty". */
  it("clearing the bill rate on purpose still clears it", () => {
    expect(rateBoxesToSave({ rate: 40, billRate: 85, costRate: null }, { pay: 40, bill: 0, cost: 0 }, false)).toEqual({
      billRate: null,
    });
  });

  it("nothing changed sends nothing at all", () => {
    expect(rateBoxesToSave({ rate: 40, billRate: 85, costRate: null }, { pay: 40, bill: 85, cost: 0 }, false)).toBeNull();
  });

  /**
   * THE OWNER'S ROW. His Cost box is the one thing he came for, and his save carries NO pay figure
   * (0286: he is paid by owner's draw and payroll refuses him) - so typing a cost rate can never be
   * read as a wage, in the app or at the database's own trigger.
   */
  it("the owner's save carries his cost rate and never a pay figure", () => {
    const save = rateBoxesToSave({ rate: null, billRate: 125, costRate: null }, { pay: 0, bill: 125, cost: 65 }, true);
    expect(save).toEqual({ costRate: 65 });
    expect(save).not.toHaveProperty("hourlyRate");
  });

  /** And a crew member's save never carries a cost rate: cost_rate is the owner's column alone. */
  it("a crew member's save never carries a cost rate", () => {
    const save = rateBoxesToSave({ rate: 40, billRate: 85, costRate: null }, { pay: 45, bill: 85, cost: 999 }, false);
    expect(save).toEqual({ hourlyRate: 45 });
    expect(save).not.toHaveProperty("costRate");
  });

  /** His bill rate still saves from his row, and still on its own (audit v994 MR7's door). */
  it("the owner's bill rate saves on its own", () => {
    expect(rateBoxesToSave({ rate: null, billRate: 125, costRate: 65 }, { pay: 0, bill: 0, cost: 65 }, true)).toEqual({
      billRate: null,
    });
  });
});

describe("memberEditToSave - a Save about a phone number says nothing about a home address", () => {
  const read = {
    full_name: "Brian Taylor",
    phone: "555-0100",
    home_address: "2 Crew St",
    commute_baseline_miles: 12,
    role: "tech",
    crew_lead: false,
  };
  const typed = {
    full_name: "Brian Taylor",
    phone: "555-0100",
    home_address: "2 Crew St",
    commute_baseline_miles: 12,
    role: "tech",
    crew_lead: false,
  };

  /**
   * THE LIKELIER TRIGGER, AND IT NEEDED NO RATE TYPING. The editor sent home_address and
   * commute_baseline_miles on EVERY save, so if the read that filled them failed, a Save about a phone
   * number cleared the home address and zeroed the baseline - the mileage origin the Tax Report
   * deducts the commute from, lost with nothing on screen about either field.
   */
  it("changing the phone sends the phone and nothing else", () => {
    const save = memberEditToSave(read, { ...typed, phone: "555-0199" }, { isSelf: false });
    expect(save).toEqual({ phone: "555-0199" });
    expect(save).not.toHaveProperty("home_address");
    expect(save).not.toHaveProperty("commute_baseline_miles");
  });

  /** The same for the crew-lead checkbox, the other one-click Save on that modal. */
  it("ticking Crew Leader sends the flag and never the address", () => {
    const save = memberEditToSave(read, { ...typed, crew_lead: true }, { isSelf: false });
    expect(save).toEqual({ crew_lead: true });
  });

  /** A read that never arrived leaves the fields blank; a Save must then write NOTHING, not blanks. */
  it("a save on a modal whose read failed writes nothing at all", () => {
    const blank = { full_name: "", phone: "", home_address: "", commute_baseline_miles: 0, role: "tech", crew_lead: false };
    expect(memberEditToSave({ role: "tech" }, blank, { isSelf: false })).toBeNull();
  });

  /** Editing the address on purpose still saves it, cleared or changed. */
  it("editing the home address on purpose still saves it", () => {
    expect(memberEditToSave(read, { ...typed, home_address: "9 New Rd" }, { isSelf: false })).toEqual({
      home_address: "9 New Rd",
    });
    expect(memberEditToSave(read, { ...typed, home_address: "" }, { isSelf: false })).toEqual({ home_address: "" });
    expect(memberEditToSave(read, { ...typed, commute_baseline_miles: 20 }, { isSelf: false })).toEqual({
      commute_baseline_miles: 20,
    });
  });

  /** Nobody sends their own role (the owner cannot demote himself; the server refuses it too). */
  it("a self edit never sends a role", () => {
    const save = memberEditToSave({ ...read, role: "owner" }, { ...typed, role: "admin", phone: "555-0199" }, { isSelf: true });
    expect(save).toEqual({ phone: "555-0199" });
  });
});

/**
 * AND THE TWO EDITORS ACTUALLY ASK IT (one rule, one place, with a tooth on it).
 *
 * The rule above is only worth having if the forms use it. These are the two exact hand-written
 * expressions that destroyed data - `bill || null` on every MemberRate save, and `home_address:
 * homeAddress` on every EditMemberButton save - pinned so neither can come back, and so a future
 * editor that builds its own patch is noticed instead of shipping. Comments are stripped through the
 * FIXED stripper (codeOnly), so a mention in prose is not mistaken for code.
 */
describe("the /team editors build their patch through this rule, never by hand", () => {
  const source = (file: string) => codeOnly(readFileSync(`${process.cwd()}/src/app/(app)/settings/${file}`, "utf8"));

  it("MemberRate asks rateBoxesToSave and no longer sends a bill rate it never read", () => {
    const code = source("member-rate.tsx");
    expect(code).toContain("rateBoxesToSave(");
    // THE LINE THAT DELETED BRIAN'S $85: `bill || null` sent whatever the box held, on every save.
    expect(code).not.toMatch(/\bbill\s*\|\|\s*null/);
    expect(code).not.toMatch(/\bcost\s*\|\|\s*null/);
    expect(code).not.toMatch(/\bpay\s*\|\|\s*null/);
  });

  it("EditMemberButton asks memberEditToSave and no longer sends an address it never read", () => {
    const code = source("edit-member-button.tsx");
    expect(code).toContain("memberEditToSave(");
    // THE CALL THAT CLEARED THE MILEAGE ORIGIN. It handed updateMember an object literal built from
    // every field on the form, so home_address and commute_baseline_miles went with a Save about a
    // phone number. The patch is the rule's answer now, so this call carries no literal of its own.
    expect(code).not.toMatch(/updateMember\(\s*member\.id\s*,\s*\{/);
    expect(code).toMatch(/updateMember\(\s*member\.id\s*,\s*patch\s*\)/);
  });
});
