import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CREW IMPORT HANDS OUT A ONE-TIME LINK, NEVER A PHONE-DIGIT PASSWORD (cn-v1134). The import used to
 * make each login with the person's phone digits as the password (or "deck-" + 8 hex) and show it
 * once; a roster is not a secret. Now the login is made with a long random password nobody sees, the
 * admin API's generateLink (which SENDS NOTHING) answers a recovery token hash, and the office hands
 * each person a link to the app's token-hash door that opens Set A Password. Driven here on a
 * recording admin fake: no row carries a password, one link per created person, generateLink called
 * with type "recovery", nothing emailed, and each failure said in words; the results row rendered;
 * the pure link builder and the door's source pinned.
 */
const state = vi.hoisted(() => ({
  me: { role: "owner", org_id: "org-1", active: true } as Record<string, unknown> | null,
  configured: true,
  refuseCreate: null as null | ((email: string) => string | null),
  noLinkFor: null as null | string,
  profileError: null as null | { message: string },
  /** The profiles update hits no row (no roster row for the new login): the silent-write case. */
  profileZeroRows: false,
  calls: {
    createUser: [] as Array<Record<string, unknown>>,
    generateLink: [] as Array<Record<string, unknown>>,
    deleteUser: [] as string[],
    upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    profileUpdates: [] as Array<{ patch: Record<string, unknown>; id: unknown }>,
    emailDoors: [] as string[],
  },
}));

const userClient = {
  auth: {
    getUser: async () => ({ data: { user: { id: "me" } } }),
    resetPasswordForEmail: async () => {
      state.calls.emailDoors.push("resetPasswordForEmail");
      return { data: null, error: null };
    },
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.me, error: null }) }) }) }),
};
const adminClient = {
  auth: {
    admin: {
      createUser: async (input: Record<string, unknown>) => {
        state.calls.createUser.push(input);
        const refused = state.refuseCreate?.(String(input.email));
        if (refused) return { data: { user: null }, error: { message: refused } };
        return { data: { user: { id: `user-${state.calls.createUser.length}` } }, error: null };
      },
      generateLink: async (input: Record<string, unknown>) => {
        state.calls.generateLink.push(input);
        if (state.noLinkFor === input.email) return { data: null, error: { message: "could not make the link" } };
        return {
          data: {
            properties: {
              action_link: `https://proj.supabase.test/auth/v1/verify?token=hash-for-${input.email}&type=recovery&redirect_to=x`,
              email_otp: "123456",
              hashed_token: `hash-for-${input.email}`,
              redirect_to: "x",
              verification_type: "recovery",
            },
            user: { id: "u" },
          },
          error: null,
        };
      },
      deleteUser: async (id: string) => {
        state.calls.deleteUser.push(id);
        return { data: null, error: null };
      },
      inviteUserByEmail: async () => {
        state.calls.emailDoors.push("inviteUserByEmail");
        return { data: null, error: null };
      },
    },
  },
  from: (table: string) => ({
    upsert: async (row: Record<string, unknown>) => {
      state.calls.upserts.push({ table, row });
      return { data: null, error: null };
    },
    update: (patch: Record<string, unknown>) => ({
      eq: (_col: string, id: unknown) => ({
        // The door selects what it wrote (the silent-write law): the row's id, none, or an error.
        select: async () => {
          state.calls.profileUpdates.push({ patch, id });
          if (state.profileError) return { data: null, error: state.profileError };
          return { data: state.profileZeroRows ? [] : [{ id }], error: null };
        },
      }),
    }),
  }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => userClient), createServiceClient: vi.fn(() => userClient) }));
vi.mock("@/lib/supabase/admin", () => ({ adminConfigured: () => state.configured, createAdminClient: () => adminClient }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const reportError = vi.fn();
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

const { importCrew } = await import("./actions");
const { CrewImportResults } = await import("./crew-import-button");
const { crewSetupLink, CREW_IMPORT_WORDS, CREW_SETUP_NEXT } = await import("./crew-setup-link");
const { dict } = await import("@/lib/i18n");

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const ROWS = [
  { full_name: "Larkspur Catbird", email: "Larkspur@Example.test", phone: "(530) 555-0101", role: "tech" },
  { full_name: "Snowbell Thistlewood", email: "snowbell@example.test", phone: "", role: "office" },
  { full_name: "", email: "nobody@example.test" },
];

beforeEach(() => {
  state.me = { role: "owner", org_id: "org-1", active: true };
  state.configured = true;
  state.refuseCreate = null;
  state.noLinkFor = null;
  state.profileError = null;
  state.profileZeroRows = false;
  for (const k of Object.keys(state.calls)) (state.calls as Record<string, unknown[]>)[k].length = 0;
  reportError.mockClear();
  process.env.NEXT_PUBLIC_SITE_URL = "https://app.example.test/";
});

describe("the import door, on a recording admin fake", () => {
  it("one one-time link per created person, no password on any row, nothing emailed", async () => {
    const res = await importCrew(ROWS);
    expect(res.ok).toBe(true);
    const results = res.results!;
    expect(results.map((r) => r.status)).toEqual(["created", "created", "failed"]);
    for (const r of results) {
      expect(r).not.toHaveProperty("password");
      expect(JSON.stringify(r)).not.toMatch(/5305550101|deck-/);
    }
    expect(results[0]).toEqual({
      name: "Larkspur Catbird",
      email: "larkspur@example.test",
      status: "created",
      setupLink: "https://app.example.test/auth/confirm?token_hash=hash-for-larkspur%40example.test&type=recovery&next=%2Fset-password",
    });
    expect(results[1].setupLink).toBe("https://app.example.test/auth/confirm?token_hash=hash-for-snowbell%40example.test&type=recovery&next=%2Fset-password");
    expect(results[2]).toEqual({ name: "nobody@example.test", email: "nobody@example.test", status: "failed", reason: "Missing name or email." });

    // generateLink: once per created person, type recovery, nothing else asked of it.
    expect(state.calls.generateLink).toEqual([
      { type: "recovery", email: "larkspur@example.test" },
      { type: "recovery", email: "snowbell@example.test" },
    ]);
    // The login's password is long and random (two UUIDs), never the phone digits, never returned.
    expect(state.calls.createUser).toHaveLength(2);
    for (const c of state.calls.createUser) {
      expect(String(c.password)).toMatch(/^[0-9a-f-]{72}$/);
      expect(c.email_confirm).toBe(true);
    }
    expect(new Set(state.calls.createUser.map((c) => c.password)).size).toBe(2);
    // The seat: attached to the company, must choose a password, the roster's phone kept.
    expect(state.calls.profileUpdates.map((u) => u.patch)).toEqual([
      { org_id: "org-1", full_name: "Larkspur Catbird", role: "tech", phone: "(530) 555-0101", hourly_rate: null, active: true, must_reset_password: true },
      { org_id: "org-1", full_name: "Snowbell Thistlewood", role: "office", phone: null, hourly_rate: null, active: true, must_reset_password: true },
    ]);
    // preApproveSignup is as it was: the invite-only gate (0125) is passed per email.
    expect(state.calls.upserts.map((u) => [u.table, u.row.email])).toEqual([
      ["signup_allowlist", "larkspur@example.test"],
      ["signup_allowlist", "snowbell@example.test"],
    ]);
    // No email door was touched.
    expect(state.calls.emailDoors).toEqual([]);
    expect(state.calls.deleteUser).toEqual([]);
  });

  it("a link that could not be made: the person is created, the row says so in words, no link, the failure filed", async () => {
    state.noLinkFor = "snowbell@example.test";
    const res = await importCrew(ROWS.slice(0, 2));
    expect(res.results![0].setupLink).toMatch(/^https:\/\/app\.example\.test\/auth\/confirm\?/);
    expect(res.results![1]).toEqual({ name: "Snowbell Thistlewood", email: "snowbell@example.test", status: "created", reason: CREW_IMPORT_WORDS.noLink });
    // The sink is told the row's place in the file, never the person's email.
    expect(reportError).toHaveBeenCalledWith("crewImport.generateLink", { message: "could not make the link" }, { row: 2 });
    expect(JSON.stringify(reportError.mock.calls)).not.toContain("snowbell@example.test");
  });

  it("a profiles update that hits no row is said for that person (the silent-write law): the login stands, no link, the office finishes the seat", async () => {
    state.profileZeroRows = true;
    const res = await importCrew(ROWS.slice(0, 1));
    expect(res.results![0]).toEqual({ name: "Larkspur Catbird", email: "larkspur@example.test", status: "created", reason: CREW_IMPORT_WORDS.noRoster });
    expect(CREW_IMPORT_WORDS.noRoster).toBe("Added, but the roster row could not be written. Open Team and finish their seat there.");
    expect(state.calls.generateLink).toEqual([]);
    expect(state.calls.deleteUser).toEqual([]);
    expect(reportError).toHaveBeenCalledWith("crewImport.profileZeroRows", expect.any(Error), { row: 1, userId: "user-1" });
    expect(JSON.stringify(reportError.mock.calls)).not.toContain("@example.test");
  });

  it("no site URL on the server: nobody gets a half link, every created row says the way in", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const res = await importCrew(ROWS.slice(0, 1));
    expect(res.results![0]).toEqual({ name: "Larkspur Catbird", email: "larkspur@example.test", status: "created", reason: CREW_IMPORT_WORDS.noLink });
    expect(state.calls.generateLink).toHaveLength(1);
  });

  it("a login that already exists is skipped in words, and no link is made for it", async () => {
    state.refuseCreate = (email) => (email === "larkspur@example.test" ? "A user with this email address has already been registered" : null);
    const res = await importCrew(ROWS.slice(0, 2));
    expect(res.results![0]).toEqual({ name: "Larkspur Catbird", email: "larkspur@example.test", status: "failed", reason: "Already has a login." });
    expect(res.results![1].status).toBe("created");
    expect(state.calls.generateLink.map((c) => c.email)).toEqual(["snowbell@example.test"]);
  });

  it("a profile that did not attach rolls the login back and says why; no link for it", async () => {
    state.profileError = { message: "profiles refused" };
    const res = await importCrew(ROWS.slice(0, 1));
    expect(res.results![0]).toEqual({ name: "Larkspur Catbird", email: "larkspur@example.test", status: "failed", reason: "profiles refused" });
    expect(state.calls.deleteUser).toEqual(["user-1"]);
    expect(state.calls.generateLink).toEqual([]);
  });

  it("the gates stand: not an owner or admin, a deactivated admin, no service key", async () => {
    state.me = { role: "office", org_id: "org-1", active: true };
    expect(await importCrew(ROWS)).toEqual({ ok: false, error: "Not allowed." });
    state.me = { role: "admin", org_id: "org-1", active: false };
    expect(await importCrew(ROWS)).toEqual({ ok: false, error: "Not allowed." });
    state.me = { role: "admin", org_id: "org-1", active: true };
    state.configured = false;
    expect((await importCrew(ROWS)).ok).toBe(false);
    expect(state.calls.createUser).toEqual([]);
  });

  /**
   * THE ROSTER'S LANGUAGE COLUMN (cn-v1138): a Spanish-speaking tech is imported in Spanish and
   * never has to find the toggle. "es" / "español" / "espanol" / "spanish" in any case is Spanish;
   * any other word is English; a row with no language column leaves the profile's default. And
   * still nothing is emailed.
   */
  it("the language column lands on the row: Spanish for the Spanish words, English for a bad value, nothing when the column is absent; no email either way", async () => {
    const res = await importCrew([
      { full_name: "Larkspur Catbird", email: "larkspur@example.test", language: "Español" },
      { full_name: "Snowbell Thistlewood", email: "snowbell@example.test", language: "klingon" },
      { full_name: "Bayberry Thistlewood", email: "bayberry@example.test", language: "spanish" },
      { full_name: "Catbird Larkspur", email: "catbird@example.test" },
    ]);
    expect(res.ok).toBe(true);
    expect(res.results!.map((r) => r.status)).toEqual(["created", "created", "created", "created"]);
    expect(state.calls.profileUpdates.map((u) => u.patch.language)).toEqual(["es", "en", "es", undefined]);
    expect(state.calls.profileUpdates[3].patch).not.toHaveProperty("language");
    // The link carries the row's language: a Spanish row's ends in &lang=es (the confirm door speaks
    // Spanish on any phone); an English row's, a bad word's, and a row with no column are as they were.
    expect(res.results![0].setupLink).toBe("https://app.example.test/auth/confirm?token_hash=hash-for-larkspur%40example.test&type=recovery&next=%2Fset-password&lang=es");
    expect(res.results![2].setupLink).toMatch(/&lang=es$/);
    expect(res.results![1].setupLink).toBe("https://app.example.test/auth/confirm?token_hash=hash-for-snowbell%40example.test&type=recovery&next=%2Fset-password");
    expect(res.results![3].setupLink).not.toContain("lang=");
    // The seat is otherwise as it was: the company, the role, the password reset.
    expect(state.calls.profileUpdates[0].patch).toMatchObject({ org_id: "org-1", role: "tech", active: true, must_reset_password: true });
    expect(state.calls.emailDoors).toEqual([]);
    for (const r of res.results!) expect(r).not.toHaveProperty("password");
  });
});

describe("the link builder is pure", () => {
  it("builds the token-hash door's URL, trailing slash dropped, hash encoded, landing on Set A Password", () => {
    expect(CREW_SETUP_NEXT).toBe("/set-password");
    expect(crewSetupLink("https://app.example.test/", "abc+def/ghi")).toBe("https://app.example.test/auth/confirm?token_hash=abc%2Bdef%2Fghi&type=recovery&next=%2Fset-password");
    expect(crewSetupLink("https://app.example.test", "h1")).toBe("https://app.example.test/auth/confirm?token_hash=h1&type=recovery&next=%2Fset-password");
  });

  it("a Spanish row's link carries &lang=es so the door speaks Spanish on any phone; an English row's, or no language, is as it was (cn-v1138)", () => {
    expect(crewSetupLink("https://app.example.test", "h1", "es")).toBe("https://app.example.test/auth/confirm?token_hash=h1&type=recovery&next=%2Fset-password&lang=es");
    expect(crewSetupLink("https://app.example.test", "h1", "en")).toBe("https://app.example.test/auth/confirm?token_hash=h1&type=recovery&next=%2Fset-password");
    expect(crewSetupLink("https://app.example.test", "h1", null)).toBe("https://app.example.test/auth/confirm?token_hash=h1&type=recovery&next=%2Fset-password");
    expect(crewSetupLink("https://app.example.test", "h1", "klingon")).toBe("https://app.example.test/auth/confirm?token_hash=h1&type=recovery&next=%2Fset-password");
  });

  it("answers null with no base, no hash, or a base that is not a bare origin", () => {
    expect(crewSetupLink(undefined, "h1")).toBeNull();
    expect(crewSetupLink("", "h1")).toBeNull();
    expect(crewSetupLink("https://app.example.test", "")).toBeNull();
    expect(crewSetupLink("https://app.example.test", undefined)).toBeNull();
    expect(crewSetupLink("app.example.test", "h1")).toBeNull();
    expect(crewSetupLink("https://app.example.test/some/path", "h1")).toBeNull();
  });
});

describe("the results row", () => {
  it("shows one row per person: the link with Copy Link, the no-link words, the failed reason; never a password", () => {
    const html = renderToStaticMarkup(
      createElement(CrewImportResults, {
        results: [
          { name: "Larkspur Catbird", email: "larkspur@example.test", status: "created", setupLink: "https://app.example.test/auth/confirm?token_hash=h1&type=recovery&next=%2Fset-password" },
          { name: "Snowbell Thistlewood", email: "snowbell@example.test", status: "created", reason: CREW_IMPORT_WORDS.noLink },
          { name: "Bayberry", email: "bayberry@example.test", status: "failed", reason: "Already has a login." },
        ],
      }),
    );
    const t = text(html);
    expect(t).toContain("Added 2 · 1 skipped");
    expect(t).toContain("Hand each person their link. It opens Set A Password. Nothing was emailed.");
    expect(t).toContain(CREW_IMPORT_WORDS.onceAndSoon);
    expect(t).toContain("Copy Link");
    expect(html.match(/Copy Link/g)).toHaveLength(1); // only the row that has a link
    expect(t).toContain("https://app.example.test/auth/confirm?token_hash=h1&type=recovery&next=%2Fset-password");
    expect(t).toContain(CREW_IMPORT_WORDS.noLink);
    expect(t).toContain("Bayberry — Already has a login.");
    expect(t.toLowerCase()).not.toContain("password:");
  });

  it("the screen's words and doors are Title Case and the temp-password path is gone", () => {
    const screen = src("src/app/(app)/settings/crew-import-button.tsx");
    expect(screen).toContain('title="Import Crew"');
    expect(screen).toContain('cancelLabel="Done"');
    // Copy Link says Copied, or that it could not — never nothing (no clipboard, or a refused write).
    expect(screen).toContain('{state === "copied" ? "Copied" : "Copy Link"}');
    expect(screen).toContain("Couldn&apos;t copy — select the link.");
    expect(screen).toContain('if (!clipboard?.writeText) {\n      setState("failed");');
    expect(screen).toContain('.catch(() => setState("failed"))');
    expect(screen).not.toMatch(/requireReset|phone digits|temp pwd|r\.password/);
    expect(CREW_IMPORT_WORDS.before).toContain("Nothing is emailed.");
    expect(CREW_IMPORT_WORDS.handOut).toBe("Hand each person their link. It opens Set A Password. Nothing was emailed.");
    // The links are shown once and go with Done; no clock is promised that the server does not keep.
    expect(CREW_IMPORT_WORDS.onceAndSoon).toBe(
      "These links are shown once. Copy each one now; they are gone when you press Done. Each works once and for a short time; if one expires, that person signs in with a code from the login page and sets a password there.",
    );
    expect(CREW_IMPORT_WORDS.onceAndSoon).not.toMatch(/hour/);
  });
});

describe("the door the link walks through (source pins)", () => {
  it("importCrew: a random password, generateLink type recovery, no email door, must_reset_password true", () => {
    const actions = src("src/app/(app)/settings/actions.ts");
    const body = actions.slice(actions.indexOf("export async function importCrew("), actions.indexOf("export async function syncScheduleToGoogle("));
    expect(body).toContain("const password = `${crypto.randomUUID()}${crypto.randomUUID()}`;");
    expect(body).toContain('admin.auth.admin.generateLink({ type: "recovery", email })');
    expect(body).toContain(
      "crewSetupLink(process.env.NEXT_PUBLIC_SITE_URL, link?.properties?.hashed_token, r.language !== undefined ? langFromWord(r.language) : undefined)",
    );
    expect(body).toContain("must_reset_password: true");
    expect(body).not.toMatch(/inviteUserByEmail|resetPasswordForEmail|sendEmail\(|\.action_link|replace\(\/\\D\/g|deck-|password,? status/);
    expect(body).not.toMatch(/console\.(log|info)/);
    // The import's answer type has no password field.
    expect(actions).toMatch(/export type CrewImportResult = \{ name: string; email: string; setupLink\?: string; status: "created" \| "failed"; reason\?: string \};/);
  });

  it("/auth/confirm is TWO steps: GET shows one button (a link preview must not spend the token), POST verifies the recovery hash server-side, keeps the deactivation gate, and lands on Set A Password", () => {
    const route = src("src/app/auth/confirm/route.ts");
    expect(route.match(/^export /gm)).toEqual(["export ", "export "]); // the page (GET) and the verify (POST), nothing else
    expect(route).toContain("export async function GET(request: Request)");
    expect(route).toContain("export async function POST(request: Request)");
    const getAt = route.indexOf("export async function GET(");
    const get = route.slice(getAt, route.indexOf("\n}\n", getAt) + 3); // the handler's own body, not the comment above POST
    const post = route.slice(route.indexOf("export async function POST("));
    // GET: a form that POSTs the hash back, Title Case on the one button, plain words, never cached; no verify.
    expect(get).toContain('<form method="post" action="/auth/confirm">');
    expect(get).toContain('<input type="hidden" name="token_hash" value="${attr(tokenHash)}">');
    expect(get).toContain('<input type="hidden" name="type" value="recovery">');
    expect(get).toContain('<input type="hidden" name="next" value="${attr(next)}">');
    // The words come through the catalog in the link's or the phone's language (cn-v1138); the English is as it was.
    expect(get).toContain('<button type="submit">${t("au_setMyPassword")}</button>');
    expect(get).toContain('<p>${t("au_tapToSet")}</p>');
    expect(get).toContain('<input type="hidden" name="lang" value="${lang}">');
    expect(dict("en").au_setMyPassword).toBe("Set My Password");
    expect(dict("en").au_tapToSet).toBe("Tap to set your password.");
    expect(get).toContain('"cache-control": "no-store"');
    expect(get).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(get).not.toContain("verifyOtp");
    expect(get).toContain('safeNextPath(searchParams.get("next")) ?? "/set-password"');
    // POST: the verify, the gate, the same-app next, 303 so the browser GETs the next page.
    expect(post).toContain('if (tokenHash && type === "recovery")');
    expect(post).toContain('supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash })');
    expect(post).toContain("if (await endSessionIfDeactivated(supabase))");
    expect(post).toContain('safeNextPath(field("next")) ?? "/set-password"');
    expect(post).toContain("NextResponse.redirect(`${origin}${next}`, 303)");
    // A used or expired link names ONE way out (the office cannot re-issue a link today).
    expect(dict("en").au_linkUsed).toBe("That link has already been used or has expired. Sign in with a code instead.");
    expect(route.match(/t\("au_linkUsed"\)/g)).toHaveLength(2); // the GET's bad link and the POST's failed verify
    expect(route).not.toMatch(/Ask your office for a new one/);
    // Set A Password is the app's own page: it needs the session the door just wrote and clears the must-reset flag.
    const page = src("src/app/set-password/page.tsx");
    expect(page).toContain('if (!user) redirect("/login");');
    expect(page).toContain('{t("au_chooseSub")}');
    expect(dict("en").au_chooseSub).toBe("Choose your password. You'll use it from now on.");
    expect(page).not.toContain("temporary password");
    const setPw = src("src/app/set-password/actions.ts");
    expect(setPw).toContain(".update({ must_reset_password: false })");
    const shell = src("src/app/(app)/layout.tsx");
    expect(shell).toContain('if (profile.must_reset_password) redirect("/set-password");');
  });
});
