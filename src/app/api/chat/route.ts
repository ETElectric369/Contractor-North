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

  let body: { messages: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => m.content?.trim())
    .slice(-20) // keep context bounded
    .map((m) => ({ role: m.role, content: m.content }));

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
          system: ASSISTANT_SYSTEM_PROMPT,
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
