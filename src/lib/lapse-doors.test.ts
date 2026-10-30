import { describe, it, expect, afterEach, vi } from "vitest";
import {
  LAPSED_OPEN_DOORS,
  PATHNAME_HEADER,
  SEARCH_HEADER,
  NO_BILLING_ACCOUNT_REFUSAL,
  SECOND_SUBSCRIPTION_REFUSAL,
  canPickPlan,
  lapsedDoorOpen,
  lapseBarWords,
  lapseWall,
  planStateLine,
  stripeSubscriptionLive,
  subscribeHeadline,
  subscribeHref,
} from "@/lib/lapse-doors";
import { accessState, type AccessState } from "@/lib/subscription";

/**
 * THE DOORS A LAPSED COMPANY KEEPS (cn-v1137): pure rules, tested without a request. The owner or
 * an admin may still open Settings, /subscribe and the accountant's export; everyone else and every
 * other path meets the wall; a missing path is the wall.
 */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 18, 0, 0); // 2026-10-28 18:00Z
const state = (reason: AccessState["reason"], extra: Partial<AccessState> = {}): AccessState => ({
  active: reason === "comped" || reason === "active" || reason === "trial" || reason === "grace",
  reason,
  daysLeft: null,
  compedBy: null,
  ...extra,
});

describe("the open doors", () => {
  it("are exactly these three, and the two header names are pinned", () => {
    expect([...LAPSED_OPEN_DOORS]).toEqual(["/subscribe", "/settings", "/analytics/accountant"]);
    expect(PATHNAME_HEADER).toBe("x-cn-pathname");
    expect(SEARCH_HEADER).toBe("x-cn-search");
  });

  it("owner and admin can pick a plan; office and tech cannot", () => {
    expect(canPickPlan("owner")).toBe(true);
    expect(canPickPlan("admin")).toBe(true);
    expect(canPickPlan("office")).toBe(false);
    expect(canPickPlan("tech")).toBe(false);
    expect(canPickPlan(null)).toBe(false);
    expect(canPickPlan(undefined)).toBe(false);
  });

  it.each([
    ["/settings", true],
    ["/settings/", true],
    ["/settings/anything/deeper", true],
    ["/subscribe", true],
    ["/analytics/accountant", true],
    ["/analytics/accountant/export", true],
    ["/settingsx", false],
    ["/settings-old", false],
    ["/analytics", false],
    ["/analytics/accountants", false],
    ["/jobs", false],
    ["/", false],
    ["", false],
  ])("owner on %s → %s", (path, open) => {
    expect(lapsedDoorOpen(path, "owner")).toBe(open);
  });

  it("an admin opens the same doors; office and tech open none", () => {
    expect(lapsedDoorOpen("/settings", "admin")).toBe(true);
    expect(lapsedDoorOpen("/analytics/accountant", "admin")).toBe(true);
    expect(lapsedDoorOpen("/settings", "office")).toBe(false);
    expect(lapsedDoorOpen("/settings", "tech")).toBe(false);
    expect(lapsedDoorOpen("/subscribe", "tech")).toBe(false);
    expect(lapsedDoorOpen("/settings", null)).toBe(false);
  });

  it("no pathname (the header never came) is never an open door", () => {
    expect(lapsedDoorOpen(null, "owner")).toBe(false);
    expect(lapsedDoorOpen(undefined, "owner")).toBe(false);
  });
});

describe("the words", () => {
  const tail = " Nort, texts and reminders are paused. Your customers can still pay you.";
  it.each([
    ["trial_ended", "Your free trial has ended."],
    ["grace_spent", "Your card was not updated in time."],
    ["canceled", "Your plan has ended."],
    ["unknown", "Your plan has ended."],
  ] as const)("the red bar for %s", (reason, what) => {
    expect(lapseBarWords(state(reason))).toBe(what + tail);
  });

  it.each([
    ["trial_ended", "Your Free Trial Has Ended"],
    ["grace_spent", "Your Card Was Declined"],
    ["canceled", "Your Subscription Has Ended"],
    ["unknown", "Your Plan Needs Attention"],
    ["active", "Your Plan Needs Attention"],
  ] as const)("/subscribe's headline for %s", (reason, words) => {
    expect(subscribeHeadline(reason)).toBe(words);
  });

  it("each refusal names ONE action", () => {
    expect(SECOND_SUBSCRIPTION_REFUSAL).toBe("A subscription already exists — use Manage Billing.");
    expect(NO_BILLING_ACCOUNT_REFUSAL).toBe("There's no billing account yet — Upgrade first."); // the plan card's door word (cn-v1140)
  });
});

describe("subscribeHref carries only billing_error", () => {
  it("no query, an empty query, or a query without it → /subscribe", () => {
    expect(subscribeHref(null)).toBe("/subscribe");
    expect(subscribeHref(undefined)).toBe("/subscribe");
    expect(subscribeHref("")).toBe("/subscribe");
    expect(subscribeHref("?tab=getpaid&billing=cancelled")).toBe("/subscribe");
    expect(subscribeHref("?billing_error=")).toBe("/subscribe");
    expect(subscribeHref("?billing_error=%20%20")).toBe("/subscribe");
  });
  it("a billing_error rides through, re-encoded, alone", () => {
    expect(subscribeHref("?tab=getpaid&billing_error=Card%20declined")).toBe("/subscribe?billing_error=Card%20declined");
    expect(subscribeHref("billing_error=A%20subscription%20already%20exists")).toBe(
      "/subscribe?billing_error=A%20subscription%20already%20exists",
    );
    expect(subscribeHref("?billing_error=a%26b%3Dc")).toBe("/subscribe?billing_error=a%26b%3Dc");
  });
  it("a long error is cut at 300 characters", () => {
    const long = "x".repeat(400);
    expect(subscribeHref(`?billing_error=${long}`)).toBe(`/subscribe?billing_error=${"x".repeat(300)}`);
  });
});

describe("lapseWall", () => {
  it("a standing company: open, whatever the door", () => {
    expect(lapseWall({ state: state("active"), role: "tech", pathname: "/jobs" })).toEqual({ kind: "open" });
    expect(lapseWall({ state: state("trial", { daysLeft: 3 }), role: "tech", pathname: null })).toEqual({ kind: "open" });
    expect(lapseWall({ state: state("grace", { daysLeft: 2 }), role: "owner", pathname: "/jobs" })).toEqual({ kind: "open" });
  });
  it("lapsed: the bar on an open door for an owner, the wall everywhere else", () => {
    expect(lapseWall({ state: state("trial_ended"), role: "owner", pathname: "/settings" })).toEqual({
      kind: "bar",
      words: lapseBarWords(state("trial_ended")),
    });
    expect(lapseWall({ state: state("trial_ended"), role: "owner", pathname: "/jobs" })).toEqual({ kind: "redirect", to: "/subscribe" });
    expect(lapseWall({ state: state("trial_ended"), role: "tech", pathname: "/settings" })).toEqual({ kind: "redirect", to: "/subscribe" });
    expect(lapseWall({ state: state("trial_ended"), role: "owner", pathname: null })).toEqual({ kind: "redirect", to: "/subscribe" });
  });
  it("the redirect carries a billing_error", () => {
    expect(lapseWall({ state: state("canceled"), role: "owner", pathname: "/jobs", search: "?billing_error=Card%20declined" })).toEqual({
      kind: "redirect",
      to: "/subscribe?billing_error=Card%20declined",
    });
  });
});

describe("stripeSubscriptionLive — the one rule behind Manage Billing vs Checkout", () => {
  it("live = an id AND a status Stripe can still bill or revive (skeptic #43, S13); anything else is Checkout again", () => {
    for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) {
      expect(stripeSubscriptionLive({ stripe_subscription_id: "sub_1", subscription_status: status }), status).toBe(true);
    }
    // Stripe will never bill these again: the portal cannot restart them, so Checkout on the same customer.
    expect(stripeSubscriptionLive({ stripe_subscription_id: "sub_1", subscription_status: "canceled" })).toBe(false);
    expect(stripeSubscriptionLive({ stripe_subscription_id: "sub_1", subscription_status: "incomplete_expired" })).toBe(false);
    // A status nothing recognises, or none, is not a live subscription — the old rule read "not canceled" as live.
    expect(stripeSubscriptionLive({ stripe_subscription_id: "sub_1", subscription_status: null })).toBe(false);
    expect(stripeSubscriptionLive({ stripe_subscription_id: "sub_1", subscription_status: "something_new" })).toBe(false);
    expect(stripeSubscriptionLive({ stripe_subscription_id: "sub_1" })).toBe(false);
    expect(stripeSubscriptionLive({ stripe_subscription_id: null, subscription_status: "active" })).toBe(false);
    expect(stripeSubscriptionLive({})).toBe(false);
  });
});

describe("planStateLine — the one line on Settings", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("the trial, in days (the company's own calendar when tz is given)", () => {
    expect(planStateLine(state("trial", { daysLeft: 5 }))).toBe("Trial Ends In 5 Days");
    expect(planStateLine(state("trial", { daysLeft: 1 }))).toBe("Trial Ends In 1 Day");
    expect(planStateLine(state("trial", { daysLeft: 0 }))).toBe("Trial Ends Today");
    expect(planStateLine(state("trial", { daysLeft: null }))).toBeNull();
    const org = { subscription_status: "trialing", trial_ends_at: new Date(NOW + 5 * DAY).toISOString() };
    expect(planStateLine(accessState(org, { nowMs: NOW, tz: "America/Los_Angeles" }))).toBe("Trial Ends In 5 Days");
  });
  it("grace, in days", () => {
    expect(planStateLine(state("grace", { daysLeft: 3 }))).toBe("Grace: 3 Days Left");
    expect(planStateLine(state("grace", { daysLeft: 1 }))).toBe("Grace: 1 Day Left");
  });
  it("comped: until the column's date in the company's zone; the env list has no date", () => {
    const until = "2026-11-30T12:00:00Z";
    const s = accessState({ comped_until: until }, { nowMs: NOW });
    expect(s.compedBy).toBe("column");
    expect(planStateLine(s, { compedUntil: until, tz: "America/Los_Angeles" })).toBe("Comped Until Nov 30, 2026");
    expect(planStateLine(s, { compedUntil: "not a date", tz: "America/Los_Angeles" })).toBe("Comped");
    vi.stubEnv("COMPED_ORG_IDS", "org-env");
    const env = accessState({ id: "org-env" }, { nowMs: NOW });
    expect(env.compedBy).toBe("env");
    expect(planStateLine(env, { compedUntil: null })).toBe("Comped");
  });
  it("nothing for a plain active plan, nothing for a lapsed one", () => {
    expect(planStateLine(state("active"))).toBeNull();
    expect(planStateLine(state("trial_ended"))).toBeNull();
    expect(planStateLine(state("grace_spent"))).toBeNull();
    expect(planStateLine(state("canceled"))).toBeNull();
    expect(planStateLine(state("unknown"))).toBeNull();
  });
});
