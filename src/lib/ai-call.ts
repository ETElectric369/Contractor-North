import type Anthropic from "@anthropic-ai/sdk";
import type { FallbackFields } from "@/lib/ai-cost";

/**
 * ONE NON-STREAMING CALL, ON THE SURFACE THE REQUEST NEEDS (the SDK half, cn-v1142).
 *
 * `betas` and `fallbacks` (ai-cost fallbacksFor) are typed only on client.beta.messages, which also
 * sends the anthropic-beta header; the stable client.messages types neither. So a request carrying
 * either rides the beta surface and every other request rides the stable one, and no call site has
 * to know which. The beta message is the same wire shape with more block kinds typed; every caller
 * reads content, stop_reason, usage and model, which the two share. This is the non-streaming twin
 * of openTurn in lib/nort/replay (the stream), and keeps its one seam: the stable types let
 * output_config be null, the beta ones don't, so a null is dropped before the beta call.
 */
export type AiCreateParams = Anthropic.MessageCreateParamsNonStreaming & FallbackFields;

/** The SDK's per-request options (a clock, a retry count), passed through to whichever surface runs. */
export type AiRequestOptions = Parameters<Anthropic["messages"]["create"]>[1];

export async function aiCreate(client: Anthropic, params: AiCreateParams, options?: AiRequestOptions): Promise<Anthropic.Message> {
  if (params.betas?.length || params.fallbacks) {
    const { output_config, ...rest } = params;
    const msg = await client.beta.messages.create({ ...rest, ...(output_config ? { output_config } : {}) }, options);
    return msg as unknown as Anthropic.Message;
  }
  const { betas: _betas, fallbacks: _fallbacks, ...stable } = params;
  return options === undefined ? client.messages.create(stable) : client.messages.create(stable, options);
}
