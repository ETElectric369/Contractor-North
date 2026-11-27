/**
 * THE SIGN-IN CONTRACT OF THE SUPABASE PAIR, HELD WITH THE REAL LIBRARIES (cn-v1197).
 *
 * Almost every other test in this repository mocks the Supabase client, so nothing would fail if a
 * future @supabase/ssr or @supabase/supabase-js changed how a session is stored, read, refreshed or
 * cleared. This file runs the REAL pair through the app's OWN three client files and its own
 * middleware, with the network replaced by one stub that answers only what each case allows.
 *
 * It is written to be green on two pairs: 0.5.2 / 2.107.0 (installed when it was written) and
 * 0.12.7 / 2.119.2 (the next wave). Where the two legitimately differ, the assertion states the
 * rule that is true for both and the comment beside it says what each pair does.
 *
 * Laws: no network (an unanswered URL is recorded and fails the test, because auth-js would
 * otherwise swallow the throw as a "retryable" error); every token is built at run time; the
 * cookies a session is read FROM are built by this file from the stored format, never by the
 * library under test, so a library that changed its format fails here; nothing global is left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

// ── what the library hands the app's cookie writer, recorded on its way to the app's own setAll ──
const h = vi.hoisted(() => ({
  setAllCalls: [] as unknown[][],
  jar: null as null | { getAll(): { name: string; value: string }[]; set(name: string, value: string, options?: unknown): void },
}));

// next/headers' cookie store, replaced by a jar the test controls (server.ts reads it via cookies()).
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (!h.jar) throw new Error("this test gave server.ts no cookie jar");
    return h.jar;
  },
}));

// The REAL createServerClient, with one recorder between the library and the app's own setAll: every
// argument the library passes is kept, then handed on unchanged to the app's function.
vi.mock("@supabase/ssr", async (importOriginal) => {
  const real = await importOriginal<typeof import("@supabase/ssr")>();
  return {
    ...real,
    createServerClient: (url: string, key: string, options: any) =>
      real.createServerClient(url, key, {
        ...options,
        cookies: {
          ...options.cookies,
          setAll: (...args: unknown[]) => {
            h.setAllCalls.push(args);
            return options.cookies.setAll(...(args as [any]));
          },
        },
      }),
    // A FRESH browser client on every call. While window.document exists, createBrowserClient keeps
    // ONE client for the process (both pairs), and vi.resetModules does not reset it (the package is
    // loaded by Node, outside vitest's registry), so a second case would reuse the first case's
    // client and never start from its own cookies. client.ts passes no options; `isSingleton: false`
    // is the one thing added, and it changes only that cache.
    createBrowserClient: (url: string, key: string, options?: unknown) => {
      if (options !== undefined) throw new Error("client.ts now passes options: rewrite this shim to keep them");
      return real.createBrowserClient(url, key, { isSingleton: false });
    },
  };
});

import { updateSession } from "@/lib/supabase/middleware";
import { createClient as createServerSb } from "@/lib/supabase/server";
import { createClient as createBrowserSb } from "@/lib/supabase/client";
import { CHECK_DEADLINE_MS, checkUser } from "@/lib/supabase/user-check";

// ── stand-ins ──────────────────────────────────────────────────────────────────────────────────────
const PROJECT_URL = "https://example.supabase.co"; // resolves nowhere: every request goes to the stub
const KEY = "sb-example-auth-token"; // the cookie name the library derives from that URL
const CHUNK = 3180; // the most characters one stored chunk holds
const APP = "https://app.example.com";
const SIGNED_IN_PAGE = "/planner"; // not in the middleware's PUBLIC_PATHS: a signed-in page
const CACHE_HEADERS = ["Cache-Control", "Expires", "Pragma"];
const SESSION_NAME = new RegExp(`^${KEY}(\\.\\d+)?$`);

const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

/** An access token shaped like the auth server's: three base64url parts joined here, signed by nobody. */
function makeAccessToken(sub: string, exp: number) {
  return [
    b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64u(JSON.stringify({ sub, aud: "authenticated", role: "authenticated", exp, iat: exp - 3600, session_id: randomUUID() })),
    b64u(randomBytes(32)),
  ].join(".");
}

type Session = {
  access_token: string; refresh_token: string; token_type: string; expires_in: number; expires_at: number;
  user: { id: string; aud: string; role: string; email: string; app_metadata: object; user_metadata: Record<string, unknown>; created_at: string; updated_at: string };
};

/** A session; `large` makes it long enough to need three chunks. */
function makeSession({ large = false, expired = false, who = "Sam Tillery" } = {}): Session {
  const exp = expired ? now() - 60 : now() + 3600;
  const id = randomUUID();
  const email = `${who.toLowerCase().replace(" ", ".")}@example.com`;
  const notes: string[] = [];
  const s: Session = {
    access_token: makeAccessToken(id, exp),
    refresh_token: b64u(randomBytes(9)),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    user: {
      id, aud: "authenticated", role: "authenticated", email,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: large ? { full_name: who, notes } : { full_name: who },
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    },
  };
  // Long enough for exactly three chunks: past two, with room to spare under three.
  while (large && storedLength(s) <= 2 * CHUNK + 600) notes.push(`Stand-in note ${notes.length} for ${who}`);
  return s;
}
const storedLength = (s: Session) => ("base64-" + b64u(JSON.stringify(s))).length;

/** THE STORED FORMAT, built here and not by the library: `base64-` + base64url(JSON), one cookie
 *  named KEY when it fits, else KEY.0, KEY.1, … of at most CHUNK characters each. */
function storedCookies(session: Session) {
  const value = "base64-" + b64u(JSON.stringify(session));
  if (value.length <= CHUNK) return [{ name: KEY, value }];
  const out: { name: string; value: string }[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) out.push({ name: `${KEY}.${i}`, value: value.slice(i * CHUNK, (i + 1) * CHUNK) });
  return out;
}

/** Reads what the library WROTE by the same format, so a write in another format fails the reader. */
function decodeStored(cookies: { name: string; value: string }[]): Session | null {
  const live = cookies.filter((c) => SESSION_NAME.test(c.name) && c.value !== "");
  const whole = live.find((c) => c.name === KEY);
  const chunks = live.filter((c) => c.name !== KEY).sort((a, b) => Number(a.name.split(".").pop()) - Number(b.name.split(".").pop()));
  const value = whole ? whole.value : chunks.map((c) => c.value).join("");
  if (!value) return null;
  expect(value.startsWith("base64-")).toBe(true);
  return JSON.parse(Buffer.from(value.slice("base64-".length), "base64url").toString("utf8"));
}

// ── the one network stub ───────────────────────────────────────────────────────────────────────────
type Req = { method: string; url: URL; headers: Headers; body: any };
type Route = (r: Req) => Response | Promise<Response>;
let routes: Record<string, Route> = {};
let requests: string[] = [];
let unanswered: string[] = [];

// The auth server names its API version on every answer; auth-js reads an error's `code` only when it does.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
const netErr = () => { throw new TypeError("fetch failed"); };

async function stubFetch(input: unknown, init: any = {}) {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const grant = url.searchParams.get("grant_type");
  const key = `${method} ${url.pathname}${grant ? `?grant_type=${grant}` : ""}`;
  requests.push(key);
  const route = url.origin === PROJECT_URL ? routes[key] : undefined;
  if (!route) {
    unanswered.push(`${method} ${url.origin}${url.pathname}`);
    throw new Error(`no network in this file: ${key}`);
  }
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  return route({ method, url, headers: new Headers(init.headers), body });
}

/** The auth server's /user answer: the person, for exactly the access tokens it was given. */
function userRoute(...sessions: Session[]): Route {
  return ({ headers }) => {
    const s = sessions.find((x) => headers.get("authorization") === `Bearer ${x.access_token}`);
    return s ? json(200, s.user) : json(401, { code: "bad_jwt", msg: "stand-in: a token this test never issued" });
  };
}

/** The refresh grant: the new session, for exactly the stored refresh token. */
function refreshRoute(stored: Session, next: Session): Route {
  return ({ body }) => (body?.refresh_token === stored.refresh_token ? json(200, next) : json(400, { code: "refresh_token_not_found", msg: "stand-in" }));
}

const request = (path: string, cookies: { name: string; value: string }[] = []) =>
  new NextRequest(`${APP}${path}`, { headers: cookies.length ? { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } : {} });

/** A jar shaped like next/headers' cookie store: a write of "" with maxAge 0 deletes. */
function makeJar(initial: { name: string; value: string }[] = []) {
  const cookies = new Map(initial.map((c) => [c.name, c.value]));
  const writes: { name: string; value: string; options: any }[] = [];
  return {
    writes,
    all: () => [...cookies].map(([name, value]) => ({ name, value })),
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    set(name: string, value: string, options?: any) {
      writes.push({ name, value, options });
      if (value === "" || options?.maxAge === 0) cookies.delete(name);
      else cookies.set(name, value);
    },
  };
}

beforeEach(() => {
  routes = {};
  requests = [];
  unanswered = [];
  h.setAllCalls.length = 0;
  h.jar = null;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROJECT_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", `stand-in-anon-${randomBytes(6).toString("hex")}`);
  vi.stubGlobal("fetch", vi.fn(stubFetch));
  // Both pairs warn on the server when getSession's user is read. Silenced.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  try {
    // The stub's throw would be swallowed by auth-js as a "retryable" error: an unanswered URL fails HERE.
    expect(unanswered, "a request this test never allowed").toEqual([]);
    // RULE 3 holds in every test of the file: see the describe block of that name.
    for (const args of h.setAllCalls) expectCookieWriterArgs(args);
  } finally {
    h.jar = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

/** RULE 3: one argument, or two where the second carries only cache headers.
 *  0.5.2 passes one argument (the cookies). 0.12.7 passes a second: {} or the three cache headers,
 *  which this app's setAll drops today. Anything else is a new argument the app would drop silently. */
function expectCookieWriterArgs(args: unknown[]) {
  expect(args.length === 1 || args.length === 2, `setAll called with ${args.length} arguments`).toBe(true);
  expect(Array.isArray(args[0])).toBe(true);
  if (args.length === 2) {
    expect(args[1]).toBeTypeOf("object");
    for (const k of Object.keys(args[1] as object)) expect(CACHE_HEADERS, `setAll's second argument carries ${k}`).toContain(k);
  }
}

/** The options every non-empty session cookie is written with: what the phone and the app rely on. */
function expectSessionCookieOptions(o: any) {
  expect(o.path).toBe("/");
  expect(o.sameSite).toBe("lax");
  expect(o.httpOnly ?? false).toBe(false);
  expect(o.maxAge).toBe(34560000);
}

/** Drives a promise to the end under fake timers (auth-js waits between refresh retries). */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 600 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

// ── 1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("1. a person who is signed in stays signed in (the stored format is read back)", () => {
  const browserClients = new WeakSet<object>(); // every browser client a case built, to prove the next one is new
  for (const large of [false, true]) {
    const label = large ? "chunked into .0 .1 .2" : "one cookie";

    it(`the middleware's updateSession: ${label} — the stored access token is the one sent, the page goes through, no cookie written`, async () => {
      const s = makeSession({ large });
      const cookies = storedCookies(s);
      expect(cookies.length).toBe(large ? 3 : 1);
      routes["GET /auth/v1/user"] = userRoute(s);
      const res = await updateSession(request(SIGNED_IN_PAGE, cookies));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("location")).toBeNull();
      // The ONLY request is the check of the stored access token: no refresh, nothing else.
      expect(requests).toEqual(["GET /auth/v1/user"]);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(h.setAllCalls).toEqual([]);
    });

    it(`server.ts createClient: ${label} — the same user and the same tokens, no network, no write`, async () => {
      const s = makeSession({ large });
      const jar = makeJar(storedCookies(s));
      h.jar = jar;
      const sb = await createServerSb();
      const { data, error } = await sb.auth.getSession();
      expect(error).toBeNull();
      expect(data.session?.access_token).toBe(s.access_token);
      expect(data.session?.refresh_token).toBe(s.refresh_token);
      expect(data.session?.user.id).toBe(s.user.id);
      expect(data.session?.user.email).toBe(s.user.email);
      expect(requests).toEqual([]);
      expect(jar.writes).toEqual([]);
      expect(h.setAllCalls).toEqual([]);
    });

    it(`client.ts createClient (document.cookie): ${label} — the same user and the same tokens, no network, no write`, async () => {
      const s = makeSession({ large });
      const cookieHeader = storedCookies(s).map((c) => `${c.name}=${c.value}`).join("; ");
      const writes: string[] = [];
      const document = {
        get cookie() { return cookieHeader; },
        set cookie(v: string) { writes.push(v); },
        visibilityState: "visible",
        addEventListener() {}, removeEventListener() {},
      };
      vi.stubGlobal("document", document);
      vi.stubGlobal("window", { document, location: new URL(`${APP}${SIGNED_IN_PAGE}`), addEventListener() {}, removeEventListener() {} });
      vi.stubGlobal("BroadcastChannel", undefined); // Node has one; a browser client would open it and hold the process
      // A FRESH client for each case (see the shim in the @supabase/ssr mock): the chunked case must
      // start from chunked cookies, not reuse the client the one-cookie case built.
      const sb = createBrowserSb();
      expect(browserClients.has(sb), "a browser client built by an earlier case").toBe(false);
      browserClients.add(sb);
      try {
        const { data, error } = await sb.auth.getSession();
        expect(error).toBeNull();
        expect(data.session?.access_token).toBe(s.access_token);
        expect(data.session?.refresh_token).toBe(s.refresh_token);
        expect(data.session?.user.id).toBe(s.user.id);
        expect(requests).toEqual([]);
        expect(writes).toEqual([]);
      } finally {
        await sb.auth.stopAutoRefresh();
      }
    });
  }
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────────────
describe("2. what the middleware does with each answer", () => {
  it("a valid chunked session: through, no cookie changed", async () => {
    const s = makeSession({ large: true });
    routes["GET /auth/v1/user"] = userRoute(s);
    const res = await updateSession(request(SIGNED_IN_PAGE, storedCookies(s)));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.cookies.getAll()).toEqual([]);
  });

  it("an expired token and a good refresh: through, the new session written with the app's options, stale chunks cleared with maxAge 0", async () => {
    const old = makeSession({ large: true, expired: true });
    const next = makeSession({ large: false });
    routes["POST /auth/v1/token?grant_type=refresh_token"] = refreshRoute(old, next);
    routes["GET /auth/v1/user"] = userRoute(next);
    const res = await updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
    // Exactly ONE refresh sent: a refresh token sent twice could be revoked by the auth server's reuse rule.
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual(["POST /auth/v1/token?grant_type=refresh_token"]);
    const written = res.cookies.getAll();
    // The new session fits one cookie; the three stale chunks are each sent maxAge 0.
    // (0.12.7 skips a cookie whose value did not change and clears only cookies that exist; here
    //  every one changed or existed, so both pairs send the same four.)
    const live = written.filter((c) => c.value !== "");
    expect(live.map((c) => c.name)).toEqual([KEY]);
    for (const c of live) expectSessionCookieOptions(c);
    const cleared = written.filter((c) => c.value === "").map((c) => c.name).sort();
    expect(cleared).toEqual([`${KEY}.0`, `${KEY}.1`, `${KEY}.2`]);
    for (const c of written.filter((x) => x.value === "")) expect(c.maxAge).toBe(0);
    const stored = decodeStored(live);
    expect(stored?.access_token).toBe(next.access_token);
    expect(stored?.refresh_token).toBe(next.refresh_token);
    expect(stored?.user.id).toBe(next.user.id);
  });

  it("an expired token refreshed into a longer session: chunks of at most 3180, the old single cookie cleared", async () => {
    const old = makeSession({ expired: true });
    const next = makeSession({ large: true });
    routes["POST /auth/v1/token?grant_type=refresh_token"] = refreshRoute(old, next);
    routes["GET /auth/v1/user"] = userRoute(next);
    const res = await updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual(["POST /auth/v1/token?grant_type=refresh_token"]);
    const written = res.cookies.getAll();
    const live = written.filter((c) => c.value !== "");
    expect(live.map((c) => c.name).sort()).toEqual([`${KEY}.0`, `${KEY}.1`, `${KEY}.2`]);
    for (const c of live) {
      expect(c.value.length).toBeLessThanOrEqual(CHUNK);
      expectSessionCookieOptions(c);
    }
    expect(written.filter((c) => c.value === "").map((c) => [c.name, c.maxAge])).toEqual([[KEY, 0]]);
    expect(decodeStored(live)?.refresh_token).toBe(next.refresh_token);
  });

  for (const blip of ["503", "network error"] as const) {
    it(`a refresh that fails with a ${blip}: the cookies are kept and the page is Try Again (503), never the login screen`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const old = makeSession({ large: true, expired: true });
      routes["POST /auth/v1/token?grant_type=refresh_token"] = blip === "503" ? () => json(503, { msg: "stand-in upstream" }) : netErr;
      const res = await settle(updateSession(request(SIGNED_IN_PAGE, storedCookies(old))));
      // middleware.ts: no user, not public, check.failed → the sign-in-check page, status 503.
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("set-cookie")).toBeNull();
      // Nothing was cleared: auth-js keeps a session whose refresh only blipped (both pairs).
      expect(h.setAllCalls.flatMap((a) => a[0] as { value: string }[]).filter((c) => c.value === "")).toEqual([]);
      expect(requests.every((r) => r === "POST /auth/v1/token?grant_type=refresh_token")).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
    });
  }

  // A 500 is a blip too. Measured by skeptic #95: on 2.107 a 500 refresh was not retried (one
  // request); from 2.119 it is retried like a 503, eight requests over about 25 seconds, and the
  // session is kept either way. Kept means the browser's cookies: 2.107 also dropped its own copy
  // (it asked setAll to clear the chunks), but the Try Again page carries none of those writes;
  // 2.119 asks to clear nothing. Only the outcome is held here, not the count, the time or setAll.
  it("a refresh that fails with a 500: the cookies are kept and the page is Try Again (503), never the login screen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const old = makeSession({ large: true, expired: true });
    routes["POST /auth/v1/token?grant_type=refresh_token"] = () => json(500, { code: "unexpected_failure", msg: "stand-in" });
    const res = await settle(updateSession(request(SIGNED_IN_PAGE, storedCookies(old))));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.cookies.getAll()).toEqual([]);
  });

  it("a refused refresh token: the login screen, and the session cookies cleared (on the login page's own pass)", async () => {
    const old = makeSession({ large: true, expired: true });
    routes["POST /auth/v1/token?grant_type=refresh_token"] = () => json(400, { code: "refresh_token_not_found", msg: "stand-in" });
    const res = await updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${APP}/login?next=${encodeURIComponent(SIGNED_IN_PAGE)}`);
    // The library cleared every chunk through the app's setAll, maxAge 0 (both pairs)…
    const clearedByLibrary = h.setAllCalls.flatMap((a) => a[0] as { name: string; value: string; options: any }[]).filter((c) => c.value === "");
    expect(clearedByLibrary.map((c) => c.name).sort()).toEqual([`${KEY}.0`, `${KEY}.1`, `${KEY}.2`]);
    for (const c of clearedByLibrary) expect(c.options.maxAge).toBe(0);
    // …but middleware.ts answers with a NEW redirect response, which carries none of them: the
    // browser's cookies are cleared on the next pass, the /login request, which is public and
    // returns the response the library wrote to.
    expect(res.headers.get("set-cookie")).toBeNull();
    // A refused refresh is sent once and never retried, and nothing else is asked (both pairs).
    expect(requests).toEqual(["POST /auth/v1/token?grant_type=refresh_token"]);
    h.setAllCalls.length = 0;
    const login = await updateSession(request(`/login?next=${encodeURIComponent(SIGNED_IN_PAGE)}`, storedCookies(old)));
    expect(login.headers.get("x-middleware-next")).toBe("1");
    const cleared = login.cookies.getAll();
    expect(cleared.map((c) => c.name).sort()).toEqual([`${KEY}.0`, `${KEY}.1`, `${KEY}.2`]);
    for (const c of cleared) {
      expect(c.value).toBe("");
      expect(c.maxAge).toBe(0);
    }
  });

  it("no cookie at all on a signed-in page: the login screen, no request made", async () => {
    const res = await updateSession(request(SIGNED_IN_PAGE));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${APP}/login?next=${encodeURIComponent(SIGNED_IN_PAGE)}`);
    expect(requests).toEqual([]);
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────────────
describe("3. what the library hands the app's cookie writer", () => {
  it("a refresh calls setAll with one argument, or two where the second carries only cache headers", async () => {
    const old = makeSession({ expired: true });
    const next = makeSession();
    routes["POST /auth/v1/token?grant_type=refresh_token"] = refreshRoute(old, next);
    routes["GET /auth/v1/user"] = userRoute(next);
    await updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
    expect(h.setAllCalls.length).toBeGreaterThan(0);
    for (const args of h.setAllCalls) expectCookieWriterArgs(args);
    // (afterEach applies the same rule to every setAll call in every test of this file.)
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────────────
describe("4. the emailed links still find their key", () => {
  // Since cn-v1199 the app mints and sends the code sign-in and reset emails itself (lib/auth-mail), and
  // their links are verified by token hash at /auth/confirm (the case after this one). What still walks
  // /auth/callback's PKCE exchange is sign-up's confirmation link (and any reset link sent before that
  // release); resetPasswordForEmail stands in here as the library's own way to write the verifier.
  it("the sign-up link through /auth/callback: the fixed -code-verifier cookie is stored; exchangeCodeForSession sends it and writes the session", async () => {
    const jar = makeJar();
    h.jar = jar;
    let challenge = "";
    routes["POST /auth/v1/recover"] = ({ body }) => {
      expect(body.email).toBe("dana.rook@example.com");
      challenge = body.code_challenge;
      return json(200, {});
    };
    const start = await (await createServerSb()).auth.resetPasswordForEmail("dana.rook@example.com", { redirectTo: `${APP}/auth/callback?next=/planner` });
    expect(start.error).toBeNull();
    // 0.12.7 also writes a per-flow slot and an index cookie (auth 2.111.0); 0.5.2 writes only this
    // one. The rule for both: the fixed key the callback reads (it passes no flow id) is there.
    const stored = jar.all().find((c) => c.name === `${KEY}-code-verifier`);
    expect(stored, "the fixed -code-verifier cookie").toBeDefined();
    expect(stored!.value.startsWith("base64-")).toBe(true);
    const verifier = String(JSON.parse(Buffer.from(stored!.value.slice(7), "base64url").toString("utf8"))).split("/")[0];
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);

    const session = makeSession({ who: "Dana Rook" });
    const code = randomUUID();
    let sentVerifier = "";
    routes["POST /auth/v1/token?grant_type=pkce"] = ({ body }) => {
      expect(body.auth_code).toBe(code);
      sentVerifier = body.code_verifier;
      return json(200, session);
    };
    const done = await (await createServerSb()).auth.exchangeCodeForSession(code);
    expect(done.error).toBeNull();
    expect(sentVerifier).toBe(verifier);
    const written = decodeStored(jar.all());
    expect(written?.access_token).toBe(session.access_token);
    expect(written?.user.email).toBe("dana.rook@example.com");
    for (const w of jar.writes.filter((x) => SESSION_NAME.test(x.name) && x.value !== "")) expectSessionCookieOptions(w.options);
  });

  it('the app\'s own sign-in and reset links at /auth/confirm: verifyOtp({ type: "recovery", token_hash }) through server.ts posts to /verify once and writes the session', async () => {
    const jar = makeJar();
    h.jar = jar;
    const tokenHash = randomBytes(28).toString("hex");
    const session = makeSession({ who: "Sam Tillery" });
    const bodies: any[] = [];
    routes["POST /auth/v1/verify"] = ({ body }) => {
      bodies.push(body);
      return body?.token_hash === tokenHash && body?.type === "recovery" ? json(200, session) : json(403, { code: "otp_expired", msg: "stand-in" });
    };
    const { error } = await (await createServerSb()).auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    expect(error).toBeNull();
    expect(requests).toEqual(["POST /auth/v1/verify"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ type: "recovery", token_hash: tokenHash });
    const written = decodeStored(jar.all());
    expect(written?.access_token).toBe(session.access_token);
    expect(written?.user.email).toBe("sam.tillery@example.com");
    for (const w of jar.writes.filter((x) => SESSION_NAME.test(x.name) && x.value !== "")) expectSessionCookieOptions(w.options);
    // A used or expired hash: an error, and no session written.
    const empty = makeJar();
    h.jar = empty;
    const used = await (await createServerSb()).auth.verifyOtp({ type: "recovery", token_hash: randomBytes(28).toString("hex") });
    expect(used.error).not.toBeNull();
    expect(decodeStored(empty.all())).toBeNull();
  });

  it('signOut({ scope: "local" }) through server.ts leaves no session cookie of any chunk (the deactivation gate relies on it)', async () => {
    const s = makeSession({ large: true, who: "Dana Rook" });
    const jar = makeJar(storedCookies(s));
    h.jar = jar;
    routes["POST /auth/v1/logout"] = () => new Response(null, { status: 204 });
    const { error } = await (await createServerSb()).auth.signOut({ scope: "local" });
    expect(error).toBeNull();
    expect(jar.all().filter((c) => c.name === KEY || c.name.startsWith(`${KEY}.`))).toEqual([]);
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────────────
describe("5. checkUser over a real client tells a blip from a refusal", () => {
  const cases: [string, Route, "failed" | "refused" | "none"][] = [
    ["500", () => json(500, { code: "unexpected_failure", msg: "stand-in" }), "failed"],
    ["503", () => json(503, { msg: "stand-in" }), "failed"],
    ["502 HTML page", () => new Response("<html><body>Bad gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }), "failed"],
    ["429", () => json(429, { code: "over_request_rate_limit", msg: "stand-in" }), "failed"],
    ["network error", netErr, "failed"],
    ["401", () => json(401, { code: "bad_jwt", msg: "stand-in" }), "refused"],
    ["403", () => json(403, { code: "bad_jwt", msg: "stand-in" }), "refused"],
    // Both pairs turn a 403 coded session_not_found into "no session" (auth-js fetch.ts), so the
    // check says "none": still a sign-out, without the error kept for the report.
    ["403 session_not_found", () => json(403, { code: "session_not_found", msg: "stand-in" }), "none"],
  ];
  for (const [name, route, reason] of cases) {
    it(`a ${name} from the auth server is "${reason}"`, async () => {
      const s = makeSession();
      h.jar = makeJar(storedCookies(s));
      routes["GET /auth/v1/user"] = route;
      const check = await checkUser(await createServerSb(), { retryMs: 0 });
      expect(check.reason).toBe(reason);
      expect(check.failed).toBe(reason === "failed");
      expect(check.user).toBeNull();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r === "GET /auth/v1/user")).toBe(true);
    });
  }

  it('a 200 from the auth server is "ok", the person the stored token names', async () => {
    const s = makeSession();
    h.jar = makeJar(storedCookies(s));
    routes["GET /auth/v1/user"] = userRoute(s);
    const check = await checkUser(await createServerSb(), { retryMs: 0 });
    expect(check.reason).toBe("ok");
    expect(check.user?.id).toBe(s.user.id);
  });
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────────────
describe("6. the sign-in check answers within CHECK_DEADLINE_MS, through the real library (cn-v1198)", () => {
  const D = CHECK_DEADLINE_MS;
  const REFRESH = "POST /auth/v1/token?grant_type=refresh_token";
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => { process.off("unhandledRejection", onUnhandled); });
  const watch = <T,>(p: Promise<T>) => {
    const w = { done: false };
    p.then(() => (w.done = true), () => (w.done = true));
    return w;
  };
  /** Two real turns of the event loop (setImmediate is not faked): when Node reports an unhandled rejection. */
  const flushReal = async () => { for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r)); };
  const expectTryAgain = (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  };

  /** An expired session and an auth server answering 503 to every refresh. */
  const allRefreshes503 = () => {
    const old = makeSession({ large: true, expired: true });
    routes[REFRESH] = () => json(503, { msg: "stand-in upstream" });
    return updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
  };

  it("an auth server answering 503 to every refresh: the Try Again page AT 8 s, not before, after more than one and fewer than eight refreshes", async () => {
    const p = allRefreshes503();
    const w = watch(p);
    await vi.advanceTimersByTimeAsync(D - 1);
    expect(w.done, "answered before the deadline").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.done, "not answered at the deadline").toBe(true);
    const res = await p;
    expectTryAgain(res);
    expect(res.cookies.getAll()).toEqual([]);
    // Observed on 2.119.2: 6 refreshes by 8 s (attempts start at 0, 0.2, 0.6, 1.4, 3.0, 6.2 s).
    const sent = requests.filter((r) => r === REFRESH).length;
    expect(sent).toBeGreaterThan(1);
    expect(sent).toBeLessThan(8);
    expect(requests.every((r) => r === REFRESH)).toBe(true);
  });

  it("after that answer, 30 more seconds: the look left behind retries on and ends, nothing throws, the answer still carries no cookie", async () => {
    const p = allRefreshes503();
    await vi.advanceTimersByTimeAsync(D);
    const res = await p;
    expectTryAgain(res);
    const sent = requests.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await flushReal();
    expect(unhandled).toEqual([]);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.cookies.getAll()).toEqual([]);
    // Observed on 2.119.2: the library's own loop goes on to its 8th refresh after the answer was given.
    expect(requests.length).toBeGreaterThanOrEqual(sent);
    expect(requests.every((r) => r === REFRESH)).toBe(true);
  });

  // A 503 writes no cookie, so the case above cannot fail on a late write. Here the answer arrives
  // LATE and DOES write (skeptic #96): the library calls the cookie writer after the middleware has
  // answered, and the response already returned must carry none of it.
  for (const late of ["a good session", "a 400 refusal"] as const) {
    it(`a refresh answered at 9 s with ${late}: Try Again at 8 s, the late cookie write reaches nothing returned`, async () => {
      const old = makeSession({ large: true, expired: true });
      const next = makeSession({ large: false });
      routes[REFRESH] = () => new Promise<Response>((r) => setTimeout(() => r(
        late === "a good session" ? json(200, next) : json(400, { code: "refresh_token_not_found", msg: "stand-in" }),
      ), 9000));
      // After a late success the look left behind checks the new token once (harmless: no write).
      routes["GET /auth/v1/user"] = userRoute(next);
      const p = updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
      await vi.advanceTimersByTimeAsync(D);
      const res = await p;
      expectTryAgain(res);
      expect(h.setAllCalls, "a cookie write before the answer was given").toEqual([]);
      const headersThen = [...res.headers];
      await vi.advanceTimersByTimeAsync(2000);
      await flushReal();
      // The case is real: the library DID call the cookie writer, after the answer.
      const lateWrites = h.setAllCalls.flatMap((a) => a[0] as { name: string; value: string }[]);
      expect(lateWrites.length, "the library never wrote late: this case proves nothing").toBeGreaterThan(0);
      if (late === "a good session") expect(lateWrites.some((c) => c.name === KEY && c.value !== "")).toBe(true);
      else expect(lateWrites.filter((c) => c.value === "").map((c) => c.name).sort()).toEqual([`${KEY}.0`, `${KEY}.1`, `${KEY}.2`]);
      // …and the response that was returned is unchanged.
      expect([...res.headers]).toEqual(headersThen);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.cookies.getAll()).toEqual([]);
      expect(unhandled).toEqual([]);
      expect(vi.getTimerCount(), "a timer left pending").toBe(0);
    });
  }

  it("a refresh the server answers on its THIRD attempt (503, 503, then a good session): through with the new session cookies, well inside the deadline", async () => {
    const old = makeSession({ large: true, expired: true });
    const next = makeSession({ large: false });
    let tries = 0;
    const good = refreshRoute(old, next);
    routes[REFRESH] = (r) => (++tries < 3 ? json(503, { msg: "stand-in upstream" }) : good(r));
    routes["GET /auth/v1/user"] = userRoute(next);
    const p = updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
    const w = watch(p);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.done, "a working refresh was not done within 1 s").toBe(true);
    const res = await p;
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual([REFRESH, REFRESH, REFRESH]);
    // The same writes as a first-try refresh (case 2): the new session in one cookie, the stale chunks cleared.
    const written = res.cookies.getAll();
    const live = written.filter((c) => c.value !== "");
    expect(live.map((c) => c.name)).toEqual([KEY]);
    for (const c of live) expectSessionCookieOptions(c);
    expect(written.filter((c) => c.value === "").map((c) => c.name).sort()).toEqual([`${KEY}.0`, `${KEY}.1`, `${KEY}.2`]);
    const stored = decodeStored(live);
    expect(stored?.access_token).toBe(next.access_token);
    expect(stored?.refresh_token).toBe(next.refresh_token);
    expect(vi.getTimerCount(), "the deadline's timer left pending").toBe(0);
  });

  it("a refresh request that is NEVER answered: the Try Again page at 8 s", async () => {
    const old = makeSession({ large: true, expired: true });
    routes[REFRESH] = () => new Promise<Response>(() => {});
    const p = updateSession(request(SIGNED_IN_PAGE, storedCookies(old)));
    const w = watch(p);
    await vi.advanceTimersByTimeAsync(D - 1);
    expect(w.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.done, "not answered at the deadline").toBe(true);
    expectTryAgain(await p);
    expect(requests).toEqual([REFRESH]);
    await flushReal();
    expect(unhandled).toEqual([]);
  });

  // ── inside 6, to share its clock and its watchers ──
  describe("a failed check sends nothing the library wrote, on any path (cn-v1198, skeptic #96)", () => {
    // Three answers to a refresh that auth-js does NOT retry. With the access token run out, it drops
    // its copy of the session and writes that removal through the app's setAll; none is a refusal.
    const notRetried: [string, Route][] = [
      // The auth server's answer when a refresh waited 5 s on another refresh's lock of the same session.
      ["a 409 conflict", () => json(409, { code: 409, error_code: "conflict", msg: "stand-in: another refresh holds this session" })],
      ["a 429", () => json(429, { code: "over_request_rate_limit", msg: "stand-in" })],
      // A gateway's page in place of JSON: auth-js hands it over as AuthUnknownError.
      ["an HTML 403 page", () => new Response("<html><body>Forbidden</body></html>", { status: 403, headers: { "content-type": "text/html" } })],
    ];
    const expiredWith = (path: string, answer: Route) => {
      const old = makeSession({ large: true, expired: true });
      routes[REFRESH] = answer;
      const req = request(path, storedCookies(old));
      return { req, p: settle(updateSession(req)) };
    };

    it("a 409 on a signed-in page: the Try Again page, not the login screen; sent once", async () => {
      const res = await expiredWith(SIGNED_IN_PAGE, notRetried[0][1]).p;
      expectTryAgain(res);
      expect(res.cookies.getAll()).toEqual([]);
      expect(requests).toEqual([REFRESH]);
    });

    it("a 409 on an /api/ path: the 503 to retry, not the 401", async () => {
      const res = await expiredWith("/api/jobs", notRetried[0][1]).p;
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("Couldn't check your sign-in just now — try again.");
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    for (const path of ["/login", "/"]) {
      for (const [name, answer] of notRetried) {
        it(`${name} on the public path ${path}: through, and the library's removal of the session is NOT sent`, async () => {
          const { req, p } = expiredWith(path, answer);
          const res = await p;
          expect(res.headers.get("x-middleware-next")).toBe("1");
          expect(res.headers.get("location")).toBeNull();
          expect(res.headers.get("set-cookie")).toBeNull();
          expect(res.cookies.getAll()).toEqual([]);
          // The case is real: the library DID write a removal of every chunk, through the app's setAll…
          const removed = h.setAllCalls.flatMap((a) => a[0] as { name: string; value: string }[]).filter((c) => c.value === "");
          expect(removed.map((c) => c.name).sort()).toEqual([`${KEY}.0`, `${KEY}.1`, `${KEY}.2`]);
          expect(req.cookies.get(`${KEY}.0`)?.value, "the request's own cookie was emptied by that write").toBe("");
          expect(requests).toEqual([REFRESH]);
          // …and the check was a FAILED one, not a refusal: the same answer on a signed-in page is Try Again.
          h.setAllCalls.length = 0;
          requests = [];
          expectTryAgain(await expiredWith(SIGNED_IN_PAGE, answer).p);
        });
      }
    }

    it("the deadline on a public path: a refresh answered 503 for ever, on /login, goes through at 8 s with no cookie", async () => {
      const old = makeSession({ large: true, expired: true });
      routes[REFRESH] = () => json(503, { msg: "stand-in upstream" });
      const p = updateSession(request("/login", storedCookies(old)));
      const w = watch(p);
      await vi.advanceTimersByTimeAsync(D - 1);
      expect(w.done, "answered before the deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.done, "not answered at the deadline").toBe(true);
      const res = await p;
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.cookies.getAll()).toEqual([]);
    });

    // The guard that this rule did not go too far, a REFUSED refresh still clearing the session on
    // /login, is the case of group 2 "a refused refresh token: … (on the login page's own pass)".
  });
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────────────
describe("7. Change My Password signs the OTHER sessions out and keeps this one (cn-v1202)", () => {
  // set-password/actions updateMyPassword calls signOut({ scope: "others" }) on server.ts's client after
  // a save. auth-js removes the stored session only for "local" and "global"; "others" asks the auth
  // server to end every other session, by one POST to /logout?scope=others with this session's token.
  for (const large of [false, true]) {
    it(`server.ts createClient, ${large ? "chunked" : "one cookie"}: one request, to the logout endpoint with scope=others and this access token; no cookie written or cleared`, async () => {
      const s = makeSession({ large, who: "Larkspur Meadow" });
      const cookies = storedCookies(s);
      const jar = makeJar(cookies);
      h.jar = jar;
      const seen: { scope: string | null; auth: string | null }[] = [];
      routes["POST /auth/v1/logout"] = ({ url, headers }) => {
        seen.push({ scope: url.searchParams.get("scope"), auth: headers.get("authorization") });
        return new Response(null, { status: 204, headers: { "x-supabase-api-version": "2024-01-01" } });
      };
      const { error } = await (await createServerSb()).auth.signOut({ scope: "others" });
      expect(error).toBeNull();
      expect(requests).toEqual(["POST /auth/v1/logout"]);
      expect(seen).toEqual([{ scope: "others", auth: `Bearer ${s.access_token}` }]);
      expect(jar.writes).toEqual([]);
      expect(jar.all()).toEqual(cookies);
      expect(decodeStored(jar.all())?.access_token).toBe(s.access_token);
    });
  }
});
