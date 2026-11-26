import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE-TIME DOOR SPEAKS THE PERSON'S LANGUAGE (auth/confirm/route.ts, cn-v1138). `?lang=es` on the
 * link (the crew import stamps a Spanish row's) wins; without it the phone's Accept-Language decides;
 * an English phone with no lang reads exactly what it read before. GET is still only a page (no
 * verify, never cached) and carries its language into the hidden field; POST still consumes the hash
 * exactly as cn-v1134 built it, and its refusals read as the page did.
 */
const state = vi.hoisted(() => ({
  verifyError: null as null | { message: string },
  active: true,
  verifyCalls: [] as unknown[],
  // cn-v1199: the org-less site collaborator (no org_id, a content grant) a sign-in link routes to /content.
  orgId: "org-1" as string | null,
  collaborator: false,
  rpcs: [] as string[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      verifyOtp: vi.fn(async (input: unknown) => {
        state.verifyCalls.push(input);
        return { error: state.verifyError };
      }),
      getUser: async () => ({ data: { user: { id: "u1" } } }),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === "profiles" ? { active: state.active, org_id: state.orgId } : null }),
          limit: async () => ({ data: table === "site_collaborators" && state.collaborator ? [{ org_id: "org-2" }] : [] }),
        }),
      }),
    }),
    rpc: async (name: string) => {
      state.rpcs.push(name);
      return { data: null, error: null };
    },
  })),
}));

import { GET, POST } from "./route";

const get = (query: string, acceptLanguage?: string) =>
  GET(new Request(`https://app.test/auth/confirm${query}`, { headers: acceptLanguage ? { "accept-language": acceptLanguage } : {} }));
const post = async (fields: Record<string, string>, acceptLanguage?: string) => {
  const body = new URLSearchParams(fields);
  return POST(
    new Request("https://app.test/auth/confirm", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}) },
    }),
  );
};
const ES_USED = "Ese enlace ya se usó o ya venció. Inicia sesión con un código.";
const EN_USED = "That link has already been used or has expired. Sign in with a code instead.";

beforeEach(() => {
  state.verifyError = null;
  state.active = true;
  state.verifyCalls = [];
  state.orgId = "org-1";
  state.collaborator = false;
  state.rpcs = [];
});

describe("GET, the page", () => {
  it("?lang=es wins: the Spanish button, sentence, title and html lang, the language in the hidden field; no verify, never cached", async () => {
    const res = await get("?token_hash=h1&type=recovery&lang=es", "en-US,en");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("<title>Crear Mi Contraseña</title>");
    expect(html).toContain("<p>Toca para crear tu contraseña.</p>");
    expect(html).toContain('<button type="submit">Crear Mi Contraseña</button>');
    expect(html).toContain('<input type="hidden" name="token_hash" value="h1">');
    expect(html).toContain('<input type="hidden" name="type" value="recovery">');
    expect(html).toContain('<input type="hidden" name="next" value="/set-password">');
    expect(html).toContain('<input type="hidden" name="lang" value="es">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(state.verifyCalls).toEqual([]);
  });

  it("without ?lang the phone's Accept-Language decides: es-MX reads Spanish, en-US what it read before", async () => {
    const es = await (await get("?token_hash=h1&type=recovery", "es-MX,es;q=0.9,en;q=0.8")).text();
    expect(es).toContain('<button type="submit">Crear Mi Contraseña</button>');
    expect(es).toContain('<input type="hidden" name="lang" value="es">');
    const en = await (await get("?token_hash=h1&type=recovery", "en-US,en;q=0.9")).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("<title>Set My Password</title>");
    expect(en).toContain("<p>Tap to set your password.</p>");
    expect(en).toContain('<button type="submit">Set My Password</button>');
    expect(en).toContain('<input type="hidden" name="lang" value="en">');
    const bare = await (await get("?token_hash=h1&type=recovery")).text();
    expect(bare).toContain('<button type="submit">Set My Password</button>');
  });

  it("no hash, or not a recovery link: the login page with the one way out, in the person's language", async () => {
    const es = await get("?type=recovery", "es-MX,es");
    expect(es.status).toBe(307);
    expect(decodeURIComponent(es.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${ES_USED}`);
    const en = await get("?token_hash=h1&type=magiclink");
    expect(decodeURIComponent(en.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${EN_USED}`);
  });
});

describe("POST, the verify (as cn-v1134 built it)", () => {
  it("consumes the hash server-side and lands on Set A Password with a 303; the language changes nothing about that", async () => {
    const res = await post({ token_hash: "h1", type: "recovery", next: "/set-password", lang: "es" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.test/set-password");
    expect(state.verifyCalls).toEqual([{ type: "recovery", token_hash: "h1" }]);
  });

  it("a used or expired hash: the login page with the one way out, in the language the page carried", async () => {
    state.verifyError = { message: "Token has expired or is invalid" };
    const es = await post({ token_hash: "h1", type: "recovery", lang: "es" }, "en-US");
    expect(es.status).toBe(303);
    expect(decodeURIComponent(es.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${ES_USED}`);
    // No hidden field (an old page): the phone's header decides.
    const en = await post({ token_hash: "h1", type: "recovery" }, "en-US");
    expect(decodeURIComponent(en.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${EN_USED}`);
    const header = await post({ token_hash: "h1", type: "recovery" }, "es-MX,es");
    expect(decodeURIComponent(header.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${ES_USED}`);
  });

  it("a deactivated account gets no session and reads why in its language", async () => {
    state.active = false;
    const res = await post({ token_hash: "h1", type: "recovery", lang: "es" });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toBe("https://app.test/login?error=Esta cuenta fue desactivada. Habla con tu oficina.");
  });

  it("no hash or the wrong type never verifies", async () => {
    const res = await post({ type: "recovery", lang: "es" });
    expect(state.verifyCalls).toEqual([]);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${ES_USED}`);
  });
});

describe("the app's own sign-in email walks through the same door (cn-v1199)", () => {
  it("GET with for=signin: the sign-in sentence and the Sign In button, in both languages, carried into the POST; still a recovery link, still no verify", async () => {
    const en = await (await get("?token_hash=h1&type=recovery&next=%2Fplanner&for=signin", "en-US,en")).text();
    expect(en).toContain("<title>Sign In</title>");
    expect(en).toContain("<p>Tap to sign in.</p>");
    expect(en).toContain('<button type="submit">Sign In</button>');
    expect(en).toContain('<input type="hidden" name="type" value="recovery">');
    expect(en).toContain('<input type="hidden" name="next" value="/planner">');
    expect(en).toContain('<input type="hidden" name="for" value="signin">');
    expect(en).not.toContain("Set My Password");
    const es = await (await get("?token_hash=h1&type=recovery&next=%2Fplanner&lang=es&for=signin")).text();
    expect(es).toContain("<p>Toca para iniciar sesión.</p>");
    expect(es).toContain('<button type="submit">Iniciar Sesión</button>');
    expect(state.verifyCalls).toEqual([]);
  });

  it("any other value of for reads as today's set-a-password page, and carries nothing", async () => {
    for (const v of ["SignIn", "signup", "", "signin%20"]) {
      const html = await (await get(`?token_hash=h1&type=recovery&for=${v}`, "en-US")).text();
      expect(html, v).toContain('<button type="submit">Set My Password</button>');
      expect(html, v).toContain("<p>Tap to set your password.</p>");
      expect(html, v).not.toContain('name="for"');
    }
  });

  it("a sign-in link still needs type=recovery: a magiclink is refused before any verify", async () => {
    const res = await get("?token_hash=h1&type=magiclink&for=signin");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${EN_USED}`);
    const posted = await post({ token_hash: "h1", type: "magiclink", next: "/planner", for: "signin" });
    expect(decodeURIComponent(posted.headers.get("location") ?? "")).toBe(`https://app.test/login?mode=code&error=${EN_USED}`);
    expect(state.verifyCalls).toEqual([]);
  });

  it("POST with for=signin verifies as recovery and lands on My Day", async () => {
    const res = await post({ token_hash: "h1", type: "recovery", next: "/planner", for: "signin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.test/planner");
    expect(state.verifyCalls).toEqual([{ type: "recovery", token_hash: "h1" }]);
    expect(state.rpcs).toEqual([]); // an org member skips the claim
  });

  it("an org-less site collaborator's sign-in link lands on /content after the claim; a set-a-password link does not route", async () => {
    state.orgId = null;
    state.collaborator = true;
    const res = await post({ token_hash: "h1", type: "recovery", next: "/planner", for: "signin" });
    expect(res.headers.get("location")).toBe("https://app.test/content");
    expect(state.rpcs).toEqual(["claim_site_collaborations"]);
    state.rpcs = [];
    const reset = await post({ token_hash: "h1", type: "recovery", next: "/set-password" });
    expect(reset.headers.get("location")).toBe("https://app.test/set-password");
    expect(state.rpcs).toEqual([]);
  });

  it("a deactivated person's sign-in link gets no session and reads why", async () => {
    state.active = false;
    const res = await post({ token_hash: "h1", type: "recovery", next: "/planner", for: "signin" });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toBe("https://app.test/login?error=This account has been deactivated. Contact your office.");
  });

  it("a DEACTIVATED org-less collaborator's sign-in link reads why too: the gate comes before the routing", async () => {
    state.orgId = null;
    state.collaborator = true;
    state.active = false;
    const res = await post({ token_hash: "h1", type: "recovery", next: "/planner", for: "signin" });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toBe("https://app.test/login?error=This account has been deactivated. Contact your office.");
    expect(state.rpcs).not.toContain("claim_site_collaborations");
  });
});
