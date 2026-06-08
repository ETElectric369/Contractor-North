import { createClient } from "@/lib/supabase/server";
import {
  getAnthropic,
  DEFAULT_MODEL,
  ASSISTANT_SYSTEM_PROMPT,
} from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 60;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: Request) {
  // Require a signed-in user.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Respond in the user's preferred language.
  const { data: prof } = await supabase
    .from("profiles")
    .select("language")
    .eq("id", user.id)
    .maybeSingle();
  const systemPrompt =
    prof?.language === "es"
      ? ASSISTANT_SYSTEM_PROMPT +
        "\n\nThe user's preferred language is Spanish (español). Respond in Spanish unless the user writes to you in English. Use clear, friendly Spanish suitable for an electrician in the field."
      : ASSISTANT_SYSTEM_PROMPT;

  let body: { messages: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Bound input to control cost/abuse: cap message count and per-message length.
  const MAX_MESSAGES = 20;
  const MAX_CHARS = 8000;
  const messages = (body.messages ?? [])
    .filter((m) => m.content?.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, MAX_CHARS),
    }));

  if (messages.length === 0) {
    return new Response("No messages", { status: 400 });
  }

  let client;
  try {
    client = getAnthropic();
  } catch {
    return new Response(
      "AI is not configured. Add ANTHROPIC_API_KEY to your environment.",
      { status: 503 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const anthropicStream = client.messages.stream({
          model: DEFAULT_MODEL,
          max_tokens: 2048,
          system: systemPrompt,
          messages,
        });

        anthropicStream.on("text", (text) => {
          controller.enqueue(encoder.encode(text));
        });

        await anthropicStream.finalMessage();
        controller.close();
      } catch (e: any) {
        controller.enqueue(
          encoder.encode(`\n\n[Error: ${e?.message ?? "stream failed"}]`),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
