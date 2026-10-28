import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE-TIME DOOR SPEAKS THE PERSON'S LANGUAGE (auth/confirm/route.ts, cn-v1138). `?lang=es` on the
 * link (the crew import stamps a Spanish row's) wins; without it the phone's Accept-Language decides;
 * an English phone with no lang reads exactly what it read before. GET is still only a page (no
 * verify, never cached) and carries its language into the hidden field; POST still consumes the hash
 * exactly as cn-v1134 built it, and its refusals read as the page did.
 */
const state = vi.hoisted(() => ({ verifyError: null as null | { message: string }, active: true, verifyCalls: [] as unknown[] }));
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
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { active: state.active } }) }) }) }),
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
