import { describe, it, expect } from "vitest";
import {
  CARD_FEE_MAX_PCT,
  CARD_FEE_READY,
  cardFeeAmount,
  cardFeeDecision,
  feePctLabel,
  getOrgSettings,
  parseGeoFromMapUrl,
  parsePayMethod,
  payUrl,
} from "@/lib/org-settings";

/**
 * timeclock_job_codes (owner: "I don't want job code…") — the default MUST reproduce
 * today's behavior byte-identically: an org that never touched the setting keeps the
 * code pickers everywhere. Only an explicit false turns them off.
 */
describe("timeclock_job_codes default", () => {
  it("defaults ON for orgs that never saved the setting (today's behavior)", () => {
    expect(getOrgSettings(undefined).timeclock_job_codes).toBe(true);
    expect(getOrgSettings(null).timeclock_job_codes).toBe(true);
    expect(getOrgSettings({}).timeclock_job_codes).toBe(true);
    // a stored-but-retired key (auto_lunch_30 era) must not disturb defaults
    expect(getOrgSettings({ auto_lunch_30: true } as Record<string, unknown>).timeclock_job_codes).toBe(true);
  });

  it("honors an explicit stored choice", () => {
    expect(getOrgSettings({ timeclock_job_codes: false }).timeclock_job_codes).toBe(false);
    expect(getOrgSettings({ timeclock_job_codes: true }).timeclock_job_codes).toBe(true);
  });
});

describe("parseGeoFromMapUrl — geo from a pasted Google Maps link", () => {
  it("prefers the place marker (!3d/!4d) — the actual business pin", () => {
    // Tahoe Deck's real GBP link: viewport @39.36494,-120.872 but the pin is !3d39.3657!4d-120.2128
    const url =
      "https://www.google.com/maps/place/Tahoe+Deck/@39.36494,-120.8721941,9z/data=!4m6!3m5!1s0x6388e5d9d7bd993d:0xdff3dd665d9ac349!8m2!3d39.3657384!4d-120.212828!16s%2Fg%2F11vwz3kfh_";
    expect(parseGeoFromMapUrl(url)).toEqual({ lat: 39.3657384, lng: -120.212828 });
  });

  it("falls back to the @viewport center when there's no marker", () => {
    expect(parseGeoFromMapUrl("https://maps.google.com/@39.328,-120.183,14z")).toEqual({ lat: 39.328, lng: -120.183 });
  });

  it("returns null for a link with no coordinates (bare ?cid=)", () => {
    expect(parseGeoFromMapUrl("https://www.google.com/maps?cid=16137485321525445449")).toBeNull();
  });

  it("returns null for empty/garbage input", () => {
    expect(parseGeoFromMapUrl("")).toBeNull();
    expect(parseGeoFromMapUrl(null)).toBeNull();
    expect(parseGeoFromMapUrl("not a url")).toBeNull();
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseGeoFromMapUrl("@200,-400,10z")).toBeNull();
  });
});

/**
 * A BAD TIMEZONE IS A CROSS-TENANT KILL SWITCH (audit 6). The nightly engines loop every org in
 * one request and format each org's "today" in its own zone; one unparseable value throws inside
 * the loop and every org AFTER it silently gets no invoices and no reminders.
 */
describe("getOrgSettings — the timezone can never be unparseable", () => {
  const tz = (v: unknown) => getOrgSettings({ timezone: v }).timezone;

  it("keeps a real IANA zone", () => {
    expect(tz("America/New_York")).toBe("America/New_York");
    expect(tz("Europe/London")).toBe("Europe/London");
    expect(tz("America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  it.each([["", "empty"], ["   ", "whitespace"], ["Mars/Olympus", "not a zone"], ["not a timezone", "prose"]])(
    "falls back for %s (%s)", (bad) => {
      expect(tz(bad)).toBe("America/Los_Angeles");
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz(bad) })).not.toThrow();
    });

  it.each([[null], [undefined], [123], [{}], [[]], [true]])("falls back for the non-string %s", (bad) => {
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz(bad) })).not.toThrow();
  });

  it("a poisoned row READS clean, so an already-broken tenant is healed without a migration", () => {
    const poisoned = { timezone: "", currency: "USD" };
    expect(getOrgSettings(poisoned).timezone).toBe("America/Los_Angeles");
  });
});

/**
 * THE PAY DOORS AND THE CARD FEE (2026-09-20).
 *
 * Money and URLs only — the parts that decide what a customer is charged and which door they
 * land on. The Stripe call itself is not testable here and isn't the risk; the risk is the app
 * printing one number on a button and charging another, or an old emailed link changing meaning.
 */

describe("parsePayMethod — the default has to be the link that is already in people's inboxes", () => {
  it("is card when nothing was asked for", () => {
    expect(parsePayMethod(null)).toBe("card");
    expect(parsePayMethod(undefined)).toBe("card");
    expect(parsePayMethod("")).toBe("card");
  });

  it("is bank only for an exact bank, case and whitespace forgiven", () => {
    expect(parsePayMethod("bank")).toBe("bank");
    expect(parsePayMethod("BANK")).toBe("bank");
    expect(parsePayMethod("  Bank  ")).toBe("bank");
  });

  it("falls back to card for anything else, including junk", () => {
    // A typo, a crawler, a hand-edited URL: none of these may change what the link charges.
    for (const junk of ["banks", "ach", "us_bank_account", "card", "1", "<script>", "bank;drop"]) {
      expect(parsePayMethod(junk)).toBe("card");
    }
  });
});

describe("payUrl — the card link must stay byte-identical to the one already emailed", () => {
  it("adds no query at all for card", () => {
    expect(payUrl("abc123", "card")).toBe("/api/pay/abc123");
  });

  it("carries the method for bank", () => {
    expect(payUrl("abc123", "bank")).toBe("/api/pay/abc123?method=bank");
  });

  it("round-trips through parsePayMethod", () => {
    const q = payUrl("tok", "bank").split("?method=")[1];
    expect(parsePayMethod(q)).toBe("bank");
  });

  it("escapes a token rather than letting it write its own query string", () => {
    expect(payUrl("a/b?method=bank", "card")).toBe("/api/pay/a%2Fb%3Fmethod%3Dbank");
  });
});

describe("cardFeeAmount — the surcharge in real cents", () => {
  it("is exactly the percent, rounded to the cent Stripe will charge", () => {
    // 2026-09-20's two real card payments.
    expect(cardFeeAmount(1875.98, 3)).toBe(56.28); // 56.2794 → 56.28
    expect(cardFeeAmount(6068.03, 3)).toBe(182.04); // 182.0409 → 182.04
    expect(cardFeeAmount(100, 2.5)).toBe(2.5);
    expect(cardFeeAmount(0.5, 3)).toBe(0.02); // 0.015 → 0.02
  });

  it("is zero whenever there is nothing to charge a fee on", () => {
    expect(cardFeeAmount(0, 3)).toBe(0);
    expect(cardFeeAmount(-100, 3)).toBe(0);
    expect(cardFeeAmount(100, 0)).toBe(0);
    expect(cardFeeAmount(100, -3)).toBe(0);
  });

  it("never invents a number out of a non-number", () => {
    expect(cardFeeAmount(NaN, 3)).toBe(0);
    expect(cardFeeAmount(Infinity, 3)).toBe(0);
    expect(cardFeeAmount(100, NaN)).toBe(0);
  });

  it("clamps to the network ceiling instead of honoring a typo", () => {
    expect(cardFeeAmount(100, 30)).toBe(cardFeeAmount(100, CARD_FEE_MAX_PCT));
    expect(cardFeeAmount(100, 30)).toBe(3);
  });
});

describe("cardFeeDecision — off by default, and refused out loud when it isn't ready", () => {
  it("changes nothing at all when the setting is 0", () => {
    const d = cardFeeDecision(1875.98, 0);
    expect(d).toEqual({ pct: 0, fee: 0, cardTotal: 1875.98, invoiceAmount: 1875.98, refused: null });
  });

  it("ships shut: the flag is false, so a configured fee is not charged", () => {
    expect(CARD_FEE_READY).toBe(false);
    const d = cardFeeDecision(1875.98, 3);
    expect(d.fee).toBe(0);
    expect(d.cardTotal).toBe(1875.98);
  });

  it("says WHY it refused, in words an operator can act on", () => {
    const d = cardFeeDecision(1875.98, 3);
    expect(d.refused).toBeTruthy();
    expect(d.refused).toContain("card_fee_percent is set to 3");
    // The two blockers have to be nameable from the log line alone.
    expect(d.refused).toContain("webhook");
    expect(d.refused).toContain("public_invoice");
  });

  it("never refuses silently AND charges: a refusal always costs the customer zero extra", () => {
    for (const pct of [0.5, 1, 2.9, 3, 30]) {
      const d = cardFeeDecision(500, pct);
      expect(d.fee).toBe(0);
      expect(d.cardTotal).toBe(500);
    }
  });

  // The `ready` seam exists so the arithmetic that runs the day the flag flips is proven today.
  describe("once the flag flips", () => {
    it("adds the fee on top and leaves the invoice's own amount alone", () => {
      const d = cardFeeDecision(1875.98, 3, true);
      expect(d.pct).toBe(3);
      expect(d.fee).toBe(56.28);
      expect(d.cardTotal).toBe(1932.26);
      // THE MONEY BUG THIS WHOLE THING GUARDS: the invoice is credited its own balance, never the
      // card total. If these two are ever the same number the invoice goes overpaid.
      expect(d.invoiceAmount).toBe(1875.98);
      expect(d.invoiceAmount).not.toBe(d.cardTotal);
      expect(d.refused).toBeNull();
    });

    it("keeps cardTotal = invoiceAmount + fee to the cent", () => {
      for (const b of [0.5, 12.34, 100, 1875.98, 6068.03, 99999.99]) {
        const d = cardFeeDecision(b, 2.9, true);
        expect(Math.round(d.cardTotal * 100)).toBe(Math.round(d.invoiceAmount * 100) + Math.round(d.fee * 100));
      }
    });

    it("still clamps a typo to the ceiling rather than charging 30%", () => {
      const d = cardFeeDecision(100, 30, true);
      expect(d.pct).toBe(CARD_FEE_MAX_PCT);
      expect(d.cardTotal).toBe(103);
    });

    it("has nothing to add to a zero balance", () => {
      const d = cardFeeDecision(0, 3, true);
      expect(d.fee).toBe(0);
      expect(d.cardTotal).toBe(0);
    });
  });
});

describe("feePctLabel — a percent a person would say out loud", () => {
  it("drops the trailing zeros", () => {
    expect(feePctLabel(3)).toBe("3");
    expect(feePctLabel(2.5)).toBe("2.5");
    expect(feePctLabel(2.9)).toBe("2.9");
  });

  it("never prints NaN into customer-facing copy", () => {
    expect(feePctLabel(NaN)).toBe("0");
  });
});

describe("getOrgSettings — the surcharge is sanitized on read, like every other money lever", () => {
  it("defaults to off", () => {
    expect(getOrgSettings({}).card_fee_percent).toBe(0);
    expect(getOrgSettings(null).card_fee_percent).toBe(0);
  });

  it("keeps a sane stored value", () => {
    expect(getOrgSettings({ card_fee_percent: 2.5 }).card_fee_percent).toBe(2.5);
  });

  it("clamps a hand-edited jsonb that would surcharge above the network cap", () => {
    expect(getOrgSettings({ card_fee_percent: 30 }).card_fee_percent).toBe(CARD_FEE_MAX_PCT);
  });

  it("treats garbage as off rather than as a charge", () => {
    for (const bad of ["3", -1, NaN, null, undefined, {}, [], true]) {
      expect(getOrgSettings({ card_fee_percent: bad as never }).card_fee_percent).toBe(0);
    }
  });
});
