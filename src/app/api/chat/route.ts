import type Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import {
  getAnthropic,
  DEFAULT_MODEL,
  ASSISTANT_SYSTEM_PROMPT,
} from "@/lib/anthropic";
import { getOrgSettings } from "@/lib/org-settings";
import { DATA_TOOLS, runDataTool } from "@/lib/assistant-tools";

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

  // Respond in the user's preferred language + follow the org's quoting playbook.
  const [{ data: prof }, { data: org }] = await Promise.all([
    supabase.from("profiles").select("language").eq("id", user.id).maybeSingle(),
    supabase.from("organizations").select("id, settings").limit(1).maybeSingle(),
  ]);
  const orgId = (org as { id?: string } | null)?.id ?? null;
  const playbook = getOrgSettings((org as any)?.settings).quote_playbook?.trim();
  let systemPrompt = ASSISTANT_SYSTEM_PROMPT;
  if (playbook) {
    systemPrompt += `\n\nThis company's quoting playbook — when estimating or drafting quotes/proposals, follow it over generic assumptions:\n${playbook}`;
  }
  if (prof?.language === "es") {
    systemPrompt +=
      "\n\nThe user's preferred language is Spanish (español). Respond in Spanish unless the user writes to you in English. Use clear, friendly Spanish suitable for an electrician in the field.";
  }

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
  // Agentic loop: the model may call read-only data tools (scoped to this user's
  // org by RLS) before answering. We stream its text out in every round and run
  // tool calls in between, until it stops asking for tools.
  const MAX_ROUNDS = 6;
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (t: string) => controller.enqueue(encoder.encode(t));
      const toolsUsed = new Set<string>();
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const turn = client.messages.stream({
            model: DEFAULT_MODEL,
            max_tokens: 2048,
            system: systemPrompt,
            tools: DATA_TOOLS,
            messages: convo,
          });
          turn.on("text", (text) => emit(text));
          const final = await turn.finalMessage();
          convo.push({ role: "assistant", content: final.content });

          if (final.stop_reason !== "tool_use") break;

          const toolUses = final.content.filter(
            (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock =>
              b.type === "tool_use",
          );
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            toolsUsed.add(tu.name);
            const out = await runDataTool(tu.name, tu.input, supabase);
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: out,
            });
          }
          convo.push({ role: "user", content: results });

          if (round === MAX_ROUNDS - 1) {
            emit("\n\n[Reached the tool-call limit — answering with what I have.]");
          }
        }
        controller.close();
      } catch (e: any) {
        emit(`\n\n[Error: ${e?.message ?? "stream failed"}]`);
        controller.close();
      } finally {
        // Egress trail (framework §7/§6): when the assistant pulled org data for the
        // model, record WHICH data categories left for the provider — tool names + the
        // org/user, never the content. Best-effort; never affects the response.
        if (toolsUsed.size > 0) {
          try {
            await supabase.from("agent_audit_log").insert({
              org_id: orgId,
              user_id: user.id,
              action: "chat.query",
              risk: 0,
              effect: "read",
              ok: true,
              input_summary: { tools: [...toolsUsed] },
              source: "agent",
            });
          } catch {
            /* audit is best-effort */
          }
        }
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
