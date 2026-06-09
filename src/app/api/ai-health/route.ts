import { type NextRequest, NextResponse } from "next/server";

// Reports whether the Anthropic key is configured and (with ?live=1) whether a
// real request succeeds. Never returns the key itself.
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
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "Say OK" }] }),
    });
    if (r.ok) return NextResponse.json({ configured: true, model, live: true });
    const e = await r.json().catch(() => ({}));
    return NextResponse.json({ configured: true, model, live: false, error: e?.error?.message ?? `HTTP ${r.status}` });
  } catch (e: any) {
    return NextResponse.json({ configured: true, model, live: false, error: e?.message ?? "request failed" });
  }
}
