import { type NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { rateLimited } from "@/lib/rate-limit";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe, stripeLivemode } from "@/lib/stripe";
import { apnsSignCheck } from "@/lib/apns";
import { twilioAccountCheck } from "@/lib/sms";
import { geocodeAddress } from "@/lib/geocode-server";
import { GOOGLE_KEY } from "@/lib/google-server";
import { scrubSecrets } from "@/lib/scrub-secrets";

/**
 * THE KEYS-HEALTH DOOR (cn-v1129, from the 2026-10-26 deep review): one admin URL that says which
 * service key is set and, with ?live=1, which one still WORKS — so a key change is proven here,
 * minutes after the deploy, instead of by a customer saying "I paid" or a lead that never mailed.
 *
 * Platform admins only (the same gate as /api/ai-health: a rule at one layer is a convention, so
 * the route checks for itself), five looks per ten minutes per person. The answer carries
 * BOOLEANS, MODES, STATUSES AND ERROR WORDS ONLY — never a key, and every probe's error words are
 * scrubbed of every configured secret before they leave (a vendor's refusal may echo part of what
 * it was sent). Every read here is boxed: its own catch and its own clock, so one slow vendor
 * cannot hold the page and nothing throws out of the route.
 *
 * Live probes are each vendor's cheapest authenticated read: Stripe's balance AND the three plan
 * prices (free; the prices are read whatever the balance said, since a restricted key may lack
 * balance rights yet charge fine, and a key from the wrong Stripe account fails on the prices,
 * not at a checkout), Resend's domain list (free; a sending-only key is refused there and read as
 * working), Twilio's newest message, one page of one (free), one APNs provider token signed and
 * sent nowhere (proves the .p8 parses, not that Apple accepts the ids), one Google geocode (a
 * fresh address each look so a cached answer cannot stand in for the key; about half a cent),
 * and one row through the Supabase service key. Anthropic is not probed twice: /api/ai-health
 * does it. What cannot be proven by a read — the two webhook signing secrets, the cron secret —
 * is shown as set or not, and the webhook's own refusal rows sit beside it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Probe = { ok: boolean; status?: number; error?: string; note?: string };

const PROBE_TIMEOUT_MS = 6000;
const PRICE_NAMES = {
  handyman: "STRIPE_PRICE_HANDYMAN_MONTHLY",
  crew: "STRIPE_PRICE_CREW_MONTHLY",
  company: "STRIPE_PRICE_COMPANY_MONTHLY",
} as const;

const set = (name: string) => Boolean(process.env[name]);

function configured() {
  return {
    stripe: {
      secretKey: set("STRIPE_SECRET_KEY"),
      mode: set("STRIPE_SECRET_KEY") ? (stripeLivemode() ? "live" : "test") : null,
      webhookSecret: set("STRIPE_WEBHOOK_SECRET"),
      connectWebhookSecret: set("STRIPE_CONNECT_WEBHOOK_SECRET"),
      prices: { handyman: set(PRICE_NAMES.handyman), crew: set(PRICE_NAMES.crew), company: set(PRICE_NAMES.company) },
    },
    resend: { apiKey: set("RESEND_API_KEY"), from: set("EMAIL_FROM") },
    twilio: {
      accountSid: set("TWILIO_ACCOUNT_SID"),
      apiKeyPair: set("TWILIO_API_KEY_SID") && set("TWILIO_API_KEY_SECRET"),
      authToken: set("TWILIO_AUTH_TOKEN"),
      messagingService: set("TWILIO_MESSAGING_SERVICE_SID"),
      fromNumber: set("TWILIO_FROM_NUMBER"),
    },
    apns: { keyId: set("APNS_KEY_ID"), teamId: set("APNS_TEAM_ID"), keyP8: set("APNS_KEY_P8") },
    // The geocoder's own chain: the server key, else the older names it still falls back to.
    googleMaps: { serverKey: set("GOOGLE_MAPS_SERVER_KEY"), anyKey: Boolean(GOOGLE_KEY), browserKey: set("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY") },
    // Only the names the app reads (lib/supabase/server): a value under another name is not a key.
    supabase: { url: set("NEXT_PUBLIC_SUPABASE_URL"), serviceKey: set("SUPABASE_SERVICE_ROLE_KEY") },
    anthropic: { apiKey: set("ANTHROPIC_API_KEY"), liveCheck: "/api/ai-health?live=1" },
    cron: { secret: set("CRON_SECRET") },
  };
}

function failed(e: unknown): Probe {
  const o = (e ?? {}) as { statusCode?: number; status?: number; message?: string };
  const status = typeof o.statusCode === "number" ? o.statusCode : typeof o.status === "number" ? o.status : undefined;
  const message = e instanceof Error ? e.message : typeof o.message === "string" ? o.message : String(e ?? "");
  return { ok: false, ...(status ? { status } : {}), error: message.slice(0, 200) };
}

/** A read on a clock: resolves with the read, or rejects "timed out"; the timer never outlives it. */
async function clocked<T>(run: () => PromiseLike<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer); // never a timer left ticking after the answer is out
  }
}

/** One probe, boxed: its own catch and its own clock, and its error words scrubbed on the way out. */
async function boxed(run: () => Promise<Probe>, ms = PROBE_TIMEOUT_MS): Promise<Probe> {
  let out: Probe;
  try {
    out = await clocked(run, ms);
  } catch (e) {
    out = failed(e);
  }
  return out.error ? { ...out, error: scrubSecrets(out.error).slice(0, 200) } : out;
}

async function stripeProbe(): Promise<{ balance: Probe; prices: Record<keyof typeof PRICE_NAMES, Probe> }> {
  const tiers = Object.keys(PRICE_NAMES) as (keyof typeof PRICE_NAMES)[];
  const [balance, ...priceList] = await Promise.all([
    boxed(async () => {
      await getStripe().balance.retrieve({}, { timeout: PROBE_TIMEOUT_MS, maxNetworkRetries: 0 });
      return { ok: true };
    }),
    ...tiers.map((tier) => {
      const id = process.env[PRICE_NAMES[tier]];
      if (!id) return Promise.resolve<Probe>({ ok: false, error: `${PRICE_NAMES[tier]} is not set` });
      return boxed(async () => {
        const price = await getStripe().prices.retrieve(id, {}, { timeout: PROBE_TIMEOUT_MS, maxNetworkRetries: 0 });
        return price.active ? { ok: true } : { ok: false, error: "the price exists but is not active" };
      });
    }),
  ]);
  const prices = {} as Record<keyof typeof PRICE_NAMES, Probe>;
  tiers.forEach((tier, i) => { prices[tier] = priceList[i]; });
  return { balance, prices };
}

async function resendProbe(): Promise<Probe> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set" };
  return boxed(async () => {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => "");
    // A sending-only key cannot list domains and says so by name: it sends fine.
    if (text.includes("restricted_api_key")) return { ok: true, status: res.status, note: "a sending-only key: it can send, not list domains" };
    return { ok: false, status: res.status, error: `Resend ${res.status}: ${text}`.slice(0, 200) };
  });
}

async function mapsProbe(): Promise<Probe> {
  if (!GOOGLE_KEY) return { ok: false, error: "no Google Maps server key is set" };
  return boxed(async () => {
    // A fresh house number each look: the geocoder caches by address, and a cached answer would
    // stand in for a key that no longer works. Found or not found both mean Google took the key.
    const n = 100 + Math.floor(Math.random() * 9000);
    const r = await geocodeAddress(`${n} Amphitheatre Parkway, Mountain View, CA 94043`); // Google's own street: no company's place
    if (r.status === "ok" || r.status === "notfound") return { ok: true };
    if (r.status === "limited") return { ok: false, error: "the day's geocode fuse is spent" };
    return { ok: false, error: "Google did not answer ok (a bad key, the quota, or a timeout)" };
  });
}

async function supabaseProbe(): Promise<Probe> {
  return boxed(async () => {
    const { error } = await createServiceClient().from("organizations").select("id").limit(1);
    return error ? { ok: false, error: error.message ?? "read failed" } : { ok: true };
  });
}

type RefusalRow = { reason: string; count: number; firstSeen: string | null; lastSeen: string | null; status: string };
/**
 * THE WEBHOOK'S OWN REFUSAL ROWS, beside the key they belong to. The sink keeps one row per
 * reason (dedup by where::message) with a LIFETIME count and first/last seen, so this is read as
 * "last refused when", never as a count for a window.
 */
async function webhookRefusals(): Promise<{ rows: RefusalRow[]; lastSeen: string | null } | { error: string }> {
  try {
    const { data, error } = await clocked(async () =>
      await createServiceClient()
        .from("error_events")
        .select("title,event_count,first_seen,last_seen,status")
        .eq("culprit", "stripe:webhook:refused")
        .order("last_seen", { ascending: false })
        .limit(10),
    );
    if (error) return { error: scrubSecrets(error.message ?? "read failed").slice(0, 200) };
    const rows = ((data ?? []) as { title: string | null; event_count: number | null; first_seen: string | null; last_seen: string | null; status: string | null }[]).map(
      (r) => ({ reason: r.title ?? "", count: Number(r.event_count ?? 0), firstSeen: r.first_seen, lastSeen: r.last_seen, status: r.status ?? "new" }),
    );
    return { rows, lastSeen: rows[0]?.lastSeen ?? null };
  } catch (e) {
    return { error: scrubSecrets(failed(e).error ?? "read failed").slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const ctx = await requirePlatformAdmin();
  if ("error" in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.error === "Not signed in." ? 401 : 403 });
  }
  if (await rateLimited(`keys-health:${ctx.userId}`, 5, 600)) {
    return NextResponse.json({ error: "Too many key checks in a row — give it a few minutes." }, { status: 429 });
  }

  const live = req.nextUrl.searchParams.get("live") === "1";
  if (!live) {
    return NextResponse.json({ checkedAt: new Date().toISOString(), live, configured: configured(), webhookRefusals: await webhookRefusals() });
  }
  const [refusals, stripe, resend, twilio, googleMaps, supabase] = await Promise.all([
    webhookRefusals(),
    stripeProbe(),
    resendProbe(),
    boxed(() => twilioAccountCheck()),
    mapsProbe(),
    supabaseProbe(),
  ]);
  const apns = await boxed(async () => apnsSignCheck());
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    live,
    configured: configured(),
    webhookRefusals: refusals,
    probes: { stripe, resend, twilio, apns, googleMaps, supabase },
  });
}
