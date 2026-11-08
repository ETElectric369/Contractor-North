import { describe, it, expect } from "vitest";
import {
  checkSendMessage,
  copyMeAddress,
  plainToParagraphs,
  smsCount,
  BODY_MAX,
  SMS_TOTAL_MAX,
  SUBJECT_MAX,
} from "@/lib/send-review";

describe("checkSendMessage", () => {
  it("passes nothing and absent fields through as nothing", () => {
    expect(checkSendMessage(undefined, "email", 0)).toEqual({ ok: true, message: {} });
    expect(checkSendMessage({}, "sms", 30)).toEqual({ ok: true, message: {} });
  });

  it("trims every field", () => {
    const r = checkSendMessage({ to: "  dana@larkspur.example ", subject: " Hello ", body: "\n Hi there \n", copyMe: true }, "email", 0);
    expect(r).toEqual({ ok: true, message: { to: "dana@larkspur.example", subject: "Hello", body: "Hi there", copyMe: true } });
  });

  it.each([
    ["not an address", "dana"],
    ["two addresses", "a@x.example, b@y.example"],
    ["a semicolon list", "a@x.example;b@y.example"],
    ["a space inside", "a b@x.example"],
    ["no dot in the domain", "dana@larkspur"],
    ["blank", "   "],
  ])("refuses an email 'to' with %s", (_n, to) => {
    expect(checkSendMessage({ to }, "email", 0)).toEqual({ ok: false, why: "to" });
  });

  it("takes a US phone for a text and normalizes it", () => {
    expect(checkSendMessage({ to: "(530) 555-0133" }, "sms", 0)).toEqual({ ok: true, message: { to: "+15305550133" } });
    expect(checkSendMessage({ to: "1-530-555-0133" }, "sms", 0)).toEqual({ ok: true, message: { to: "+15305550133" } });
  });

  it.each(["555-0133", "dana@larkspur.example", "", "12345678901234567"])("refuses a text 'to' of %j", (to) => {
    expect(checkSendMessage({ to }, "sms", 0)).toEqual({ ok: false, why: "to" });
  });

  it("bounds the subject and refuses a line break in it", () => {
    expect(checkSendMessage({ subject: "a".repeat(SUBJECT_MAX) }, "email", 0).ok).toBe(true);
    expect(checkSendMessage({ subject: "a".repeat(SUBJECT_MAX + 1) }, "email", 0)).toEqual({ ok: false, why: "subject" });
    expect(checkSendMessage({ subject: "Hi\r\nBcc: x@y.example" }, "email", 0)).toEqual({ ok: false, why: "subject" });
    expect(checkSendMessage({ subject: "  " }, "email", 0)).toEqual({ ok: false, why: "subject" });
  });

  it("bounds an email body and refuses an emptied one", () => {
    expect(checkSendMessage({ body: "a".repeat(BODY_MAX) }, "email", 0).ok).toBe(true);
    expect(checkSendMessage({ body: "a".repeat(BODY_MAX + 1) }, "email", 0)).toEqual({ ok: false, why: "body" });
    expect(checkSendMessage({ body: " \n " }, "email", 0)).toEqual({ ok: false, why: "body" });
  });

  it("holds a text to 1,600 characters including the space and the fixed tail", () => {
    const tail = 40;
    const room = SMS_TOTAL_MAX - 1 - tail;
    expect(checkSendMessage({ body: "a".repeat(room) }, "sms", tail).ok).toBe(true);
    expect(checkSendMessage({ body: "a".repeat(room + 1) }, "sms", tail)).toEqual({ ok: false, why: "length" });
  });

  it("copyMe is only ever true or false", () => {
    expect(checkSendMessage({ copyMe: false }, "email", 0)).toEqual({ ok: true, message: { copyMe: false } });
  });
});

describe("smsCount", () => {
  it("counts the body, a space and the tail; at least one text", () => {
    expect(smsCount("", 0)).toEqual({ chars: 1, texts: 1 });
    expect(smsCount("a".repeat(100), 59)).toEqual({ chars: 160, texts: 1 });
    expect(smsCount("a".repeat(100), 60)).toEqual({ chars: 161, texts: 2 });
    expect(smsCount("a".repeat(1000), 99)).toEqual({ chars: 1100, texts: 7 });
  });
});

describe("copyMeAddress", () => {
  it("is the sender's own, else the company's, else null", () => {
    expect(copyMeAddress("sam@larkspur.example", "office@larkspur.example")).toBe("sam@larkspur.example");
    expect(copyMeAddress(" ", "office@larkspur.example")).toBe("office@larkspur.example");
    expect(copyMeAddress(null, undefined)).toBeNull();
  });
});

describe("plainToParagraphs", () => {
  it("splits on blank lines, trims, drops empties, keeps single newlines", () => {
    expect(plainToParagraphs("Hi Dana,\n\n  Your bill is ready.\nThanks.  \n\n\n\n  \nBye")).toEqual(["Hi Dana,", "Your bill is ready.\nThanks.", "Bye"]);
    expect(plainToParagraphs("   ")).toEqual([]);
  });
});
