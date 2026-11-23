import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newWorld, serviceClient, cookieClient, type World } from "@/test/join-door-fake";

/**
 * THE ONE-STEP INVITE'S PAGE (cn-v1183): one state per render, in the phone's language, and a GET
 * that writes nothing (mail scanners fetch it). The create form shows the invitation's address as
 * text and has NO email input; the token rides only in the hidden `t` and the links.
 */
const state = vi.hoisted(() => ({
  world: null as unknown as World,
  acceptLanguage: "en-US,en;q=0.9",
  userAgent: "Mozilla/5.0",
  adminOn: true,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "accept-language": state.acceptLanguage, "user-agent": state.userAgent })),
  cookies: vi.fn(async () => ({ getAll: () => [], set: () => {}, delete: () => {} })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => cookieClient(state.world)),
  createServiceClient: vi.fn(() => serviceClient(state.world)),
}));
vi.mock("@/lib/supabase/admin", () => ({ adminConfigured: () => state.adminOn }));
vi.mock("@/app/(app)/settings/actions", () => ({ setLanguage: vi.fn() }));

import JoinPage, { generateMetadata, dynamic } from "./page";
import { dict, fillText } from "@/lib/i18n";

const TOKEN = "ab".repeat(24);
const EMAIL = "sam.tillery@example.com";
const ORG = "org-larkspur";

function seed(w: World) {
  w.tables.organizations.push({ id: ORG, name: "Larkspur Electric" }, { id: "org-northline", name: "Northline Supply" });
  w.tables.invitations.push({ id: "inv-1", token: TOKEN, org_id: ORG, email: EMAIL, role: "office", accepted_at: null, expires_at: "2026-12-06T12:00:00Z", created_at: "2026-11-20T00:00:00Z" });
}
const account = (w: World, over: { confirmed?: boolean; signedIn?: boolean; org?: string | null; session?: boolean; email?: string } = {}) => {
  const email = over.email ?? EMAIL;
  w.users.push({ id: "u-1", email, password: "x", email_confirmed_at: over.confirmed ? "2026-11-01T00:00:00Z" : null, last_sign_in_at: over.signedIn ? "2026-11-01T00:00:00Z" : null });
  w.tables.profiles.push({ id: "u-1", email, org_id: over.org ?? null, active: true });
  if (over.session) w.session = "u-1";
};

const render = async (params: Record<string, string> = { t: TOKEN }) => renderToStaticMarkup(await JoinPage({ searchParams: Promise.resolve(params) }));
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
  state.world = newWorld();
  seed(state.world);
  state.acceptLanguage = "en-US,en;q=0.9";
  state.userAgent = "Mozilla/5.0";
  state.adminOn = true;
});

type Case = { name: string; arrange?: (w: World) => void; params?: Record<string, string>; want: (l: "en" | "es") => string[]; button?: (l: "en" | "es") => string };
const co = "Larkspur Electric";
const d = (l: "en" | "es") => dict(l);
const CASES: Case[] = [
  {
    name: "create",
    want: (l) => [fillText(d(l).au_joinHeading, { company: co }), fillText(d(l).au_joinSub, { role: d(l).au_joinRole_office }), fillText(d(l).au_joinEmailLine, { email: EMAIL }), d(l).au_fullName, d(l).au_password],
    button: (l) => fillText(d(l).au_joinButton, { company: co }),
  },
  {
    name: "join_signed_in",
    arrange: (w) => account(w, { confirmed: true, signedIn: true, session: true }),
    want: (l) => [fillText(d(l).au_joinSignedIn, { company: co, role: d(l).au_joinRole_office })],
    button: (l) => fillText(d(l).au_joinButton, { company: co }),
  },
  { name: "sign_in_first", arrange: (w) => account(w, { confirmed: true }), want: (l) => [fillText(d(l).au_joinSignInFirst, { company: co }), d(l).au_signIn] },
  { name: "shell", arrange: () => (state.userAgent = "Mozilla/5.0 CNShell/1 (iOS)"), want: (l) => [d(l).au_shellSignupNote, d(l).au_signIn] },
  { name: "invalid (unknown token)", params: { t: "cd".repeat(24) }, want: (l) => [d(l).au_joinInvalid] },
  { name: "invalid (no token)", params: {}, want: (l) => [d(l).au_joinInvalid] },
  { name: "used", arrange: (w) => (w.tables.invitations[0].accepted_at = "2026-11-21T00:00:00Z"), want: (l) => [fillText(d(l).au_joinUsed, { company: co }), d(l).au_signIn] },
  {
    name: "expired",
    arrange: (w) => (w.tables.invitations[0].expires_at = "2026-11-20T12:00:00Z"),
    want: (l) => [fillText(d(l).au_joinExpired, { company: co, date: l === "en" ? "Nov 20, 2026" : new Date("2026-11-20T12:00:00Z").toLocaleDateString("es-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) })],
  },
  {
    name: "superseded",
    arrange: (w) =>
      w.tables.invitations.push({ id: "inv-n", token: "12".repeat(24), org_id: "org-northline", email: EMAIL, role: "tech", accepted_at: null, expires_at: "2026-12-07T00:00:00Z", created_at: "2026-11-21T00:00:00Z" }),
    want: (l) => [fillText(d(l).au_joinSuperseded, { company: co })],
  },
  {
    name: "signed_in_other",
    arrange: (w) => account(w, { confirmed: true, signedIn: true, session: true, email: "casey.loam@example.com" }),
    want: (l) => [fillText(d(l).au_joinSignedInOther, { email: "casey.loam@example.com" })],
    button: (l) => d(l).sh_signOut,
  },
  { name: "other_company", arrange: (w) => account(w, { confirmed: true, signedIn: true, org: "org-northline" }), want: (l) => [fillText(d(l).au_joinOtherCompany, { company: co })] },
  { name: "unavailable", arrange: () => (state.adminOn = false), want: (l) => [d(l).au_joinUnavailable] },
];

describe.each(["en", "es"] as const)("every state in %s", (lang) => {
  it.each(CASES)("$name", async (c) => {
    if (lang === "es") state.acceptLanguage = "es-MX,es;q=0.9";
    c.arrange?.(state.world);
    const html = await render(c.params);
    const t = text(html);
    for (const w of c.want(lang)) expect(t).toContain(w);
    const buttons = [...html.matchAll(/<button\b[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]));
    expect(buttons).toEqual(c.button ? [c.button(lang)] : []);
    // GET changes nothing.
    expect(state.world.writes).toEqual([]);
    expect(state.world.adminCalls.map((a) => a.name).filter((n) => n !== "getUserById")).toEqual([]);
    expect(state.world.log).toEqual([]);
  });
});

describe("the create form", () => {
  it("has NO email input, carries the hidden t, and asks for a new password", async () => {
    const html = await render();
    expect(html).not.toMatch(/name="email"/);
    expect(html).toContain(`<input type="hidden" name="t" value="${TOKEN}"/>`);
    expect(html).toMatch(/name="password"[^>]*autoComplete="new-password"|autoComplete="new-password"[^>]*name="password"/);
    expect(html).toMatch(/minLength="6"/);
    expect(html).toMatch(/id="full_name"[^>]*required=""[^>]*name="full_name"/);
  });

  it("sign_in_first links to sign-in with the address and the way back here", async () => {
    account(state.world, { confirmed: true });
    const html = await render();
    expect(html).toContain(`href="/login?email=${encodeURIComponent(EMAIL)}&amp;next=${encodeURIComponent(`/auth/join?t=${TOKEN}`)}"`);
  });

  it("a malformed token reads nothing", async () => {
    await render({ t: "' or 1=1 --" });
    expect(state.world.froms).toEqual([]);
  });

  it("a CODE sent back is drawn as its catalog sentence in the red box, in the page's language (fixer #85, F6)", async () => {
    const codes: [string, string][] = [
      ["name", "au_nameRequired"],
      ["password", "au_password6"],
      ["failed", "au_joinFailed"],
      ["unavailable", "au_joinUnavailable"],
      ["weak", "au_joinWeakPassword"],
    ];
    for (const lang of ["en", "es"] as const) {
      state.acceptLanguage = lang === "es" ? "es-MX,es;q=0.9" : "en-US";
      for (const [code, key] of codes) {
        const html = await render({ t: TOKEN, e: code });
        expect(dict(lang)[key]).toBeTruthy();
        expect(html).toMatch(/bg-red-50/);
        expect(text(html)).toContain(dict(lang)[key]);
      }
    }
  });

  it("an unknown code, or any free text in the URL, draws nothing", async () => {
    const plain = await render({ t: TOKEN });
    const crafted: Record<string, string>[] = [
      { t: TOKEN, e: "Call 5550100 to verify your account" },
      { t: TOKEN, e: "toString" },
      { t: TOKEN, e: "__proto__" },
      { t: TOKEN, error: "Call 5550100 to verify your account" },
      { t: TOKEN, message: "Call 5550100 to verify your account" },
    ];
    for (const params of crafted) {
      const html = await render(params);
      expect(html).not.toMatch(/bg-red-50/);
      expect(html).not.toContain("5550100");
      expect(html).toBe(plain);
    }
  });

  it("a member is sent to the app", async () => {
    account(state.world, { confirmed: true, signedIn: true, session: true, org: ORG });
    await expect(render()).rejects.toThrow("REDIRECT /planner");
  });
});

describe("the head", () => {
  it("a title in the phone's language, never indexed, never a Referer, always dynamic", async () => {
    expect(dynamic).toBe("force-dynamic");
    const en = await generateMetadata();
    expect(en.title).toBe("Join Your Team");
    expect(en.referrer).toBe("no-referrer");
    expect(en.robots).toMatchObject({ index: false });
    state.acceptLanguage = "es-MX";
    expect((await generateMetadata()).title).toBe("Únete a Tu Equipo");
  });
});

describe("source pins (fixer #85, F8)", () => {
  it("the page file makes no write: no auth admin call, no insert, update, delete or rpc", () => {
    const src = readFileSync(join(process.cwd(), "src/app/auth/join/page.tsx"), "utf8");
    expect(src).not.toMatch(/auth\.admin/);
    expect(src).not.toMatch(/createServiceClient|createAdminClient/);
    for (const verb of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) expect(src).not.toContain(verb);
  });

  it("the service read never lists the token in a select", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/invite-door-read.ts"), "utf8");
    const selects = [...src.matchAll(/\.select\(([^)]*)\)/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const cols of selects) {
      expect(cols).not.toMatch(/token|\*/);
      expect(cols.trim()).not.toBe("");
    }
  });
});
