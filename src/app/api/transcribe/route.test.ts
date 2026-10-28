import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sttCodes, transcribeLang } from "./lang";

/**
 * NORT HEARS SPANISH (cn-v1138). /api/transcribe was hard-locked to English for everyone (Scribe
 * language_code "eng", Whisper language "en"; the route read no profile). Now the language is the
 * PROFILE's — read on the signed-in session, never auto-detected, never beaten by the `lang` field
 * the client sends (voice-stream's hint) — and both providers are told it outright, every time.
 * Driven through the real POST with the gate, the profile read and fetch faked; the FormData each
 * provider receives is what is asserted on.
 */
const db = vi.hoisted(() => ({ language: "en" as string | null, row: true, user: true }));
const net = vi.hoisted(() => ({ calls: [] as { url: string; fields: Record<string, string> }[], elFails: false }));
vi.mock("@/lib/voice-gate", () => ({ voiceGate: vi.fn(async () => null) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: db.user ? { id: "user-1" } : null } }) },
    from: () => {
      const q: any = {};
      q.select = () => q;
      q.eq = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => ({ data: db.row ? { language: db.language } : null, error: null });
      return q;
    },
  })),
}));

const fields = (body: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  (body as FormData).forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
};

async function post(lang?: string) {
  const fd = new FormData();
  fd.append("audio", new Blob([new Uint8Array(2000)], { type: "audio/webm" }), "turn.webm");
  if (lang !== undefined) fd.append("lang", lang);
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/api/transcribe", { method: "POST", body: fd }));
}

describe("the transcriber listens in the profile's language", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    db.language = "en";
    db.row = true;
    db.user = true;
    net.calls = [];
    net.elFails = false;
    process.env.ELEVENLABS_API_KEY = "test-key-el";
    process.env.OPENAI_API_KEY = "test-key-oa";
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      net.calls.push({ url: u, fields: fields(init?.body) });
      if (u.includes("elevenlabs") && net.elFails) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ text: "hola" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("a Spanish profile: Scribe is told spa, and Whisper es when Scribe fails", async () => {
    db.language = "es";
    net.elFails = true;
    const r = await post();
    expect(r.status).toBe(200);
    expect(net.calls.map((c) => [c.url.includes("elevenlabs") ? "el" : "oa", c.fields.language_code ?? c.fields.language])).toEqual([["el", "spa"], ["oa", "es"]]);
  });

  it("an English profile: eng, then en — and never a request with no language at all", async () => {
    net.elFails = true;
    await post();
    expect(net.calls).toHaveLength(2);
    for (const c of net.calls) expect(c.fields.language_code ?? c.fields.language, c.url).toBeTruthy();
    expect(net.calls[0].fields.language_code).toBe("eng");
    expect(net.calls[1].fields.language).toBe("en");
  });

  it("a lang field never beats the profile: es on the wire, en on the profile → eng", async () => {
    await post("es");
    expect(net.calls[0].fields.language_code).toBe("eng");
    db.language = "es";
    net.calls = [];
    await post("en");
    expect(net.calls[0].fields.language_code).toBe("spa");
  });

  it("with no profile answer the field decides (es-US counts as Spanish); with neither, English", async () => {
    db.row = false;
    await post("es-US");
    expect(net.calls[0].fields.language_code).toBe("spa");
    net.calls = [];
    await post();
    expect(net.calls[0].fields.language_code).toBe("eng");
  });

  it("what it says when it could not hear is in the person's language", async () => {
    db.language = "es";
    net.elFails = true;
    delete process.env.OPENAI_API_KEY;
    const r = await post();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("No se escuchó. Inténtalo de nuevo, o escríbelo.");
  });

  it("the resolver on its own: profile first, field second, English last; the provider codes by language", () => {
    expect(transcribeLang("es", "en")).toBe("es");
    expect(transcribeLang("en", "es")).toBe("en");
    expect(transcribeLang(null, "es-MX")).toBe("es");
    expect(transcribeLang(null, "pt")).toBe("en");
    expect(transcribeLang(null, null)).toBe("en");
    expect(sttCodes("es")).toEqual({ elevenlabs: "spa", whisper: "es" });
    expect(sttCodes("en")).toEqual({ elevenlabs: "eng", whisper: "en" });
  });
});
