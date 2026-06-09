import { type NextRequest, NextResponse } from "next/server";

// Candidate models to probe when the configured one fails, best → most-available.
const CANDIDATES = ["claude-opus-4-8", "claude-opus-4-5", "claude-sonnet-4-5"];

async function tryModel(key: string, model: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: "user", content: "hi" }] }),
  });
  if (r.ok) return { ok: true as const };
  const e = await r.json().catch(() => ({} as any));
  return { ok: false as const, status: r.status, type: e?.error?.type, message: e?.error?.message };
}

// Reports whether the Anthropic key is configured and (with ?live=1) whether a
// real request succeeds. On failure it probes other models so the user can see
// exactly what their deployed key can access. Never returns the key itself.
export async function GET(req: NextRequest) {
  const key = process.env.ANTHROPIC_API_KEY || "";
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  const configured = !!key;

  if (!configured) {
    return NextResponse.json({ configured: false, model, live: false, error: "ANTHROPIC_API_KEY is not set" });
  }
  if (!req.nextUrl.searchParams.get("live")) {
    return NextResponse.json({ configured: true, model, live: null });
  }

  try {
    const first = await tryModel(key, model);
    if (first.ok) return NextResponse.json({ configured: true, model, live: true });

    // 401/403 => the key itself is the problem; don't bother probing models.
    if (first.status === 401 || first.status === 403) {
      return NextResponse.json({
        configured: true, model, live: false, keyValid: false,
        error: first.message ?? "The API key was rejected (invalid or revoked).",
      });
    }

    // Otherwise the key is valid but the model may be inaccessible — probe others.
    const accessible: string[] = [];
    for (const m of CANDIDATES) {
      if (m === model) continue;
      const t = await tryModel(key, m);
      if (t.ok) accessible.push(m);
    }
    return NextResponse.json({
      configured: true, model, live: false, keyValid: true, accessible,
      error: first.message ? `model: ${first.message}` : `HTTP ${first.status}`,
    });
  } catch (e: any) {
    return NextResponse.json({ configured: true, model, live: false, error: e?.message ?? "request failed" });
  }
}
