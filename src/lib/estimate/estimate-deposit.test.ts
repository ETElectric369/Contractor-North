import { describe, it, expect } from "vitest";
import { depositFollowsTotal, depositShown, storedDepositAfterSave } from "./estimate-deposit";

/**
 * THE DEPOSIT AN ESTIMATE STORES (cn-v1177): what `quotes.deposit_amount` holds after a save, and what the
 * editor shows, from one rule. California's default, 10% up to $1,000.
 */
const CA = { percent: 10, cap: 1000 };

describe("storedDepositAfterSave", () => {
  it("an open offer follows its total through the company's rule", () => {
    expect(storedDepositAfterSave({ total: 4800, status: "draft", stored: null, byHand: false, rule: CA })).toBe(480);
    expect(storedDepositAfterSave({ total: 25000, status: "sent", stored: 480, byHand: false, rule: CA })).toBe(1000);
    expect(storedDepositAfterSave({ total: 0, status: "draft", stored: 480, byHand: false, rule: CA })).toBe(0);
    expect(storedDepositAfterSave({ total: 4800, status: "draft", stored: null, byHand: false, rule: { percent: 0, cap: 1000 } })).toBe(0);
    expect(storedDepositAfterSave({ total: "4800.00", status: "draft", stored: "1.00", byHand: false, rule: { percent: 25, cap: 0 } })).toBe(1200);
  });

  it("a typed deposit survives the save and is never above the total", () => {
    expect(storedDepositAfterSave({ total: 4800, status: "draft", stored: 2000, byHand: true, rule: CA })).toBe(2000);
    expect(storedDepositAfterSave({ total: 4800, status: "sent", stored: "2000.00", byHand: true, rule: null })).toBe(2000);
    expect(storedDepositAfterSave({ total: 1500, status: "draft", stored: 2000, byHand: true, rule: CA })).toBe(1500);
    expect(storedDepositAfterSave({ total: 4800, status: "draft", stored: 0, byHand: true, rule: CA })).toBe(0);
  });

  it("an offer no longer open keeps what it stated (only lowered to its total); one saved before 0414 stays null", () => {
    expect(storedDepositAfterSave({ total: 9000, status: "accepted", stored: 480, byHand: false, rule: CA })).toBeUndefined();
    expect(storedDepositAfterSave({ total: 300, status: "accepted", stored: 480, byHand: false, rule: CA })).toBe(300);
    expect(storedDepositAfterSave({ total: 9000, status: "accepted", stored: null, byHand: false, rule: CA })).toBeUndefined();
    for (const status of ["declined", "expired", "superseded", null, undefined])
      expect(storedDepositAfterSave({ total: 9000, status, stored: null, byHand: false, rule: CA })).toBeUndefined();
  });

  it("a company rule that could not be read guesses nothing: the stored figure stands", () => {
    expect(storedDepositAfterSave({ total: 9000, status: "draft", stored: 480, byHand: false, rule: null })).toBeUndefined();
    expect(storedDepositAfterSave({ total: 9000, status: "draft", stored: null, byHand: false, rule: null })).toBeUndefined();
    expect(storedDepositAfterSave({ total: 100, status: "draft", stored: 480, byHand: false, rule: null })).toBe(100);
  });

  it("only draft and sent follow the total", () => {
    expect(["draft", "sent", "accepted", "declined", "expired", "superseded"].map(depositFollowsTotal)).toEqual([true, true, false, false, false, false]);
  });
});

describe("depositShown (the editor's field)", () => {
  it("shows what the next save stores, and says where it came from", () => {
    expect(depositShown({ total: 4800, status: "draft", stored: 480, byHand: false, rule: CA })).toEqual({ amount: 480, from: "default", notStatedYet: false });
    expect(depositShown({ total: 4800, status: "draft", stored: 2000, byHand: true, rule: CA })).toEqual({ amount: 2000, from: "typed", notStatedYet: false });
    expect(depositShown({ total: 4800, status: "draft", stored: 0, byHand: true, rule: CA })).toEqual({ amount: 0, from: "typed", notStatedYet: false });
    expect(depositShown({ total: 4800, status: "draft", stored: 480, byHand: false, rule: { percent: 0, cap: 0 } })).toEqual({ amount: 0, from: "none", notStatedYet: false });
  });

  it("an open estimate saved before 0414 shows the figure it WOULD store, marked as not stated yet", () => {
    expect(depositShown({ total: 4800, status: "sent", stored: null, byHand: false, rule: CA })).toEqual({ amount: 480, from: "default", notStatedYet: true });
  });

  it("an accepted estimate shows the stored figure, and none when it stated none", () => {
    expect(depositShown({ total: 4800, status: "accepted", stored: 480, byHand: false, rule: { percent: 50, cap: 0 } })).toEqual({ amount: 480, from: "default", notStatedYet: false });
    expect(depositShown({ total: 4800, status: "accepted", stored: null, byHand: false, rule: CA })).toEqual({ amount: 0, from: "none", notStatedYet: false });
  });
});
