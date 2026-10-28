import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * NORT SPEAKS SPANISH (cn-v1138). /api/tts takes `lang` beside `text`: for Spanish the ElevenLabs
 * request carries language_code "es" (Flash v2.5 is multilingual and enforces it; the voice stays),
 * and the OpenAI fallback's instructions ask for Spanish. English keeps today's request exactly —
 * no language_code, the same instructions.
 */
const net = vi.hoisted(() => ({ bodies: [] as any[] }));
vi.mock("@/lib/voice-gate", () => ({ voiceGate: vi.fn(async () => null) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}) }));

async function post(body: unknown) {
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

describe("the TTS route tells the provider the language", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    net.bodies = [];
    process.env.ELEVENLABS_API_KEY = "test-key-el";
    delete process.env.OPENAI_API_KEY;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      net.bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lang es → language_code es on the ElevenLabs request, the voice and model untouched", async () => {
    const r = await post({ text: "Entrada marcada en Larkspur.", lang: "es" });
    expect(r.status).toBe(200);
    expect(net.bodies[0].language_code).toBe("es");
    expect(net.bodies[0].model_id).toBe("eleven_flash_v2_5");
    expect(net.bodies[0].text).toBe("Entrada marcada en Larkspur.");
  });

  it("lang en (or none) → no language_code, as today", async () => {
    await post({ text: "Clocked in on Larkspur.", lang: "en" });
    await post({ text: "Clocked in on Larkspur." });
    for (const b of net.bodies) expect(b).not.toHaveProperty("language_code");
  });

  it("the OpenAI fallback asks for Spanish when the language is Spanish", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    process.env.OPENAI_API_KEY = "test-key-oa";
    await post({ text: "Hola.", lang: "es" });
    expect(net.bodies[0].instructions).toMatch(/^Habla en español/);
    await post({ text: "Hello.", lang: "en" });
    expect(net.bodies[1].instructions).toMatch(/British English/);
  });
});
