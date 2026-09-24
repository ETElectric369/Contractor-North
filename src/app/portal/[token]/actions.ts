"use server";

import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";

/** Link unfurlers that fetch a page to draw a preview card, and crawlers. They are not the
 *  customer opening it. */
const PREVIEWER =
  /facebookexternalhit|facebot|twitterbot|slackbot|discordbot|linkedinbot|whatsapp|telegrambot|skypeuripreview|googlebot|bingbot|crawler|spider|headless/i;

/**
 * Stamp Last Opened for a portal link (0298's portal_record_open, service role only). The token is
 * the whole key, exactly as on the page: an unknown or turned-off token updates nothing, and the
 * function writes at most once a minute per link. Nothing comes back to the caller.
 */
export async function recordPortalOpen(token: string): Promise<void> {
  try {
    if (typeof token !== "string" || !/^[0-9a-f]{32,128}$/i.test(token)) return;
    const ua = (await headers()).get("user-agent") ?? "";
    if (!ua || PREVIEWER.test(ua)) return;
    await createServiceClient().rpc("portal_record_open", { p_token: token });
  } catch {
    /* best-effort: never show the customer a stamp failure */
  }
}
