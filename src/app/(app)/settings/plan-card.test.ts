import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { doorsIn, textOf } from "@/test/rendered-page";
import type { AccessState } from "@/lib/subscription";

/**
 * THE PLAN CARD, RENDERED (cn-v1140 — one usage meter). Erik's design: no "20 of 40 estimates",
 * no count, no dollar; the plan's name in words, a ring with the percent inside and "Resets Nov 1"
 * under it, plain words, two doors — Upgrade and Add Usage — beside Manage Billing. By role and
 * shell: the owner and an admin get the doors on the web; the App Store app draws none of the three
 * (Apple 3.1.1), keeps Manage Billing and never says "Add usage or upgrade."; a comped company has
 * no Upgrade (/subscribe would bounce it home); a lapsed company has no Add Usage (AI is paused
 * there); the top tier with a live subscription has no Upgrade (nothing above it); an office seat
 * reads who to ask; billing off says so; a degraded meter draws "—" and the fine words with every
 * door standing. Rendered with react-dom/server on the
 * real component, in both languages; the actions are mocked (never run). The page's wiring is
 * pinned at the bottom (a thousand-line server component over Stripe is not the subject).
 */
vi.mock("./billing-actions", () => ({ buyExtraUsage: vi.fn(), openPortal: vi.fn() }));

import { PlanCard, planNameKey, type PlanCardProps } from "./plan-card";

const access = (reason: AccessState["reason"]): Pick<AccessState, "reason" | "active"> => ({
  reason,
  active: reason === "trial" || reason === "comped" || reason === "active" || reason === "grace",
});
const FINE = { pct: 40, state: "fine" as const, resetOn: "2026-11-01", runOutOn: null };

const base: PlanCardProps = {
  lang: "en",
  access: access("active"),
  plan: "crew",
  meter: FINE,
  isAdmin: true,
  inShell: false,
  billingEnabled: true,
  hasCustomer: true,
  liveSubscription: true,
  addUsageOn: true,
  ownerFirst: null,
};
/** The card's markup, without React's own form-replay script (its `$$reactFormReplay` is not a dollar on the card). */
const render = (over: Partial<PlanCardProps> = {}) =>
  renderToStaticMarkup(createElement(PlanCard, { ...base, ...over })).replace(/<script>[\s\S]*?<\/script>/g, "");
const text = (html: string) => textOf(html).trim();
const planName = (html: string) => /data-plan-name="[^"]*">([^<]*)</.exec(html)?.[1];

describe("the plan's name, in words, by the one access rule's reason", () => {
  it.each([
    ["active", "crew", "Crew"],
    ["active", "handyman", "Handyman"],
    ["active", "company", "Company"],
    ["grace", "company", "Company"],
    ["active", "pro-legacy", "Subscribed"],
    ["trial", "handyman", "Free Trial"],
    ["comped", "crew", "Comped"],
    ["trial_ended", "crew", "No Plan"],
    ["grace_spent", "crew", "No Plan"],
    ["canceled", "crew", "No Plan"],
    ["unknown", null, "No Plan"],
  ] as const)("%s on plan %s reads %s", (reason, plan, name) => {
    expect(planName(render({ access: access(reason), plan }))).toBe(name);
  });
  it("never the raw status, never the plan column as a code", () => {
    const html = render({ access: access("active"), plan: "crew" });
    expect(html).not.toMatch(/\bactive\b/);
    expect(html).not.toContain(">crew<");
    expect(html).not.toContain("Plan: ");
    expect(planNameKey(access("active"), "crew")).toBe("us_plan_crew");
  });
});

describe("the ring and its words", () => {
  it("the ring is a meter at the percent with the state's color; Usage, then the reset line", () => {
    const html = render();
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain('data-state="fine"');
    expect(html).toContain(">40%</text>");
    const t = text(html);
    expect(t).toContain("Usage Resets Nov 1.");
    // The order: name, then the ring, then the words, then the doors.
    expect(html.indexOf("data-plan-name")).toBeLessThan(html.indexOf('role="meter"'));
    expect(html.indexOf('role="meter"')).toBeLessThan(html.indexOf(">Usage<"));
    expect(html.indexOf(">Usage<")).toBeLessThan(html.indexOf(">Upgrade<"));
  });
  it("the forecast and the trial's last day when there are any; the standing line when the page hands one", () => {
    const html = render({
      access: access("trial"),
      plan: null,
      meter: { pct: 62, state: "watch", resetOn: "2026-11-01", runOutOn: "2026-10-27", trialEndsOn: "2026-11-05" },
      liveSubscription: false,
      hasCustomer: false,
    });
    expect(html).toContain('data-state="watch"');
    const t = text(html);
    expect(t).toContain("At this pace you'll run out around Oct 27. Resets Nov 1.");
    expect(t).toContain("Your trial ends Nov 5.");
    expect(text(render({ access: access("grace"), stateLine: "Grace: 3 Days Left" }))).toContain("Grace: 3 Days Left");
    expect(text(render({ stateLine: null }))).not.toContain("Grace");
  });
  it("out: the red ring at 100% and the used-up line", () => {
    const html = render({ meter: { pct: 100, state: "out", resetOn: "2026-11-01", runOutOn: null } });
    expect(html).toContain('data-state="out"');
    expect(text(html)).toContain("Used up for this month — Nort and the estimator run lighter until Nov 1. Add usage or upgrade.");
  });
  it("never a count, never a dollar: no 'of 40', no '$', no estimates as a unit, in any state", () => {
    for (const state of ["fine", "watch", "almost", "out"] as const) {
      for (const reason of ["trial", "active", "comped", "trial_ended"] as const) {
        const html = render({ access: access(reason), meter: { pct: 73, state, resetOn: "2026-11-01", runOutOn: state === "out" ? null : "2026-10-29" } });
        expect(html).not.toContain("$");
        expect(html).not.toMatch(/\bof \d+/);
        expect(html).not.toMatch(/estimates?\b/i);
        expect(html).not.toMatch(/token|credit/i);
      }
    }
  });
  it("a degraded meter draws — inside the ring (no confident 0%, no aria-valuenow) with the fine words, and no door hides", () => {
    const html = render({ meter: { pct: 0, state: "fine", resetOn: "2026-11-01", runOutOn: null, degraded: true } });
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain(">—</text>");
    expect(html).not.toContain(">0%</text>");
    expect(html).toContain("data-degraded");
    expect(text(html)).toContain("Usage Resets Nov 1.");
    expect(doorsIn(html)).toEqual(["Upgrade", "Add Usage", "Manage Billing"]);
    // A real 0% (nothing spent yet) is still 0%.
    const zero = render({ meter: { pct: 0, state: "fine", resetOn: "2026-11-01", runOutOn: null, degraded: false } });
    expect(zero).toContain('aria-valuenow="0"');
    expect(zero).toContain(">0%</text>");
  });
  it("the forecast is drawn from 50% up only: a new trial at 10% on day 1 has a run-out day and no forecast line", () => {
    const html = render({ access: access("trial"), plan: null, liveSubscription: false, meter: { pct: 10, state: "fine", resetOn: "2026-11-01", runOutOn: "2026-10-11" } });
    expect(text(html)).not.toContain("At this pace");
    expect(text(html)).toContain("Usage Resets Nov 1.");
  });
});

describe("the doors, by role, shell and standing", () => {
  it("the owner on the web, a live subscription: Upgrade (the portal), Add Usage, Manage Billing — in that order", () => {
    const html = render();
    expect(doorsIn(html)).toEqual(["Upgrade", "Add Usage", "Manage Billing"]);
    // Upgrade is a form (the portal switches the plan), not a link to /subscribe.
    expect(html).not.toContain('href="/subscribe"');
    expect(html).not.toContain("Subscribe");
  });
  it("a trial, or a company with no live subscription: Upgrade is a link to /subscribe (Pick A Plan)", () => {
    const trial = render({ access: access("trial"), liveSubscription: false, hasCustomer: false });
    expect(trial).toMatch(/<a href="\/subscribe"[^>]*>Upgrade<\/a>/);
    expect(doorsIn(trial)).toEqual(["Upgrade", "Add Usage"]);
    const canceled = render({ access: access("canceled"), liveSubscription: false, hasCustomer: true });
    expect(canceled).toMatch(/<a href="\/subscribe"[^>]*>Upgrade<\/a>/);
    expect(doorsIn(canceled)).toEqual(["Upgrade", "Manage Billing"]); // lapsed: no Add Usage (below)
  });
  it("a LAPSED company has no Add Usage — AI is paused there and $15 buys nothing — only Upgrade (and Manage Billing when Stripe knows it)", () => {
    for (const reason of ["trial_ended", "grace_spent", "canceled", "unknown"] as const) {
      const html = render({ access: access(reason), liveSubscription: false, hasCustomer: true });
      expect(doorsIn(html), reason).toEqual(["Upgrade", "Manage Billing"]);
      expect(doorsIn(render({ access: access(reason), liveSubscription: false, hasCustomer: false })), reason).toEqual(["Upgrade"]);
    }
    // Grace still has access: Add Usage stands beside Upgrade (the portal) and Manage Billing.
    expect(doorsIn(render({ access: access("grace") }))).toEqual(["Upgrade", "Add Usage", "Manage Billing"]);
  });
  it("a COMPED company has no Upgrade (/subscribe would bounce it home — a dead door): Add Usage and Manage Billing only", () => {
    const html = render({ access: access("comped"), plan: null, liveSubscription: false, hasCustomer: true });
    expect(doorsIn(html)).toEqual(["Add Usage", "Manage Billing"]);
    expect(html).not.toContain("/subscribe");
    expect(html).not.toContain("Upgrade");
    expect(doorsIn(render({ access: access("comped"), plan: "crew", liveSubscription: true, hasCustomer: true }))).toEqual(["Add Usage", "Manage Billing"]);
    expect(doorsIn(render({ access: access("comped"), plan: null, liveSubscription: false, hasCustomer: false }))).toEqual(["Add Usage"]);
  });
  it("the top tier (Company) with a live subscription has nothing above it: no Upgrade; Add Usage and Manage Billing stay", () => {
    const html = render({ access: access("active"), plan: "company", liveSubscription: true, hasCustomer: true });
    expect(doorsIn(html)).toEqual(["Add Usage", "Manage Billing"]);
    expect(html).not.toContain("Upgrade");
    // Crew with a live subscription still upgrades (the portal); Company on the books with NO live
    // subscription still gets Upgrade — it is the way to a plan at all.
    expect(doorsIn(render({ access: access("active"), plan: "crew", liveSubscription: true }))).toEqual(["Upgrade", "Add Usage", "Manage Billing"]);
    expect(doorsIn(render({ access: access("active"), plan: "company", liveSubscription: false }))).toEqual(["Upgrade", "Add Usage", "Manage Billing"]);
  });
  it("an admin gets the owner's doors", () => {
    expect(doorsIn(render({ isAdmin: true }))).toEqual(["Upgrade", "Add Usage", "Manage Billing"]);
  });
  it("Add Usage stands only when the install sells it", () => {
    expect(doorsIn(render({ addUsageOn: false }))).toEqual(["Upgrade", "Manage Billing"]);
  });
  it("Manage Billing stands only when Stripe knows the customer", () => {
    expect(doorsIn(render({ hasCustomer: false, liveSubscription: false }))).toEqual(["Upgrade", "Add Usage"]);
  });
  it("the App Store app: the ring and the words, Manage Billing alone — no Subscribe, Upgrade or Add Usage", () => {
    const html = render({ inShell: true });
    expect(html).toContain('role="meter"');
    expect(text(html)).toContain("Usage Resets Nov 1.");
    expect(doorsIn(html)).toEqual(["Manage Billing"]);
    expect(html).not.toContain("Upgrade");
    expect(html).not.toContain("Add Usage");
    expect(html).not.toContain("Subscribe");
    expect(html).not.toContain("/subscribe");
    // No customer yet: no doors at all, and no empty row for them.
    const bare = render({ inShell: true, hasCustomer: false, liveSubscription: false });
    expect(doorsIn(bare)).toEqual([]);
    expect(bare).not.toContain("mt-4 flex flex-wrap gap-2");
  });
  it("the App Store app, used up: the line says the lighter model and the reset day, and never \"Add usage or upgrade.\" (no purchase door there)", () => {
    const out = { pct: 100, state: "out" as const, resetOn: "2026-11-01", runOutOn: null };
    const shell = render({ inShell: true, meter: out });
    expect(text(shell)).toContain("Used up for this month — Nort and the estimator run lighter until Nov 1.");
    expect(text(shell)).not.toContain("Add usage or upgrade");
    expect(text(render({ inShell: true, lang: "es", meter: out }))).toContain("Se acabó por este mes: Nort y el estimador corren más ligeros hasta el 1 nov.");
    expect(text(render({ inShell: true, lang: "es", meter: out }))).not.toContain("Agrega uso");
    // On the web the tail stands.
    expect(text(render({ inShell: false, meter: out }))).toContain("Add usage or upgrade.");
  });
  it("an office seat: the ring, the words, and who to ask by first name — no door", () => {
    const html = render({ isAdmin: false, ownerFirst: "Larkspur" });
    expect(html).toContain('role="meter"');
    expect(text(html)).toContain("Ask Larkspur to change the plan.");
    expect(doorsIn(html)).toEqual([]);
    expect(html).not.toContain("Upgrade");
    expect(text(render({ isAdmin: false, ownerFirst: null }))).toContain("Ask the owner to change the plan.");
  });
  it("billing off: the ring and the words, and the one line", () => {
    const html = render({ billingEnabled: false });
    expect(html).toContain('role="meter"');
    expect(text(html)).toContain("Billing isn't turned on yet.");
    expect(doorsIn(html)).toEqual([]);
  });
});

describe("what the URL carries back", () => {
  it("?usage=added: the one line (the webhook lands the top-up; the card only reads)", () => {
    expect(text(render({ notice: { usage: "added" } }))).toContain("Added — it shows on the ring within a minute.");
    expect(text(render())).not.toContain("Added —");
  });
  it("?billing=success and a billing_error, as before", () => {
    expect(text(render({ notice: { billing: "success" } }))).toContain("Subscription active — thank you!");
    expect(text(render({ notice: { billingError: "Extra usage isn't for sale yet." } }))).toContain("Extra usage isn't for sale yet.");
  });
});

describe("in Spanish", () => {
  it("Uso, the line, the doors (Mejorar Plan, Agregar Uso, Administrar Facturación) and the plan's name", () => {
    const html = render({ lang: "es", access: access("trial"), liveSubscription: false, meter: { ...FINE, trialEndsOn: "2026-11-05" } });
    const t = text(html);
    expect(t).toContain("Prueba Gratis");
    expect(t).toContain("Uso Se reinicia el 1 nov.");
    expect(t).toContain("Tu prueba termina el 5 nov.");
    expect(html).toContain('aria-label="Uso: 40% de este mes"');
    expect(doorsIn(html)).toEqual(["Mejorar Plan", "Agregar Uso", "Administrar Facturación"]);
    expect(html).not.toContain("Usage");
    expect(html).not.toContain("Upgrade");
  });
  it("the office's line and the lines the URL carries back", () => {
    expect(text(render({ lang: "es", isAdmin: false, ownerFirst: "Larkspur" }))).toContain("Pídele a Larkspur que cambie el plan.");
    expect(text(render({ lang: "es", isAdmin: false, ownerFirst: null }))).toContain("Pídele al dueño que cambie el plan."); // a whole sentence: "a el" contracts
    expect(text(render({ lang: "es", isAdmin: false, ownerFirst: "" }))).toContain("Pídele al dueño que cambie el plan.");
    expect(text(render({ lang: "es", notice: { usage: "added" } }))).toContain("Agregado: se verá en el anillo en un minuto.");
    expect(text(render({ lang: "es", billingEnabled: false }))).toContain("La facturación aún no está activada.");
    expect(planName(render({ lang: "es", access: access("active"), plan: "crew" }))).toBe("Crew");
    expect(planName(render({ lang: "es", access: access("canceled") }))).toBe("Sin Plan");
  });
});

describe("the page's wiring (settings/page.tsx)", () => {
  const page = readFileSync("src/app/(app)/settings/page.tsx", "utf8");
  it("the meter is read on the row the page already holds — select(\"*\") carries USAGE_ORG_COLUMNS — and the shell off the request", () => {
    expect(page).toContain('supabase.from("organizations").select("*").eq("id", profile.org_id).maybeSingle()');
    expect(page).toContain('import { usageFor, type UsageOrg } from "@/lib/usage-meter";');
    expect(page).toContain("const meter = await usageFor(profile?.org_id, (org as UsageOrg | null) ?? undefined);");
    expect(page).toContain('import { headers } from "next/headers";');
    expect(page).toContain('const inShell = shellFromUserAgent((await headers()).get("user-agent")).native;');
  });
  it("the card is plan-card.tsx under the Section, with the one access rule's answer, in the person's language", () => {
    expect(page).toContain('import { PlanCard } from "./plan-card";');
    expect(page).toContain('<Section title={t("us_cardTitle")}>');
    expect(page).toContain("const access = accessState(o as BillingOrg, { tz: settings.timezone });");
    expect(page).toContain("lang={asLang(profile?.language)}");
    expect(page).toContain("inShell={inShell}");
    expect(page).toContain("liveSubscription={stripeSubscriptionLive(o)}");
    expect(page).toContain("addUsageOn={extraUsageConfigured()}");
    expect(page).toContain("notice={{ billing, usage, billingError: billing_error }}");
    // The old card is gone: no raw status badge, no "Plan: {o.plan}", no Subscribe form.
    expect(page).not.toContain("{o.subscription_status}");
    expect(page).not.toContain("Plan: {o.plan}");
    expect(page).not.toContain("<FormSubmit>Subscribe</FormSubmit>");
    expect(page).not.toContain("startCheckout");
  });
  it("the one owner read (lib/lapse-words), only for someone who cannot pick a plan and only with billing on (skeptic #43, S12)", () => {
    expect(page).toContain('import { ownerFirstName } from "@/lib/lapse-words";');
    // Null when there is no name: the card's own sentence in the person's language, never an English "the owner" in a Spanish slot.
    expect(page).toContain("const planOwnerFirst = !isAdmin && billingEnabled ? await ownerFirstName(profile?.org_id) : null;");
    expect(page).not.toContain('?? "the owner") : null');
    expect(page).toContain("ownerFirst={planOwnerFirst}");
    expect(page).not.toContain('.eq("role", "owner")');
  });
});
