import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE JOB'S CUSTOMER TAB WHEN THE LINK IS OFF (cn-v1186, 0419). A customer's page starts off now, so
 * the off link is on nearly every job: the tab says so in a plain slate line, not a red one, and
 * carries the door itself (Turn On) instead of a link away to the contact page. Turn On calls
 * setPortalEnabled(customer, true), says what happened, and reads the link again the way the tab
 * first loads it, so Copy the Link and See What They See come alive. See What They See waits while
 * the link is off, with the same reason Copy gives. The no-link branch is unchanged.
 */
const said = vi.hoisted(() => ({ toasts: [] as { msg: string; tone: string }[] }));
const calls = vi.hoisted(() => ({ setPortalEnabled: vi.fn(), reloads: 0 }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/toast", () => ({ useToast: () => (msg: string, tone: string) => said.toasts.push({ msg, tone }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("../portal-share-actions", () => ({}));
vi.mock("./job-portal-papers", () => ({ PapersCard: () => null }));
vi.mock("./job-portal-panel", () => ({ JobPortalPanel: () => null }));
vi.mock("../../portal-look-actions", () => ({ portalOfficeLookUrl: vi.fn() }));
vi.mock("@/components/portal/open-office-look", () => ({ openOfficeLook: vi.fn() }));
vi.mock("../../crm/actions", () => ({ setPortalEnabled: calls.setPortalEnabled }));
// A press made after the static render runs its transition straight through (there is no DOM here).
vi.mock("react", async (orig) => {
  const real = (await orig()) as typeof import("react");
  return { ...real, useTransition: () => [false, (fn: () => unknown) => void fn()] };
});
/** Every Button the card draws, with the props it was handed, so a press can be made off the page. */
const pressed = vi.hoisted(() => ({ buttons: [] as { label: string; onClick?: () => void; disabled?: boolean }[] }));
vi.mock("@/components/ui/button", async (orig) => {
  const real = (await orig()) as typeof import("@/components/ui/button");
  const { createElement: h, forwardRef } = await import("react");
  const Button = forwardRef<HTMLButtonElement, any>((props, ref) => {
    const label = [props.children].flat().filter((c: unknown) => typeof c === "string").join("").trim();
    pressed.buttons.push({ label, onClick: props.onClick, disabled: props.disabled });
    return h(real.Button, { ...props, ref });
  });
  return { ...real, Button };
});

import { LinkCard } from "./job-customer-page";

const CUSTOMER = "0b6c5f3e-6f0e-4a8e-9a5e-0f6b1c2d3e4f";
const offLink = {
  url: "https://snowbell.example/portal/tok/jobs/j-1",
  enabled: false,
  hasLink: true,
  jobShown: true,
  customerId: CUSTOMER,
  customerName: "Sam Tillery",
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const reload = async () => {
  calls.reloads += 1;
};
function draw(link: typeof offLink) {
  pressed.buttons = [];
  return renderToStaticMarkup(<LinkCard link={link} who="Sam Tillery" jobId="j-1" onTurnedOn={reload} />);
}
const btn = (label: string) => pressed.buttons.find((b) => b.label === label);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  said.toasts = [];
  calls.reloads = 0;
  calls.setPortalEnabled.mockReset();
});

describe("an off link on the job's Customer tab", () => {
  it("a neutral slate line and Turn On; the red sentence and the link away are gone; See and Copy wait", () => {
    const html = draw(offLink);
    expect(text(html)).toContain("Sam Tillery's page is off, so nothing here shows to them yet. Turn it on when they need it.");
    expect(html).toContain('<p class="text-sm text-slate-700">Sam Tillery&#x27;s page is off');
    expect(html).not.toContain("text-red-700");
    expect(html).not.toContain("Turn It On from Their Contact Page");
    expect(html).not.toContain(`href="/crm/${CUSTOMER}"`);
    expect(btn("Turn On")?.disabled).toBe(false);
    expect(btn("See What They See")?.disabled).toBe(true);
    expect(btn("Copy the Link")?.disabled).toBe(true);
    expect(html.match(/title="Turn the link on first"/g)?.length).toBe(2);
  });

  it("Turn On calls setPortalEnabled(customer, true), says it, and reads the link again", async () => {
    calls.setPortalEnabled.mockResolvedValue({ ok: true, link: { token: "tok", enabled: true, lastOpenedAt: null, devices: 0 } });
    draw(offLink);
    btn("Turn On")!.onClick!();
    await settle();
    expect(calls.setPortalEnabled).toHaveBeenCalledWith(CUSTOMER, true);
    expect(said.toasts).toEqual([{ msg: "Turned on. Their link works; each device asks for a code from their email.", tone: "success" }]);
    expect(calls.reloads).toBe(1);
  });

  it("a refusal is said and nothing is read again", async () => {
    calls.setPortalEnabled.mockResolvedValue({ ok: false, error: "Only the office can do that." });
    draw(offLink);
    btn("Turn On")!.onClick!();
    await settle();
    expect(said.toasts).toEqual([{ msg: "Only the office can do that.", tone: "error" }]);
    expect(calls.reloads).toBe(0);
  });

  it("on, there is no Turn On and See and Copy are live", () => {
    const html = draw({ ...offLink, enabled: true });
    expect(btn("Turn On")).toBeUndefined();
    expect(btn("See What They See")?.disabled).toBe(false);
    expect(btn("Copy the Link")?.disabled).toBe(false);
    expect(text(html)).not.toContain("page is off");
  });

  it("no link at all keeps its own line and the door to the contact page", () => {
    const html = draw({ ...offLink, hasLink: false, url: null as never });
    expect(text(html)).toContain("Sam Tillery has no link yet, so there is nothing to open or copy.");
    expect(html).toContain(`href="/crm/${CUSTOMER}"`);
    expect(btn("Turn On")).toBeUndefined();
  });

  it("the tab hands the card the same read it first loads with", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-customer-page.tsx"), "utf8");
    expect(src).toContain("const reloadLink = useCallback(async () => putLink(await jobPortalLink(jobId)), [jobId, putLink]);");
    expect(src).toContain("putLink(ln);");
  });
});
